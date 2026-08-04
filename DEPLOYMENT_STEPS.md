# Deploying the Polaris alert webhook (Phase 1)

This covers getting `functions/receiveAlert` live and receiving TradingView Pine Script alerts
into Firestore. It does not touch `index.html` — the existing client-side Polaris app is
unaffected until Phase 2 wires the dashboard up to read `/alerts`.

## 0. Prerequisites

- A Google account.
- Node.js 20+ and npm installed wherever you run these commands.
- `firebase-tools` CLI: `npm install -g firebase-tools`

## 1. Create the Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. Name it (e.g. `polaris-trading`), finish the wizard (Google Analytics is optional, skip it).
3. In the project, go to **Build → Firestore Database → Create database**. Start in
   **production mode** (the rules in this repo lock it down properly — you don't need "test
   mode"). Pick a region close to you; it can't be changed later.
4. Cloud Functions requires the project to be on the **Blaze (pay-as-you-go)** plan — you'll be
   prompted to upgrade when you deploy functions. The free tier quota is generous (2M
   invocations/month); a personal webhook receiver will not meaningfully cost anything, but a
   billing account is required to attach.

## 2. Log in and point the CLI at your project

From the repo root:

```bash
firebase login
```

Edit `.firebaserc` and replace `REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID` with your actual project
ID (found in Firebase Console → Project settings → General → "Project ID").

## 3. Set the webhook secret

This is the shared secret TradingView's alert JSON must include for `receiveAlert` to accept it.
Generate a long random one — e.g.:

```bash
openssl rand -hex 32
```

Then store it in Secret Manager (never commit this value anywhere):

```bash
firebase functions:secrets:set WEBHOOK_SECRET
# paste the generated value when prompted
```

## 4. Install function dependencies

```bash
cd functions
npm install
cd ..
```

## 5. Deploy

Deploy the Firestore rules/indexes and the function together:

```bash
firebase deploy --only firestore,functions
```

First deploy takes a few minutes (function cold build). Note the HTTPS URL it prints, e.g.:

```
Function URL (receiveAlert(us-central1)): https://us-central1-polaris-trading.cloudfunctions.net/receiveAlert
```

That's your webhook URL.

## 6. Configure the TradingView alert

In your Pine Script alert dialog:

- **Webhook URL**: the Function URL from step 5.
- **Message** (JSON body — TradingView placeholders like `{{close}}` are substituted before
  sending):

```json
{
  "secret": "YOUR_WEBHOOK_SECRET",
  "setupType": "CHoCH_UP",
  "entryPrice": {{close}},
  "stopPrice": {{plot("stop")}},
  "targetPrice": {{plot("target")}},
  "confidence": 78,
  "symbol": "{{ticker}}",
  "timeframe": "{{interval}}",
  "sourceTimestamp": "{{time}}"
}
```

Adjust the `{{plot(...)}}` calls to whatever your indicator actually exposes — the point is the
JSON keys must match what `functions/index.js` validates (`setupType`, `entryPrice`, `stopPrice`,
`targetPrice`, `confidence` are required; `riskReward`, `symbol`, `timeframe`, `sourceTimestamp`
are optional). Valid `setupType` values are listed at the top of `functions/index.js` in
`VALID_SETUP_TYPES` — edit that set if your Pine Script uses different labels.

Note: webhook alerts on TradingView require at least an **Essential** (or higher) TradingView
plan — free plan alerts can't call external URLs.

## 7. Test it before trusting TradingView to fire correctly

```bash
curl -X POST "https://us-central1-YOUR_PROJECT.cloudfunctions.net/receiveAlert" \
  -H "Content-Type: application/json" \
  -d '{
    "secret": "YOUR_WEBHOOK_SECRET",
    "setupType": "CHoCH_UP",
    "entryPrice": 18452.25,
    "stopPrice": 18430.00,
    "targetPrice": 18510.00,
    "confidence": 78,
    "symbol": "NQ1!",
    "timeframe": "5"
  }'
```

Expect `{"ok":true,"id":"<some id>"}` back. Then check Firebase Console → Firestore Database —
you should see a new document in an `alerts` collection with `status: "pending"` and a server
`timestamp`.

Try it once with a wrong secret too — expect `401 {"ok":false,"error":"Unauthorized"}` — and once
with a missing field — expect `400` with a `details` array explaining what's wrong.

## 8. Watch logs

```bash
firebase functions:log --only receiveAlert
```

or Firebase Console → Functions → `receiveAlert` → Logs. Rejected/invalid requests are logged at
`warn`, Firestore failures at `error`, successful writes at `info`.

## What this does *not* do yet (Phase 2)

- The Polaris dashboard (`index.html`) doesn't read `/alerts` yet — `firebaseConfig.js` is
  scaffolding for that, not wired in.
- No UI for marking an alert `traded`/`missed` yet (the security rules already allow it once
  built — `allow update` on `status` only).
- No Firebase Auth flow in the frontend yet (Anonymous Auth is the recommended fit — no login UI
  needed for a single-user app; call `signInAnonymously()` once on load).

Ask for Phase 2 when you're ready and I'll wire the dashboard up to this.
