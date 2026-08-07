// Polaris — Pine Script Alert Webhook Receiver
// Receives TradingView Pine Script alert webhooks, validates the payload,
// and writes it to the Firestore "alerts" collection via the Admin SDK.
// The Admin SDK write bypasses Firestore Security Rules entirely -- this
// function IS the security boundary for writes, gated by WEBHOOK_SECRET.
// WEBHOOK_SECRET is bound as an env var via a Secret Manager reference:
// service -> Edit & deploy new revision -> Container(s) -> Variables &
// Secrets -> Secrets -> Reference a secret -> WEBHOOK_SECRET.
//
// Three payload shapes come in, discriminated by "kind" (defaults to "setup"
// if absent, for backward compatibility with alerts fired before this field
// existed):
//   kind:"setup"  (default) -- a fully completed setup. Expected body:
//     secret, setupType, entryPrice, stopPrice, targetPrice, confidence
//     required; riskReward, targetSource ("pool"|"fallback" -- lets the
//     dashboard explain, not just display, why the target sits where it
//     does), triggerType ("sweep"|"reversal"|"continuation"|"breakout"|
//     "htf_fvg" -- the real detector that started the sequence, since
//     setupType alone can't tell continuation and breakout apart), symbol,
//     timeframe, sourceTimestamp optional. Appended to the "alerts"
//     collection, one doc per setup, AI-reviewed on the dashboard, triggers
//     sendSmsAlert.
//   kind:"status" -- a lightweight phase-transition ping. Expected body:
//     secret, structureBias, htfBias, regime, adx, phase, dir, wins,
//     losses, symbol, timeframe. Overwrites the single "scannerStatus/
//     current" doc -- no history kept, no SMS -- so the dashboard/Polaris
//     always knows what the indicator is currently tracking (including its
//     live scorecard) between full setups.
//   kind:"resolution" -- fired from the Pine script's own scorecard the
//     moment a previously-pending tracked setup actually resolves (win or
//     loss) against price on the chart. Expected body: secret, dir
//     ("bull"|"bear"), setupType, outcome ("win"|"loss"), entryPrice,
//     stopPrice, targetPrice, r required; triggerType, targetSource,
//     symbol, timeframe, sourceTimestamp optional. Appended to the
//     "resolutions" collection, one doc per resolution -- this is what lets
//     the dashboard mirror the indicator's own backtest (the SCORE/EXP HUD)
//     as a real, growing history instead of only ever seeing alerts that
//     happened to reach a live webhook. No SMS/call -- this is bookkeeping,
//     not something worth waking up for.
//
// Also fires a best-effort SMS AND a best-effort voice call via Twilio's
// REST API once a "setup" alert is stored (see sendSmsAlert/sendVoiceCall
// below) -- no Twilio SDK dependency, just fetch, since Node 22's runtime
// has it built in. Both reuse the same four Twilio env vars/numbers; the
// call places to the same TWILIO_TO_NUMBER the text goes to. The call is
// the "wake me up" mechanism (deliberately doesn't read exact prices aloud
// -- TTS misreads decimals easily, and the SMS/app already have the exact
// numbers); the text is the written record. An optional QUIET_HOURS_START/
// QUIET_HOURS_END window (America/New_York, both required to enable) can
// suppress the call overnight without affecting the text or the Firestore
// write -- see isQuietHours.

const functions = require("@google-cloud/functions-framework");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Bound via Secret Manager reference (see comment above) — never hardcode this.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Only TWILIO_AUTH_TOKEN is a real credential, so only it goes through
// Secret Manager like WEBHOOK_SECRET above. The account SID and phone
// numbers aren't secrets on their own -- they're plain environment
// variables (Cloud Run console -> Variables & Secrets -> Environment
// variables, no Secret Manager entry needed). If any of the four are
// unset, sendSmsAlert no-ops entirely -- SMS is optional, not required for
// the webhook to function.
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const TWILIO_TO_NUMBER = process.env.TWILIO_TO_NUMBER;

// Optional overnight suppression window for sendVoiceCall only -- plain env
// vars (not secrets), 24hr "HH:MM" in America/New_York (matching the timezone
// convention the rest of this system already uses, e.g. the Pine script's
// killzone sessions). Both must be set and parseable to enable; either
// missing/malformed disables the window entirely, so the call always goes
// through by default until you deliberately configure this.
const QUIET_HOURS_START = process.env.QUIET_HOURS_START; // e.g. "22:00"
const QUIET_HOURS_END = process.env.QUIET_HOURS_END; // e.g. "07:00"

