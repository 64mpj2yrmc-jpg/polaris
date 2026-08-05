// Polaris — Pine Script Alert Webhook Receiver
// Receives TradingView Pine Script alert webhooks, validates the payload,
// and writes it to the Firestore "alerts" collection via the Admin SDK.
// The Admin SDK write bypasses Firestore Security Rules entirely -- this
// function IS the security boundary for writes, gated by WEBHOOK_SECRET.
// WEBHOOK_SECRET is bound as an env var via a Secret Manager reference:
// service -> Edit & deploy new revision -> Container(s) -> Variables &
// Secrets -> Secrets -> Reference a secret -> WEBHOOK_SECRET.
//
// Two payload shapes come in, discriminated by "kind" (defaults to "setup"
// if absent, for backward compatibility with alerts fired before this field
// existed):
//   kind:"setup"  (default) -- a fully completed setup. Expected body:
//     secret, setupType, entryPrice, stopPrice, targetPrice, confidence
//     required; riskReward, targetSource ("pool"|"fallback" -- lets the
//     dashboard explain, not just display, why the target sits where it
//     does), symbol, timeframe, sourceTimestamp optional. Appended to the
//     "alerts" collection, one doc per setup, AI-reviewed on the dashboard,
//     triggers sendSmsAlert.
//   kind:"status" -- a lightweight phase-transition ping. Expected body:
//     secret, structureBias, htfBias, regime, adx, phase, dir, wins,
//     losses, symbol, timeframe. Overwrites the single "scannerStatus/
//     current" doc -- no history kept, no SMS -- so the dashboard/Polaris
//     always knows what the indicator is currently tracking (including its
//     live scorecard) between full setups.
//
// Also fires a best-effort SMS via Twilio's REST API once a "setup" alert
// is stored (see sendSmsAlert below) -- no Twilio SDK dependency, just
// fetch, since Node 22's runtime has it built in.

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

  return {
    ok: true,
    data: {
      setupType,
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

  const kind = req.body && req.body.kind === "status" ? "status" : "setup";

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
    await sendSmsAlert(result.data);
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (err) {
    console.error("receiveAlert: Firestore write failed", err);
    res.status(500).json({ ok: false, error: "Internal error — could not store alert" });
  }
});
