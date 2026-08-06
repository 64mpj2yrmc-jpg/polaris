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

## Making Polaris feel more present (cosmetic pass)

Five additions layered on top of the `Reactor`/voice pipeline above, all driven by real state rather
than fixed timers wherever real data exists:

- **Audio-reactive Reactor** — a live 0-1 `audioLevel` (state `audioLevel` + mirror
  `audioLevelRef`) feeds a `level` prop into every `<Reactor>`. Three sources, all funneling into
  the same `setLevel()`: a second, independent `getUserMedia` stream analysed with a Web Audio
  `AnalyserNode` (`startMicLevelMeter`) while `voiceState === "listening"` — `SpeechRecognition`
  itself exposes no levels, hence the extra capture just for visualization; a real `AnalyserNode` on
  the ElevenLabs `<audio>` element while it's actually playing (`startElementLevelMeter`, wired into
  both `speakEleven` and the `pumpTtsQueue` eleven branch), routed back through to
  `ctx.destination` so this never changes what's actually heard; and, since device
  `speechSynthesis` exposes no waveform at all, a decaying spike on each `SpeechSynthesisUtterance`
  `onboundary` event (`startDeviceLevelDecay`) as a best-effort stand-in, honestly weaker than the
  two real analyser-driven paths. `stopLevelMeter()` is the single cleanup call (tears down the mic
  stream/AudioContext, zeroes the level) — wired into `haltAllSpeech`, every TTS `onended`/`onerror`,
  and the listening `rec.onend`/`onerror`. All three sources are wrapped in try/catch and just leave
  the level at 0 on failure (mic denied, no AudioContext, etc.) — additive, never load-bearing, since
  the Reactor already has its full state-driven fallback animation underneath.
- **Distinct thinking-state visual** — `voiceState === "thinking"` now also draws a ticking radar
  sweep line (`animation: spin 1s steps(9, end) infinite` — stepped, not smooth, deliberately reads
  as "searching" rather than just another spinning ring) so waiting on the Claude stream has its own
  visual signature instead of reusing a generic fast pulse.
- **Persistent mini-Reactor** — a small (`size={26}`) `<Reactor>` now sits in the status bar next
  to the POLARIS wordmark (renders on every tab, not just the POLARIS tab), wired to the same
  `voiceState`/`awake`/`seqPhase`/`flash`/`level` props as the main one so it's never out of sync,
  and its `onClick` is the same `toggleListening` — meaning tap-to-talk now works from any tab, not
  just POLARIS.
- **Chat transcript personality** — each transcript bubble now mounts with a one-shot `panelIn`
  entrance (keyed by array index, so it only plays once per genuinely new message, never replays on
  a streaming content update); Polaris's messages get a small north-star mark (the same path used in
  `Reactor`'s core, at `9x9`) next to the "POLARIS" label and a 2px cyan left accent on the bubble;
  and a `streamingMsgId` state (set when `sendToPolaris` creates the streaming placeholder, cleared
  once that stream finishes or aborts) drives a blinking `▌` caret appended to whichever bubble is
  still actively streaming in.