// Keep this list in sync with whatever setup labels your Pine Script emits.
// Rejecting unknown types catches typos/drift early instead of letting junk
// values pile up silently in Firestore.
const VALID_SETUP_TYPES = new Set([
  "CHoCH_UP",
  "CHoCH_DOWN",
  "BOS_UP",
  "BOS_DOWN",
  "LIQUIDITY_SWEEP_BUY",
  "LIQUIDITY_SWEEP_SELL",
  "FVG_RETEST_BULL",
  "FVG_RETEST_BEAR",
  "OTHER",
]);

// The real detector that started the sequence, distinct from setupType --
// setupType is constrained to the allow-list above (continuation and
// breakout both report BOS_*), so this rides along as a second, untranslated
// field letting the dashboard break performance out by all five real trigger
// types. Optional: alerts fired before this field existed still validate
// fine with it absent.
const VALID_TRIGGER_TYPES = new Set(["sweep", "reversal", "continuation", "breakout", "htf_fvg"]);

const VALID_DIRS = new Set(["bull", "bear"]);
const VALID_OUTCOMES = new Set(["win", "loss"]);

// Generous for this payload shape (a handful of numbers + short strings) —
// tight enough to reject anything that looks like abuse rather than a
// genuine alert.
const MAX_BODY_BYTES = 10 * 1024;

// Validates and coerces the incoming payload. Never throws -- every path
// returns a result object: { ok: true, data } or { ok: false, errors }.
function validateAlertPayload(body) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["Request body must be a JSON object"] };
  }

  const setupType = typeof body.setupType === "string" ? body.setupType.trim() : "";
  if (!setupType) {
    errors.push("setupType is required");
  } else if (!VALID_SETUP_TYPES.has(setupType)) {
    errors.push(`setupType must be one of: ${[...VALID_SETUP_TYPES].join(", ")}`);
  }

  const nums = {};
  for (const field of ["entryPrice", "stopPrice", "targetPrice"]) {
    const n = Number(body[field]);
    if (!Number.isFinite(n)) errors.push(`${field} must be a finite number`);
    else nums[field] = n;
  }

  const confidence = Number(body.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    errors.push("confidence must be a number between 0 and 100");
  }

  if (errors.length) return { ok: false, errors };

  // riskReward: trust a supplied value if it's a sane positive number,
  // otherwise derive it from entry/stop/target so the field is never blank.
  let riskReward = Number(body.riskReward);
  if (!Number.isFinite(riskReward) || riskReward <= 0) {
    const risk = Math.abs(nums.entryPrice - nums.stopPrice);
    const reward = Math.abs(nums.targetPrice - nums.entryPrice);
    riskReward = risk > 0 ? Number((reward / risk).toFixed(2)) : null;
  }

  // targetSource: "pool" (a real untested liquidity pool) or "fallback" (the
  // R-multiple projection, used only when no pool exists yet) -- optional so
  // older alerts fired before this field existed still validate fine.
  const targetSource = body.targetSource === "pool" || body.targetSource === "fallback" ? body.targetSource : null;

  // triggerType: optional, silently dropped to null if absent or unrecognized
  // rather than rejecting the whole alert over it -- it's informational
  // (dashboard performance breakdown), not load-bearing for anything else
  // the webhook does.
  const triggerType = typeof body.triggerType === "string" && VALID_TRIGGER_TYPES.has(body.triggerType) ? body.triggerType : null;

  return {
    ok: true,
    data: {
      setupType,
      triggerType,
      entryPrice: nums.entryPrice,
      stopPrice: nums.stopPrice,
      targetPrice: nums.targetPrice,
      confidence,
      riskReward,
      targetSource,
      symbol: typeof body.symbol === "string" ? body.symbol.slice(0, 32) : null,
      timeframe: typeof body.timeframe === "string" ? body.timeframe.slice(0, 16) : null,
      sourceTimestamp: typeof body.sourceTimestamp === "string" ? body.sourceTimestamp.slice(0, 64) : null,
    },
  };
}

