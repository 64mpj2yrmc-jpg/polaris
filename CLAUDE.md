# Polaris

A single-file trading journal + AI copilot for NQ/MNQ futures trading. Everything — markup, CSS,
and a full React app — lives in `index.html`. No build step, no package.json, no bundler. Open the
file in a browser (or serve it statically) and it runs.

## Stack & conventions

- React 18 + ReactDOM, loaded from cdnjs as `<script>` tags (UMD builds).
- Babel Standalone compiles the in-page `<script type="text/babel">` JSX at load time — there is no
  build/transpile step to run. To sanity-check a change compiles, run it through `@babel/standalone`
  with the `react` preset (see "Verifying changes" below); there is no linter or test suite.
- All application code is one giant `<script type="text/babel">` block: module-scope helpers/pure
  functions first, then a handful of presentational components (`Panel`, `Reactor`, `Backdrop`,
  `CandleChart`, `EquityCurve`, `PnlCalendar`, `BadgeBurst`, UI atoms), then the single `App()`
  component that owns essentially all state and is rendered at the bottom via
  `ReactDOM.createRoot(...).render(<App />)`.
- State pattern used throughout: every piece of state that's read inside an async callback, timer,
  or event listener (i.e. anywhere a stale closure would bite) has a matching `useRef` mirror kept in
  sync with `fooRef.current = foo` right after the `useState` call. Read the ref inside
  callbacks/timers, read the state directly in JSX.
- Persistence: a tiny `S` shim (`S.get(key)` / `S.set(key, value)`) wraps `localStorage` with an
  in-memory fallback if storage is blocked (e.g. Safari Private Browsing). Every persisted setting
  has a `save*` function that updates state + ref + calls `S.set`.
- Visual style: dark cyan/gold "command center" theme defined by the `C` color object, `mono` (IBM
  Plex Mono) and `disp` (Orbitron) font stacks, and the `Panel`/`Label` atoms. Match this exactly for
  any new UI — don't introduce new colors or fonts.
- `@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }` is a blanket rule
  in the `<style>` block — any new animation done via the CSS `animation` property is automatically
  covered; no manual reduced-motion handling needed.

## Build stamp — bump on every commit

`index.html` defines `const BUILD = "YYYY.MM.DD-N";` near the top of the constants block. **Every
commit that changes `index.html` must bump this value** to today's date, with `N` reset to `1` on a
new date and incremented for additional same-day commits (e.g. `2026.07.18-1` →
`2026.07.18-2` → `2026.07.19-1`). This is not optional — the in-app update check below fetches the
deployed copy and compares its `BUILD` against the running one, so a commit that forgets to bump it
will silently defeat that check for anyone still on the old copy. `BUILD` is displayed in the footer
line and at the top of the SETUP tab.

On mount, `App` fetches its own URL with `cache: "no-store"` and a cache-busting query param,
regexes out `BUILD` from the response, and compares it against the running `BUILD` with
`compareBuildStamps` (a small date+numeric-suffix comparator — not a plain string compare, so
`-10` correctly sorts after `-9`). If the fetched copy is newer, a persistent "UPDATE AVAILABLE —
TAP TO RELOAD" banner appears; tapping it calls `window.location.reload()`. The fetch is wrapped in
try/catch and fails silently (offline, `file://`, no deployed copy to compare against) — it's a
best-effort convenience, not a requirement for the app to function.

## Feature map

- **Trade journal** (LOG/JOURNAL/DESK/RISK tabs): manual entry, CSV/JSON export/import, P&L
  calendar, equity curve, badges. Pure functions `calcPnl`/`calcPoints`/`calcR`/`computeStats`.
- **Screenshot-to-journal**: `scanScreenshot` sends a resized image to Claude vision
  (`callAnthropic`) and parses trade candidates out of the JSON response.
- **Market scanner** (MARKET tab): `advanceScan` is a small state machine modeling
  sweep → change-in-state-of-delivery (CISD) → FVG retrace → rejection, fed candle-by-candle by
  `runScanner`. Data comes from Twelve Data (QQQ proxy, US hours) or a Yahoo Finance relay
  (`NQ=F`, delayed, 24hr) depending on `source`/`activeSource`. Scanner events are chimed and
  spoken (`emit` → `speak`) when live (not the initial silent backfill).
