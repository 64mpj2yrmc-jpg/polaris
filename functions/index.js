// Polaris — Pine Script Alert Webhook Receiver
// Receives TradingView Pine Script alert webhooks, validates the payload,
// and writes it to the Firestore "alerts" collection via the Admin SDK.
// The Admin SDK write bypasses Firestore Security Rules entirely -- this
// function IS the security boundary for writes, gated by WEBHOOK_SECRET.
// WEBHOOK_SECRET is bound as an env var via a Secret Manager reference:
// service -> Edit & deploy new revision -> Container(s) -> Variables &
// Secrets -> Secrets -> Reference a secret -> WEBHOOK_SECRET.
//
// Expected Pine Script alert JSON body (set as the alert "Message" in
// TradingView -- {{close}}, {{time}}, etc. get substituted before sending):
//   secret, setupType, entryPrice, stopPrice, targetPrice, confidence
//   required; riskReward, symbol, timeframe, sourceTimestamp optional.

const functions = require("@google-cloud/functions-framework");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Bound via Secret Manager reference (see comment above) — never hardcode this.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

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

  return {
    ok: true,
    data: {
      setupType,
      entryPrice: nums.entryPrice,
      stopPrice: nums.stopPrice,
      targetPrice: nums.targetPrice,
      confidence,
      riskReward,
      symbol: typeof body.symbol === "string" ? body.symbol.slice(0, 32) : null,
      timeframe: typeof body.timeframe === "string" ? body.timeframe.slice(0, 16) : null,
      sourceTimestamp: typeof body.sourceTimestamp === "string" ? body.sourceTimestamp.slice(0, 64) : null,
    },
  };
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
    res.status(201).json({ ok: true, id: docRef.id });
  } catch (err) {
    console.error("receiveAlert: Firestore write failed", err);
    res.status(500).json({ ok: false, error: "Internal error — could not store alert" });
  }
});