- **Proactive-speech visual tell** — `speakProactive()` now also fires a one-shot `proactiveTell`
  state (true for 1.2s, via `reactorRipple` — an outward-expanding, fading ring, `1.1s ease-out`,
  non-repeating) so a message Polaris initiates gets a visually distinct "I'm speaking up" beat,
  separate from `reactorFlash` (the scanner's own sustained speed/color change on a completed
  setup) and from the ordinary listening→thinking→speaking cycle when responding to you.

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
  Reads require Firebase Auth. Three separate `allow update` rules (OR'd together, standard
  Firestore rules semantics) then narrowly scope what the signed-in dashboard client itself may
  write: one lets it flip `status` between `pending`/`traded`/`missed` and nothing else; a second
  lets Polaris's own AI review (see the ALERTS tab entry below) attach exactly once — it can only
  ever set `aiReviewed`/`aiVerdict`/`aiConfidence`/`aiNote`, gated by `resource.data.aiReviewed !=
  true` so it's write-once server-side, not just client-side dedupe; a third lets the dashboard's
  self-calibration (see below) set `outcome` to `"win"`/`"loss"` exactly once, gated the same way
  via `resource.data.get('outcome', null) == null`. None of the three can touch price/entry/stop/
  target fields, and none can create or delete documents. **This file isn't auto-deployed** — same
  as the rest of this Firebase setup, publishing an edit here means pasting the updated rules into
  Firebase Console → Firestore Database → Rules → Publish by hand.
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

  Three filters gate whether a sweep is even allowed to start a new sequence: a `structureBias`
  state var (higher high/low → bullish, lower high/low → bearish, updated independently of the
  scanner every time a new swing forms) blocks counter-bias setups until structure actually
  breaks the other way; an HTF bias check (`request.security` pulling a higher timeframe's close
  vs. its own EMA, `lookahead_off` so it can't repaint) requires the higher timeframe to agree;
  and a `ta.dmi()`-based ADX regime filter blocks new setups while the market's chopping below
  `adxThreshold`. An optional `useSessionFilter` toggle (off by default) adds a fourth, blocking
  new setups entirely outside the four killzones (`inAnyKillzone`), independent of whether the
  killzones are also being shaded visually. Volume is deliberately NOT a gate — `useVolumeConfirm`
  (on by default) instead blends bar volume vs. its own `volAvgLen`-bar average into the
  confidence score via `setupConfidence()` (replaces the old `fvgConfidence()`, which only looked
  at FVG size vs. ATR), so every setup that resolves the sequence still fires and gets a webhook —
  volume just informs how strong that fired setup looks, shown on the HUD as a `VOL` reading
  (`≥1.2x avg` highlighted). Pine has no access to real bid/ask or DOM data, so this is bar volume
  vs. its own average, not true order flow — the closest proxy available in the sandbox. Pine's
  sandbox also has no mechanism to call an LLM/API in real time — `alert()` is a one-way webhook
  fire, nothing reads a response back into the script — so these filters (plus the liquidity-pool
  restriction above) are the extent of how "market-aware" the indicator itself can be. Deeper
  judgment from Polaris's actual Claude brain happens downstream instead, once an alert reaches
  the dashboard (see the ALERTS tab entry below).

  Separately from the session *filter*, a per-session volatility readout (`showSessionVolatility`,
  on by default) tracks a running average realized range (session high − low) for each of the
  four killzones — folded into that session's average the moment the session ends, not a signal
  gate at all, just an "how much does this session actually move" reference shown on the HUD next
  to whichever session is currently active (e.g. `NY AM · avg 38.25`).

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
  pool exists yet; confidence = a simple FVG-size-vs-ATR(14) heuristic. `computeTarget()` now
  returns a second value alongside the target price — whether it actually found a pool or fell
  back to the R-multiple — which `buildAlertMessage()` sends on as a `targetSource` field
  (`"pool"`/`"fallback"`) so the dashboard can explain the target, not just show it (see
  `explainTradePlan()` in the Phase 2 section below). A setup only actually fires its webhook if
  that projected move is at least `minTargetAtrMult` × ATR(14) — smaller draws still resolve the
  sequence, they just stay quiet. All adjustable via script inputs. Lives
  in TradingView's Pine Editor, not deployed through this repo — pasted in by hand, no compiler
  available to verify it here (a CE10088 "cannot modify global variable in function" error came up
  once already this way — Pine functions may read outer-scope variables but never reassign them;
  every `:=` to a `tp*`/`seq*` global has to live in top-level script code, not inside a `=>` def).

  **V2 rework (multi-phase, in progress).** The user is chasing five known problems with the
  indicator: signal contradiction (opposite-direction alerts minutes apart), coverage gaps (sweep
  is the only entry trigger), a stop that a single wick can take out with no recovery buffer, a
  generic R-multiple target as the fallback, and (already addressed — see above) a lack of
  on-chart trade-plan markup. V2 Phase 1 was pure refactor, no new behavior: the inline
  `bearAllowed`/`bullAllowed` sweep search became `detectSweep(dir)`, a pure function returning
  `[found, level, extreme, cisdTarget]` (same read-only-function-plus-top-level-assignment split as
  `buildTradePlanDrawings`), gated by a new `shouldFireSetup(setupType, dir)` master function.
  `detectReversal`/`detectContinuation`/`detectBreakout` are still stubs (`[false, float(na),
  float(na), float(na)]`) — coverage gaps are the one problem not yet started; new entry triggers
  beyond a liquidity sweep are later-phase work. `grpVisualsV2`'s `lineExtension` (replaces the
  trade-plan lines' hardcoded 15-bar length) and `showConfidence` (toggles the `%` in the setup
  label's text) have been live since Phase 1, since they're pure, safe generalizations of existing
  hardcoded values; `showTradePlan` and `showTpLadder` are still declared-but-inert, waiting on a
  later phase that splits trade-plan visibility from `showVisuals` and adds multiple TP levels.

  **V2 Phase 2** (not to be confused with the unrelated "Phase 2 (dashboard integration)" below —
  that one shipped earlier and is a separate track in `index.html`) wired the rest of the gates
  Phase 1 only declared, plus added wick-tolerant stops: `shouldFireSetup()` now also checks
  `raiseAdxThreshold`/`raisedAdxThreshold` (a stricter optional ADX floor), `useVolFloor`/
  `volFloorMult` (minimum volume ratio), `minBarRangeAtr` (rejects a dead/illiquid confirmation
  bar), and — this is the actual fix for the contradiction problem — `useContradictionFilter`/
  `minBarsAfterSetup` against two new persisted globals, `lastSetupDir`/`lastSetupBar`, updated
  only when a setup actually fires a webhook (a quiet sequence completion below
  `minTargetAtrMult`/`minSeqFvgSizeAtr` never counts, so it can't block a later opposite signal).
  `minSeqFvgSizeAtr` (rejects a too-small confirming FVG) is checked separately at the 4 completion
  sites instead of in `shouldFireSetup()`, since it depends on that specific sequence's own FVG,
  not something visible at the sweep-detection stage. New `grpSL` group (`useWickTolerance`/
  `wickToleranceAtr`) widens the stop beyond the sweep's actual wick by an ATR-scaled buffer at all
  4 completion sites — deliberately just a wider stop distance, not a "grace period before counting
  a touched stop as hit," since real broker stop orders fill on touch regardless of what the chart
  does next; pretending otherwise would misrepresent real risk. Every new gate defaults to a value
  that roughly reproduces prior behavior (`raiseAdxThreshold`/`useVolFloor` off, `minBarRangeAtr`/
  `minSeqFvgSizeAtr` low/zero) so this phase doesn't quietly starve signal flow — they have to be
  turned up deliberately to actually tighten things.

  **V2 Phase 3** filled in the last declared-but-inert pieces from Phase 1. `detectReversal(dir)`
  now fires on the single most recent swing (index 0), wicked through and closed back on the other
  side, WITHOUT requiring it to be pool-eligible the way `detectSweep()` does — this is the actual
  coverage-gap fix, since sweep only ever fires on liquidity pools. `detectContinuation(dir)` fires
  on a fresh displacement candle (reusing the existing `isDisplacement` check, moved earlier in the
  file so these functions can see it) in the direction `structureBias` already agrees with — a
  with-trend pullback trigger, unlike sweep/reversal which require structure to actually break.
  `detectBreakout(dir)` fires on a displacement candle closing decisively beyond the widest tracked
  swing on that side. All three reuse `cisdTargetBear()`/`cisdTargetBull()` as-is (generic
  "find where the last opposite-colored run started" helpers, never sweep-specific) and return the
  same `[found, level, extreme, cisdTarget]` shape `detectSweep()` always did — the main scan block
  now tries all four triggers in order (sweep → reversal → continuation → breakout) per direction,
  each independently gated by its `allowX` toggle, so with only `allowSweep` on by default nothing
  changes until the others are opted in. Whichever detector actually fires is tracked in a new
  `seqTriggerType` global and mapped to a real webhook `setupType` by `setupTypeForTrigger()` —
  sweep → `LIQUIDITY_SWEEP_*`, reversal → `CHoCH_*`, continuation/breakout → `BOS_*` (no separate
  breakout slot in `functions/index.js`'s `VALID_SETUP_TYPES`, so it shares BOS with continuation) —
  finally giving those setup-type codes real meaning instead of every alert always reporting
  `CHoCH_*` regardless of what triggered it. These three are the author's own reasonable-but-
  invented interpretation of the ICT concepts, not something ported from the original JS model the
  way sweep is — worth treating with more scrutiny via the scorecard before trusting.

  New `grpSMT` group adds SMT (Smart Money Technique) divergence: `smtPh`/`smtPl` pull pivot
  highs/lows from a correlated symbol (`smtSymbol`, default the E-mini S&P) via `request.security`
  at the identical pivot cadence as the indicator's own `ph`/`pl`, so a confirmed pivot on one lines
  up bar-for-bar with a confirmed pivot on the other — no separate swing-tracking state needed for
  the second symbol. Bearish divergence (`smtBearDiv`) is set the moment our own price makes a
  higher high that the correlated symbol fails to confirm; bullish (`smtBullDiv`) mirrors it at
  lows. Captured once, at whichever trigger starts a sequence (`seqSmtAligned`), not re-read later,
  so a fast-moving correlated symbol can't retroactively change a reading mid-sequence.
  `setupConfidence()` now averages whichever sub-scores are active — FVG size (always), volume (if
  `useVolumeConfirm`), SMT alignment (if `useSmtConfluence`, both default on) — instead of the old
  fixed two-score blend; informational only, exactly like volume, never a gate.

  `showTradePlan` is now actually independent of `showVisuals` (previously declared but wired to
  just mirror it) — `showVisuals` still controls the sweep/CISD-in-progress markup (the "⚡ SWEEP"
  label family and the tracked level line), `showTradePlan` now separately controls the completed
  entry/stop/target trade-plan markup. `showTpLadder` draws two extra dotted lines, TP1/TP2, at
  50%/75% of the distance from entry to the final target — purely visual, computed inside
  `buildTradePlanDrawings()` and cleaned up by the same `clearTradePlanDrawings()` as everything
  else; the webhook payload, scorecard, and `targetP` itself are untouched and still resolve
  against the one real target regardless of whether the ladder is shown.

  **V2 Phase 4** adds a genuine minimum-move floor and a top-down multi-timeframe framework,
  prompted by a real 4-point NQ alert on the 5m chart — `minTargetAtrMult` alone is ATR-relative,
  and a quiet-market ATR compression can satisfy "3x ATR" on a handful of points alone.
  `minTargetPts` is a new, unconditional floor in raw instrument points, ANDed with the existing
  ATR check at all 4 completion sites so neither gate alone can let a too-small move through.
  Separately, four layers now run top-down instead of everything happening on one timeframe: 1H
  **bias** (`useHtfBias`/`htfTimeframe`, unchanged — HTF close vs its own EMA, gates counter-bias
  setups); 15m **direction** (new `grpDirection`/`useMtfDirection`/`directionTimeframe` —
  `structureBias` itself gets re-sourced from a dedicated timeframe's pivots, `dirPh`/`dirPl` via
  `request.security` compared against `dirPrevHigh`/`dirPrevLow` the same pattern SMT already uses
  for its own pivot pair, instead of the chart's own 5m swings; off reverts to exactly the old
  chart-native behavior; this is a gate, same as bias always was, since `shouldFireSetup()`'s
  `biasOk` check is unchanged — it just now reads a `structureBias` sourced from 15m); 5m **state**
  (unchanged — the sweep/CISD/retrace sequence tracker still runs on whatever timeframe the chart
  itself is on); and 1m **entries** (new `grpM1`/`useM1Confirmation` — the most recently confirmed
  1-minute candle's OHLC via `request.security`, reduced to a simple long-wick rejection read
  `m1RejectionBear`/`m1RejectionBull` and folded into `setupConfidence()` as one more sub-score,
  deliberately informational only and never a gate, since stacking a fourth mandatory confluence
  layer on top of bias/direction/state risked strangling an already-infrequent signal further). All
  three `request.security` pulls run unconditionally every bar regardless of their toggles, same
  CW10003 reasoning as the pre-existing `htfClose`/`htfEma`/SMT pulls. The HUD's old "BIAS" row now
  doubles as the direction row (relabeled "DIR 15m" when `useMtfDirection` is on, since
  `structureBias` *is* the direction reading at that point — showing it twice would just be the
  same value under two labels) and gained an "M1" row alongside the existing "SMT" row.

  **V2 Phase 5** is a bug-fix/audit pass, prompted by a user-reported mismatch between a live alert
  and the chart's redrawn trade plan (traced to Pine's own behavior — pasting an updated script
  recalculates ALL chart history under the new rules, so an already-fired alert from an older script
  version won't necessarily match what the chart redraws for that same historical stretch; not a
  bug, just something to expect after every paste) plus a direct ask to audit for anything else
  wrong. Three real fixes landed:
  1. Stale settings-panel labels: `allowReversal`/`allowContinuation`/`allowBreakout` said "(not yet
     implemented)" — leftover text from V2 Phase 1, when they genuinely were stubs. They've been
     real, working detectors since Phase 3; relabeled to explain why they still default off (this
     author's own ICT interpretation, not ported from the JS model like sweep — not because they
     don't work).
  2. `minRiskReward` (new, `grpTrade`, default 1.5, 0 disables): `riskReward` was already computed
     and reported in the webhook payload, but nothing actually gated on it — a setup could clear
     both `minTargetAtrMult`/`minTargetPts` on the reward side while still carrying a
     disproportionately wide stop. Checked via `riskPts`/`rewardPts`/`rrOk` locals at all 4
     completion sites, ANDed with the existing size checks.
  3. Liquidity-pool significance: `Swing` gained a `touches` field (how many swings have clustered
     at that price zone, starting at 1) instead of just a bare `isPool` boolean — prompted by the
     target on a real alert not looking like an important level. Sweep-eligibility
     (`detectSweep`/`detectReversal`, still reading `s.isPool`) is unchanged, still fires on the
     first match. But `findLiquidityTarget()` (the real `TARGET`) now requires `s.touches >=
     minPoolTouches` (new, `grpEQ`, default 2 — reproduces prior behavior; raise for more
     established levels only). The TP1/TP2 ladder also stopped being arbitrary 50%/75% splits of
     the distance to target — new `findLiquidityLevels()` draws the nearest one or two REAL
     liquidity pools (same `minPoolTouches` filter) actually sitting between entry and target,
     drawing fewer than two lines rather than fabricating a percentage-based one if that's all that
     exists in range.

Phase 2 (dashboard integration) is now wired into `index.html`: the ALERTS tab (added to `tabs`)
signs in anonymously via Firebase Auth on mount and subscribes to the Firestore `alerts` collection
with `onSnapshot` (`tvAlerts`/`tvAlertsStatus` state, `firestoreDbRef`), rendering each alert as a
card (setup type, symbol/timeframe/timestamp, entry/stop/target/R:R/confidence, status badge) with
MARK TRADED/MARK MISSED buttons calling `setAlertStatus(id, status)`, which does a client-side
`update()` restricted by `firestore.rules` to the `status` field only. Two pure module-scope
helpers make each card self-explanatory instead of just a row of numbers: `setupTypeLabel(setupType)`
translates the Pine indicator's alert codes (`CHoCH_UP`/`CHoCH_DOWN` today; `BOS_*`,
`LIQUIDITY_SWEEP_*`, `FVG_RETEST_*` mapped in ready for when V2's other setup types ship) into a
plain-English headline, and `explainTradePlan(a)` renders a short deterministic paragraph on why
entry/stop/target sit where they do — entry on the FVG retrace close, stop beyond the sweep's
actual wick, and target either "the nearest untested liquidity pool" or "a projected risk multiple"
depending on the alert's `targetSource` field (`"pool"` vs `"fallback"`, added to the Pine webhook
payload by `computeTarget()`/`buildAlertMessage()` — see the pinescript section below). This is
mechanical fact from the indicator's own rule, not an LLM guess, so it's accurate and free even
before or without an AI review. MARK TRADED also calls
`applyAlertToJournal(a)`, which pre-fills the LOG tab's order ticket (`form`) from the alert's own
fields — instrument (inferred from `symbol`), direction (inferred from `setupType`), entry/stop/tp,
a `notes` line summarizing the alert (setup type, indicator confidence, Polaris's AI verdict if
reviewed) — and switches to the LOG tab, reusing the same `scanMissingFields`/`scanMessage`
review-banner mechanism the screenshot-scan flow uses (`applyScanCandidate`) to gold-highlight the
one field it can't know yet: `exit`, since the trade hasn't closed when the alert fires. The trader
fills that in and hits Log Trade themselves — `addTrade` already refuses to save without it, so
there was never a path to fully auto-logging a still-open trade. Requires a real
`firebaseConfig.js` (see above) and Anonymous auth enabled in Firebase Console → Build →
Authentication → Sign-in method — until both are done the tab shows a status message instead of
erroring.

A `useEffect([tvAlerts])` also watches the live alert list and, for every `pending` alert that
hasn't been AI-reviewed yet (`!a.aiReviewed`, deduped per-session via `aiReviewAttemptedRef` so a
snapshot re-fire can't double-trigger it), calls `reviewAlertWithPolaris(a)` — this is the one
place real Claude judgment attaches to the sweep/CISD/FVG pipeline, since the Pine indicator
itself has no way to call an LLM in real time (see `pinescript/polaris-scanner.pine`). It builds a
purpose-built prompt (`buildAlertReviewPrompt`, distinct from the conversational
`buildSystemPrompt`) from the alert's own fields (including `explainTradePlan(a)`'s mechanical
entry/stop/target explanation and the indicator's live scorecard win rate, both described above)
plus whatever context is already on hand — journal stats, live market feed, scanner state,
memory — and asks for a strict JSON reply
(`{"verdict","confidence","note"}`, no markdown fences) via the existing non-streaming
`callAnthropic`. Silent and tab-only for `favorable`/`caution` verdicts — never spoken, never
appended to the chat transcript. An `avoid` verdict is the one exception: right after the Firestore
write succeeds, it also calls `speakProactive()` with the setup and the AI's own note, bypassing
the shared 10-minute proactive cooldown (same bypass rule pre-warnings use) so a heads-up on a
setup Polaris would skip doesn't get silently eaten by the cap — `aiReviewAttemptedRef` already
caps the whole review to once per alert, so no separate dedupe is needed for the speech itself. On
a parseable, valid response it writes `aiReviewed`/`aiVerdict`/`aiConfidence`/`aiNote` back via a
client-side `update()` (the second `firestore.rules` clause above); any failure (missing key,
network, malformed JSON) is swallowed silently and the alert just stays unreviewed rather than
blocking or erroring the tab. Cards show a "Polaris is reviewing…" line while pending and a
favorable/caution/avoid badge + confidence + one-line note once reviewed.

**Self-calibration.** A separate `useEffect([candles, tvAlerts])` calls `resolveAlertOutcomes()`,
which resolves each alert's real `outcome` (`"win"`/`"loss"`) against the live market feed's own
candles (`candlesRef`), using the identical conservative tie-break the Pine indicator's own
scorecard uses (both stop and target touched on the same bar counts as a loss, since intrabar
order isn't knowable) — first candle after the alert's timestamp that touches either level
resolves it. This only advances while the MARKET tab's feed is running, and only as accurately as
that feed's instrument/timeframe approximates the alert's own (the same QQQ/NQ-proxy relationship
the rest of the app already leans on) — an approximation, not a guarantee, deliberately kept
separate from the trade journal (no `trades[]` tagging involved at all) so it works purely off
alert data regardless of whether the trader ever took the trade. Written back via a third
client-side `update()` clause in `firestore.rules`, write-once the same way the AI-review clause
is (`resource.data.get('outcome', null) == null`). `outcomeAttemptedRef` dedupes in-flight writes
per alert id the same way `aiReviewAttemptedRef` does for reviews. Once alerts carry both
`aiVerdict` and `outcome`, `verdictAccuracy` (a `useMemo` over `tvAlerts`) buckets resolved,
AI-reviewed alerts by verdict and tallies win/loss per bucket, and `calibrationSummary()` renders
it as a short string (e.g. `"favorable 71% (5/7), avoid 25% (1/4)"`, omitting any bucket with
`n=0`) — this is genuine self-calibration: does an `avoid` call actually lose more than a
`favorable` one? It's fed into both `buildAlertReviewPrompt()` (so future reviews are informed by
Polaris's own track record, not judged in a vacuum) and `buildSystemPrompt()` (so asking "are you
actually any good at this" in chat gets a real, sample-size-aware answer), shown on the ALERTS tab
as a "◆ POLARIS CALIBRATION" panel (hidden until at least one bucket has data), and each alert
card gets a WON/LOST badge next to its status badge once resolved.

**Live indicator status (between full setups).** The Pine scanner also fires a second, much
lighter webhook payload on every phase advance (sweep detected → CISD confirmed → retracing) —
`buildStatusMessage()`, discriminated from a full setup by `"kind":"status"` in the JSON body (a
full setup sends `"kind":"setup"`; `receiveAlert` branches on this, defaulting to `"setup"` if the
field is absent for backward compatibility with alerts fired before this existed). The Cloud
Function overwrites a single `scannerStatus/current` Firestore doc with it via `.set()` — no
history, no SMS, just whatever the indicator is currently tracking (standing bias, HTF bias,
regime/ADX, phase, direction, and now `wins`/`losses` — the indicator's own scorecard tally rides
along on every ping, not just when a setup completes, so the dashboard's win-rate reading stays
current mid-sequence). `firestore.rules` gates it read-only for signed-in clients, same shape as
`/alerts`.

`index.html` subscribes to that doc in the same Firebase `useEffect` that subscribes to `/alerts`
(`scannerStatus` state, `scannerStatusRef`), and it feeds into three places: a compact "LIVE
INDICATOR STATUS" strip at the top of the ALERTS tab (bias/HTF/regime/phase, plus a `Score` cell
once `wins + losses > 0`, mirroring the indicator's own on-chart HUD); `buildSystemPrompt()`, so
asking Polaris in chat what it's seeing — including its actual win rate — gets a real answer tied
to the indicator's live state, not just the separate market-feed candles; and a dedicated
`useEffect([scannerStatus])` that calls `speakProactive()` with a phase-specific line ("sweep just
printed," "that sweep just confirmed," "retracing into the gap now") the first time each phase is
seen for a given symbol/direction (deduped via
`lastAnnouncedScanPhaseRef`, one key per `symbol:phase:dir` — a snapshot re-fire of the same
status doesn't re-announce it). This goes through the same shared 10-minute proactive cooldown as
every other proactive event, not a bypass, since it's informational rather than a rule warning —
so it can be genuinely mid-sequence rather than only ever speaking once a setup is already done.

## Git

Primary branch: `main`. This session's work landed on `claude/polaris-living-system-ahe5fl`
(one commit per feature above) and has been pushed but not yet merged to `main`.