- **POLARIS chat** (POLARIS tab): `sendToPolaris` builds a system prompt from
  `buildSystemPrompt()` (journal stats, recent trades, market feed, scanner state, memory) and
  streams a reply from Claude — see "Streaming voice pipeline" below. Replies may end with a
  `<trade>{...}</trade>` block (voice-logged trades), parsed by `parseTradeBlock` and stripped
  from what's shown/spoken.
- **Long-term memory**: after each exchange, `updateMemory` asks Claude to fold the exchange into
  a running ≤300-word memory blob, stored via `saveMemory`, injected into every system prompt.
- **Rules engine ("the guardian")**: `DEFAULT_RULES` (max trades/day, max daily loss, cooldown
  after a loss). `breaches` (useMemo) computes active breaches; a paired `useEffect` speaks a
  stand-down warning once per breach per day.
- **Cross-device sync**: optional, off by default — syncs keys/journal/memory/chat/rules through a
  private GitHub Gist the user owns (`githubGistRequest`, `buildSyncBlob`/`applySyncBlob`).

## The four "living system" features (this session)

1. **Wake word ("Polaris")** — `earsOn` toggle (POLARIS tab + persisted). `startWakeLoop`/
   `stopWakeLoop` run a second, continuous `SpeechRecognition` instance (`wakeRecogRef`, separate
   from the tap-to-talk `recogRef`) that listens for "polaris" in final results. Gated by a single
   `useEffect([earsOn, appVisible, voiceState, speechSupported])` — since the loop only starts when
   `voiceState === "idle"`, it self-suppresses while Polaris is speaking/thinking or tap-to-talk is
   active with zero special-casing. Auto-restarts on `onend` with exponential backoff
   (`wakeBackoffRef`, 300ms→2s) for iOS's frequent session drops; on repeated/`not-allowed` errors it
   disables ears mode and shows a one-time notice. Manual tap-to-talk logic was extracted from
   `toggleListening` into `startListening()` so the wake word's "heard just the wake word, now
   capture the follow-up" path can reuse it verbatim.