// Validates a "resolution" ping -- strict like validateAlertPayload (this
// feeds the dashboard's real trade-history log and performance stats, not
// just a display value), sharing its setupType/targetSource/triggerType
// rules exactly.
function validateResolutionPayload(body) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["Request body must be a JSON object"] };
  }

  const dir = typeof body.dir === "string" ? body.dir.trim() : "";
  if (!VALID_DIRS.has(dir)) errors.push("dir must be one of: bull, bear");

  const outcome = typeof body.outcome === "string" ? body.outcome.trim() : "";
  if (!VALID_OUTCOMES.has(outcome)) errors.push("outcome must be one of: win, loss");

  const setupType = typeof body.setupType === "string" ? body.setupType.trim() : "";
  if (!setupType) {
    errors.push("setupType is required");
  } else if (!VALID_SETUP_TYPES.has(setupType)) {
    errors.push(`setupType must be one of: ${[...VALID_SETUP_TYPES].join(", ")}`);
  }

  const nums = {};
  for (const field of ["entryPrice", "stopPrice", "targetPrice", "r"]) {
    const n = Number(body[field]);
    if (!Number.isFinite(n)) errors.push(`${field} must be a finite number`);
    else nums[field] = n;
  }

  if (errors.length) return { ok: false, errors };

  const targetSource = body.targetSource === "pool" || body.targetSource === "fallback" ? body.targetSource : null;
  const triggerType = typeof body.triggerType === "string" && VALID_TRIGGER_TYPES.has(body.triggerType) ? body.triggerType : null;

  return {
    ok: true,
    data: {
      dir,
      outcome,
      setupType,
      triggerType,
      entryPrice: nums.entryPrice,
      stopPrice: nums.stopPrice,
      targetPrice: nums.targetPrice,
      r: nums.r,
      targetSource,
      symbol: typeof body.symbol === "string" ? body.symbol.slice(0, 32) : null,
      timeframe: typeof body.timeframe === "string" ? body.timeframe.slice(0, 16) : null,
      sourceTimestamp: typeof body.sourceTimestamp === "string" ? body.sourceTimestamp.slice(0, 64) : null,
    },
  };
}

// Validates a "status" ping. Deliberately permissive (this is a live
// display value, not something a security boundary needs to be strict
// about beyond basic types) -- every field is optional and just gets
// coerced to a bounded string/number or dropped.
function validateStatusPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["Request body must be a JSON object"] };
  }
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
  const adx = Number(body.adx);
  const wins = Number(body.wins);
  const losses = Number(body.losses);
  return {
    ok: true,
    data: {
      structureBias: str(body.structureBias, 16),
      htfBias: str(body.htfBias, 16),
      regime: str(body.regime, 16),
      adx: Number.isFinite(adx) ? adx : null,
      phase: str(body.phase, 16),
      dir: str(body.dir, 16),
      wins: Number.isFinite(wins) ? wins : null,
      losses: Number.isFinite(losses) ? losses : null,
      symbol: str(body.symbol, 32),
      timeframe: str(body.timeframe, 16),
    },
  };
}

// Best-effort text message -- never throws, never blocks or fails the
// webhook response. By the time this runs the alert is already safely
// stored in Firestore, so a failed text just means no phone buzz, not a
// lost alert.
async function sendSmsAlert(data) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !TWILIO_TO_NUMBER) return;
  try {
    const body = `Polaris: ${data.setupType} ${data.symbol || ""} ${data.timeframe || ""} — entry ${data.entryPrice}, stop ${data.stopPrice}, target ${data.targetPrice} (${data.confidence}%)`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const params = new URLSearchParams({ To: TWILIO_TO_NUMBER, From: TWILIO_FROM_NUMBER, Body: body });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("sendSmsAlert: Twilio request failed", res.status, errText);
    }
  } catch (err) {
    console.error("sendSmsAlert: failed to send", err);
  }
}

function parseHHMM(s) {
  const m = typeof s === "string" && s.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Checked only by sendVoiceCall -- the SMS and Firestore write are never
// gated by this. Wraps past midnight the same way the Pine script's Asia
// killzone session string does (e.g. start=22:00, end=07:00).
function isQuietHours() {
  const start = parseHHMM(QUIET_HOURS_START);
  const end = parseHHMM(QUIET_HOURS_END);
  if (start == null || end == null) return false; // not configured -- never quiet
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false, hour: "numeric", minute: "numeric",
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  const nowMin = hour * 60 + minute;
  return start <= end ? (nowMin >= start && nowMin < end) : (nowMin >= start || nowMin < end);
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

// Parallel, simplified version of index.html's own client-side
// setupTypeLabel() (not importable here -- separate runtime) for a spoken
// line. Falls back to a de-underscored, lowercased version of the raw code
// for anything not explicitly mapped, so a future setupType still reads as
// words instead of a code.
function setupTypeSpokenLabel(setupType) {
  const map = {
    CHoCH_UP: "a bullish change of character",
    CHoCH_DOWN: "a bearish change of character",
    BOS_UP: "a bullish break of structure",
    BOS_DOWN: "a bearish break of structure",
    LIQUIDITY_SWEEP_BUY: "a bullish liquidity sweep",
    LIQUIDITY_SWEEP_SELL: "a bearish liquidity sweep",
    FVG_RETEST_BULL: "a bullish fair value gap retest",
    FVG_RETEST_BEAR: "a bearish fair value gap retest",
  };
  return map[setupType] || String(setupType).replace(/_/g, " ").toLowerCase();
}

// Best-effort wake-up call -- never throws, never blocks or fails the webhook
// response. By the time this runs the alert is already safely stored in
// Firestore (and the text already fired), so a failed/skipped call never
// loses the alert. Deliberately doesn't read exact entry/stop/target prices
// aloud (easy to mishear over a phone call, and the SMS/app already have the
// exact numbers) -- this call's only job is to wake you and point you at
// them, so the line is short and said twice for clarity.
async function sendVoiceCall(data) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !TWILIO_TO_NUMBER) return;
  if (isQuietHours()) {
    console.log("sendVoiceCall: skipped — inside quiet hours");
    return;
  }
  try {
    const label = setupTypeSpokenLabel(data.setupType);
    const line = escapeXml(`Polaris alert. ${label} on ${data.symbol || "the chart"}, ${data.timeframe || ""} timeframe. Confidence ${data.confidence} percent. Check the app.`);
    const twiml = `<Response><Say voice="Polly.Matthew">${line}</Say><Pause length="1"/><Say voice="Polly.Matthew">Repeating. ${line}</Say></Response>`;
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const params = new URLSearchParams({ To: TWILIO_TO_NUMBER, From: TWILIO_FROM_NUMBER, Twiml: twiml });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("sendVoiceCall: Twilio request failed", res.status, errText);
    }
  } catch (err) {
    console.error("sendVoiceCall: failed to place call", err);
  }
}

functions.http("receiveAlert", async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed — use POST" });
    return;
  }

  const bodyBytes = Buffer.byteLength(JSON.stringify(req.body || {}));
  if (bodyBytes > MAX_BODY_BYTES) {
    res.status(413).json({ ok: false, error: "Payload too large" });
    return;
  }

  // Shared-secret auth. Pine Script webhooks can't set custom headers, so
  // the secret travels inside the JSON body instead of an Authorization
  // header — this is the standard pattern for TradingView webhooks.
  const providedSecret = req.body && req.body.secret;
  if (!WEBHOOK_SECRET || !providedSecret || providedSecret !== WEBHOOK_SECRET) {
    console.warn("receiveAlert: rejected — bad or missing secret");
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  const kind = req.body && req.body.kind === "status" ? "status" : req.body && req.body.kind === "resolution" ? "resolution" : "setup";

  if (kind === "resolution") {
    const result = validateResolutionPayload(req.body);
    if (!result.ok) {
      console.warn("receiveAlert: resolution validation failed", result.errors);
      res.status(400).json({ ok: false, error: "Invalid payload", details: result.errors });
      return;
    }
    try {
      const docRef = await db.collection("resolutions").add({
        ...result.data,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log("receiveAlert: stored resolution", docRef.id, result.data.setupType, result.data.outcome);
      res.status(201).json({ ok: true, id: docRef.id });
    } catch (err) {
      console.error("receiveAlert: resolutions write failed", err);
      res.status(500).json({ ok: false, error: "Internal error — could not store resolution" });
    }
    return;
  }

  if (kind === "status") {
    const result = validateStatusPayload(req.body);
    if (!result.ok) {
      console.warn("receiveAlert: status validation failed", result.errors);
      res.status(400).json({ ok: false, error: "Invalid payload", details: result.errors });
      return;
    }
    try {
      await db.collection("scannerStatus").doc("current").set({
        ...result.data,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error("receiveAlert: scannerStatus write failed", err);
      res.status(500).json({ ok: false, error: "Internal error — could not store status" });
    }
    return;
  }

  const result = validateAlertPayload(req.body);
  if (!result.ok) {
    console.warn("receiveAlert: validation failed", result.errors);
    res.status(400).json({ ok: false, error: "Invalid payload", details: result.errors });
    return;
  }

  try {
    const docRef = await db.collection("alerts").add({
      ...result.data,
      status: "pending",
      // server-authoritative — never trust a client/webhook-supplied clock
      // for ordering; sourceTimestamp above is kept as a passthrough only.
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log("receiveAlert: stored alert", docRef.id, result.data.setupType);
    await Promise.all([sendSmsAlert(result.data), sendVoiceCall(result.data)]);
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (err) {
    console.error("receiveAlert: Firestore write failed", err);
    res.status(500).json({ ok: false, error: "Internal error — could not store alert" });
  }
});