2. **Streaming voice replies** — `streamAnthropicChat` adds `stream: true` and parses the SSE
   `content_block_delta` events off the fetch body reader (with `AbortController` support).
   `sendToPolaris` renders the reply into the transcript progressively (matched by a stable message
   `id`, not array index, so it's safe if a proactive message gets appended mid-stream) and uses
   `splitReadySentences` to dispatch complete sentences to a small TTS queue (`enqueueSentence` /
   `pumpTtsQueue`) as they arrive — ElevenLabs clips are prefetched the instant a sentence completes
   for gapless playback; device TTS utterances are queued the same way. `trimPotentialTagPrefix`
   prevents a forming `<trade` tag from ever flashing partially into the transcript. `stopSpeaking`
   is the single interrupt choke point (`haltAllSpeech`): aborts the stream, aborts every in-flight
   TTS fetch, clears the queue, cancels `speechSynthesis`/`Audio`.
3. **Proactive presence** — `speakProactive(text, {bypassCap})` is the gate: master
   `proactiveMode` toggle (SETUP tab, default on, persisted), 10-minute cooldown
   (`lastProactiveAtRef`) unless `bypassCap` (rule pre-warnings only). Events: NY session bells
   (`nyClock` helper, 9:30/15:00/16:00, once/day via `announcedBellsRef`), rule pre-warnings
   (`preWarnings` useMemo — one trade from max, within 20% of daily loss limit — always bypass the
   cap), scanner heartbeat (30 idle minutes with no scan event, tracked via `lastScanEventAtRef`/
   `scanStartAtRef`), and a configurable P&L milestone crossing (`pnlMilestone`, SETUP tab). All
   lines are pre-written with light phrasing variation — zero extra API calls.
4. **Reactive interface** — status bar (renders on every tab) gets a compact
   symbol/price/day% ticker, shown only when the feed has data. `Backdrop` takes a `dayPct` prop and
   layers one extra low-opacity green/red radial wash on top of the existing aurora blobs (a static
   gradient, not an animation). `Reactor` takes `seqPhase`/`flash` props: while `voiceState ===
   "idle"`, ring/pulse speed steps up through the scanner's sweep→cisd→retrace phases and flashes
   gold for 5s on a completed setup (`reactorFlash` state, set from the scanner's `emit` function);
   active voice states always take priority over scanner mood.

## Persisted localStorage keys

`nq-trades`, `polaris-voice`, `polaris-ears-on`, `polaris-anthropic-key`, `polaris-chat`,
`polaris-memory`, `polaris-rules`, `polaris-proactive-mode`, `polaris-pnl-threshold`,
`polaris-sync-token`, `polaris-sync-gistid`, `polaris-sync-enabled`, `polaris-elevenlabs`,
`polaris-tdkey`.

## External services (all called directly from the browser with user-supplied keys)

- Anthropic Messages API (chat, streaming; screenshot vision; memory updates; desk briefings) —
  model `claude-sonnet-4-6`.
- ElevenLabs TTS (optional alternate voice engine).
- Twelve Data (QQQ intraday/daily quotes).
- Yahoo Finance via a public CORS relay (`fetchViaRelay`, NQ=F futures, delayed).
- GitHub Gists API (optional cross-device sync, user's own PAT).

## Hosting & installable app (PWA)

The repo is no longer *only* `index.html` — three small files make it a hostable, installable app
without changing anything about how it runs (still 100% client-side, no server logic, keys still
live in the user's own browser):

- `manifest.json` — name/icons/`display: "standalone"` so the browser offers "Install app"; icons
  live in `icons/` (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, all rendered from the
  same north-star mark used by the favicon and the `Reactor` component).
- `sw.js` — a minimal service worker (network-first, falls back to cache offline) registered from a
  plain `<script>` tag at the bottom of `index.html`, right after the babel script. It's what makes
  the app installable and gives it a basic offline shell; it does not manage versioning — that's
  still the BUILD-stamp banner's job (see above). Keep the two mechanisms separate rather than
  layering the service worker's own update flow on top.
- `.nojekyll` — stops GitHub Pages from running its default Jekyll processing over the repo (mostly
  matters for any future folder starting with `_`; cheap insurance either way).

For GitHub Pages specifically: it serves whatever branch/folder is configured in
Settings → Pages → Build and deployment, and — important — **Pages sites are public even on private
repos** unless the repo is on a paid plan with private Pages support. `index.html` never embeds
secrets (API keys are entered per-visitor into their own `localStorage`), so public hosting is safe
by design, but this is still worth confirming with a human before enabling Pages on a repo they
haven't explicitly said should be public-facing.

## Verifying changes

There's no test suite or dev server. To check a change is syntactically valid before committing:

```bash
node -e "
const Babel = require('@babel/standalone'); // npm install --no-save @babel/standalone somewhere first
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const code = html.match(/<script type=\"text\/babel\"[^>]*>([\s\S]*?)<\/script>/)[1];
Babel.transform(code, { presets: ['react'] });
console.log('COMPILE OK');
"
```

For real verification, open `index.html` in a browser and exercise the actual feature — most of
this app's logic (voice, scanner, streaming, proactive timers) can't be caught by a syntax check
alone.

## Firebase backend (Pine Script alert webhook — Phase 1, not yet wired to the frontend)

The repo now also contains a small, separate Firebase backend whose only job is receiving
TradingView Pine Script alert webhooks (TradingView's servers fire these, so a client-side-only
app can't receive them — hence the exception to "no server logic" above). It does not affect how
`index.html` runs and nothing in it imports these files yet:

- `functions/index.js` — the `receiveAlert` HTTP function. Written against
  `@google-cloud/functions-framework` (not `firebase-functions`) — this got deployed via the Cloud
  Run console's "Write a function" flow rather than the Firebase CLI, and that flow's inline editor
  expects the plain Functions Framework registration style (`functions.http("receiveAlert", ...)`),
  not `firebase-functions/v2`'s `onRequest`/`defineSecret`. `WEBHOOK_SECRET` is read from
  `process.env.WEBHOOK_SECRET`, bound via a Secret Manager reference set in the Cloud Run console
  (service → Edit & deploy new revision → Container(s) → Variables & Secrets → Secrets), not
  `defineSecret`. Validates the payload and writes to the Firestore `alerts` collection via the
  Admin SDK either way. Also fires a best-effort SMS via Twilio's plain REST API (`sendSmsAlert`,
  called after the Firestore write succeeds, `fetch` + HTTP Basic Auth — no Twilio SDK dependency,
  Node's runtime has `fetch` built in) once a setup fires. Four env vars gate it, all-or-nothing:
  `TWILIO_ACCOUNT_SID`, `TWILIO_FROM_NUMBER`, `TWILIO_TO_NUMBER` are plain (non-secret) environment
  variables — only `TWILIO_AUTH_TOKEN` is an actual credential, so only it goes through the same
  Secret Manager reference dance as `WEBHOOK_SECRET`. Any of the four missing and it no-ops
  silently; a failed text is logged but never fails the webhook response — the alert is already
  safely stored in Firestore by that point.
- `firestore.rules` — deliberately does **not** allow unauthenticated client writes to `/alerts`,
  even though that was the original ask. The Cloud Function's Admin SDK write bypasses rules
  entirely, so it's already the real security boundary; opening Firestore itself to public writes
  would let anyone with the (necessarily public) client config skip the webhook's secret check.
  Reads require Firebase Auth. Two separate `allow update` rules (OR'd together, standard
  Firestore rules semantics) then narrowly scope what the signed-in dashboard client itself may
  write: one lets it flip `status` between `pending`/`traded`/`missed` and nothing else; a second
  lets Polaris's own AI review (see the ALERTS tab entry below) attach exactly once — it can only
  ever set `aiReviewed`/`aiVerdict`/`aiConfidence`/`aiNote`, gated by `resource.data.aiReviewed !=
  true` so it's write-once server-side, not just client-side dedupe. Neither rule can touch price/
  entry/stop/target fields, and neither can create or delete documents. **This file isn't
  auto-deployed** — same as the rest of this Firebase setup, publishing an edit here means pasting
  the updated rules into Firebase Console → Firestore Database → Rules → Publish by hand.
- `firebase.json`, `.firebaserc` (placeholder project ID), `firestore.indexes.json` — Firebase CLI
  scaffold, kept for reference/future use, but the actual live deployment was done by hand through
  the Cloud Run console (browser-only, no terminal), not `firebase deploy`. If a `functions/`
  deploy is ever redone via CLI, `index.js` would need converting back to `firebase-functions/v2`
  style — the two frameworks aren't interchangeable as-is.
- `firebaseConfig.js` — client SDK config, loaded as a plain global (`window.POLARIS_FIREBASE_CONFIG`)
  via a `<script src="firebaseConfig.js">` tag in `index.html`'s head, not an ES module import —
  the app has no bundler and everything else (React, Firebase itself) is loaded the same
  script-tag-global way. Ships with placeholder values; the ALERTS tab silently no-ops with a
  status message until real values are filled in.
- `DEPLOYMENT_STEPS.md` describes the CLI-based deploy path. The actual deployed service
  (`receive-alert` on Cloud Run, region set during setup) was created via Cloud Run console →
  Write a function → Node.js → inline editor, entry point `receiveAlert`.
- `pinescript/polaris-scanner.pine` — a Pine Script v6 port of the same sweep → CISD → FVG retrace
  → rejection model as the JS scanner (`advanceScan`/`findSwings`/`fvgAt` in `index.html`), meant
  to run on a live TradingView chart and fire the webhook on each completed setup. That core state
  machine is untouched; everything else on the chart is independent confluence markup layered on
  top, each with its own show/hide input: order blocks (last opposing candle before a
  displacement move ≥ `dispMult` × ATR(14), optionally filtered to only the standing bias's
  direction), every *significant* fair value gap on the chart (size-filtered by `minFvgSizeAtr` ×
  ATR(14), not just the one tied to an active sequence) flipped to gold "iFVG" styling once price
  closes back through it and deleted outright once price later reclaims the whole zone back the
  other way, equal highs/lows (liquidity pools — a `Swing.isPool` flag, set only when a new swing
  clusters with a prior one within `eqTolPct`%, is also what makes a swing sweep-eligible in the
  first place, so the scanner only reacts to genuine liquidity pools, not every minor pivot), a
  premium/discount zone shaded around the most recent swing high/low with a 50% equilibrium line
  (off by default), and Asia/London/NY AM/NY PM killzone session shading via
  `time(timeframe.period, session, "America/New_York")` (off by default; Asia's session string
  `"2000-0000"` wraps past midnight, which Pine's session matching supports natively). A
  `table.new` top-right HUD shows live standing bias / HTF bias / ADX regime / phase / setup
  direction / current session / scorecard. Colors match Polaris's own palette (cyan `#00D4FF`
  structure, gold `#F5C86B` attention/sweeps/iFVG, green `#2FE08A`/red `#FF5566` bull/bear)
  instead of Pine's stock colors.

  A built-in scorecard (`pendingDir`/`pendingEntry`/`pendingStop`/`pendingTarget` parallel arrays,
  `scoreWins`/`scoreLosses` tallies) records every setup that actually fires and resolves it the
  moment price trades through its stop or target — a wide bar that could have touched both in one
  candle counts as a loss, since intrabar order can't be known. Because Pine replays the whole
  script over all available chart history on every load, this is a genuine backtest of the current
  rule set from the moment the script is pasted in, not something that only accumulates going
  forward. Shown on the HUD as `SCORE: NN% (wins/total)`.

  Four filters gate whether a sweep is even allowed to start a new sequence: a `structureBias`
  state var (higher high/low → bullish, lower high/low → bearish, updated independently of the
  scanner every time a new swing forms) blocks counter-bias setups until structure actually
  breaks the other way; an HTF bias check (`request.security` pulling a higher timeframe's close
  vs. its own EMA, `lookahead_off` so it can't repaint) requires the higher timeframe to agree;
  a `ta.dmi()`-based ADX regime filter blocks new setups while the market's chopping below
  `adxThreshold`; and an optional `useSessionFilter` toggle (off by default) blocks new setups
  entirely outside the four killzones (`inAnyKillzone`), independent of whether the killzones are
  also being shaded visually. Pine's sandbox has no mechanism to call an LLM/API in real time —
  `alert()` is a one-way webhook fire, nothing reads a response back into the script — so these
  four (plus the liquidity-pool restriction above) are the extent of how "market-aware" the
  indicator itself can be. Deeper judgment from Polaris's actual Claude brain happens downstream
  instead, once an
  alert reaches the dashboard (see the ALERTS tab entry below).

  The single most recently completed setup's entry/stop/target plan (`drawTradePlan()`) is
  tracked via `var line`/`var label` refs, built by the pure `buildTradePlanDrawings()` and
  assigned at the call site (Pine functions can't reassign global variables — see the CE10088 note
  below); a top-level check clears it via `clearTradePlanDrawings()` once price actually trades
  through its stop or target, so a played-out entry doesn't linger looking live. Entry/stop/
  confidence are **not** part of the original JS model (which only annotates chart structure) —
  they're invented in this file specifically for the webhook payload: stop = the sweep candle's
  actual high/low (the real "protected" level — not just the older swing price it swept, which
  the wick may have already run past) ± an optional buffer; target = the nearest untested
  liquidity pool in the trade's direction (`findLiquidityTarget`/`computeTarget` — a real draw of
  liquidity, not an arbitrary ratio), falling back to entry ± risk × an R-multiple only when no
  pool exists yet; confidence = a simple FVG-size-vs-ATR(14) heuristic. A setup only actually
  fires its webhook if that projected move is at least `minTargetAtrMult` × ATR(14) — smaller
  draws still resolve the sequence, they just stay quiet. All adjustable via script inputs. Lives
  in TradingView's Pine Editor, not deployed through this repo — pasted in by hand, no compiler
  available to verify it here (a CE10088 "cannot modify global variable in function" error came up
  once already this way — Pine functions may read outer-scope variables but never reassign them;
  every `:=` to a `tp*`/`seq*` global has to live in top-level script code, not inside a `=>` def).

Phase 2 (dashboard integration) is now wired into `index.html`: the ALERTS tab (added to `tabs`)
signs in anonymously via Firebase Auth on mount and subscribes to the Firestore `alerts` collection
with `onSnapshot` (`tvAlerts`/`tvAlertsStatus` state, `firestoreDbRef`), rendering each alert as a
card (setup type, symbol/timeframe/timestamp, entry/stop/target/R:R/confidence, status badge) with
MARK TRADED/MARK MISSED buttons calling `setAlertStatus(id, status)`, which does a client-side
`update()` restricted by `firestore.rules` to the `status` field only. Requires a real
`firebaseConfig.js` (see above) and Anonymous auth enabled in Firebase Console → Build →
Authentication → Sign-in method — until both are done the tab shows a status message instead of
erroring.

A `useEffect([tvAlerts])` also watches the live alert list and, for every `pending` alert that
hasn't been AI-reviewed yet (`!a.aiReviewed`, deduped per-session via `aiReviewAttemptedRef` so a
snapshot re-fire can't double-trigger it), calls `reviewAlertWithPolaris(a)` — this is the one
place real Claude judgment attaches to the sweep/CISD/FVG pipeline, since the Pine indicator
itself has no way to call an LLM in real time (see `pinescript/polaris-scanner.pine`). It builds a
purpose-built prompt (`buildAlertReviewPrompt`, distinct from the conversational
`buildSystemPrompt`) from the alert's own fields plus whatever context is already on hand —
journal stats, live market feed, scanner state, memory — and asks for a strict JSON reply
(`{"verdict","confidence","note"}`, no markdown fences) via the existing non-streaming
`callAnthropic`. Never spoken, never appended to the chat transcript. On a parseable, valid
response it writes `aiReviewed`/`aiVerdict`/`aiConfidence`/`aiNote` back via a client-side
`update()` (the second `firestore.rules` clause above); any failure (missing key, network,
malformed JSON) is swallowed silently and the alert just stays unreviewed rather than blocking or
erroring the tab. Cards show a "Polaris is reviewing…" line while pending and a
favorable/caution/avoid badge + confidence + one-line note once reviewed.

**Live indicator status (between full setups).** The Pine scanner also fires a second, much
lighter webhook payload on every phase advance (sweep detected → CISD confirmed → retracing) —
`buildStatusMessage()`, discriminated from a full setup by `"kind":"status"` in the JSON body (a
full setup sends `"kind":"setup"`; `receiveAlert` branches on this, defaulting to `"setup"` if the
field is absent for backward compatibility with alerts fired before this existed). The Cloud
Function overwrites a single `scannerStatus/current` Firestore doc with it via `.set()` — no
history, no SMS, just whatever the indicator is currently tracking (standing bias, HTF bias,
regime/ADX, phase, direction). `firestore.rules` gates it read-only for signed-in clients, same
shape as `/alerts`.

`index.html` subscribes to that doc in the same Firebase `useEffect` that subscribes to `/alerts`
(`scannerStatus` state, `scannerStatusRef`), and it feeds into three places: a compact "LIVE
INDICATOR STATUS" strip at the top of the ALERTS tab (bias/HTF/regime/phase, mirroring the
indicator's own on-chart HUD); `buildSystemPrompt()`, so asking Polaris in chat what it's seeing
gets a real answer tied to the indicator's actual live state, not just the separate market-feed
candles; and a dedicated `useEffect([scannerStatus])` that calls `speakProactive()` with a
phase-specific line ("sweep just printed," "that sweep just confirmed," "retracing into the gap
now") the first time each phase is seen for a given symbol/direction (deduped via
`lastAnnouncedScanPhaseRef`, one key per `symbol:phase:dir` — a snapshot re-fire of the same
status doesn't re-announce it). This goes through the same shared 10-minute proactive cooldown as
every other proactive event, not a bypass, since it's informational rather than a rule warning —
so it can be genuinely mid-sequence rather than only ever speaking once a setup is already done.

## Git

Primary branch: `main`. This session's work landed on `claude/polaris-living-system-ahe5fl`
(one commit per feature above) and has been pushed but not yet merged to `main`.
