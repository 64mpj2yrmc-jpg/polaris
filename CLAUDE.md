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
  DESK also has a **Pattern insights** panel: `analyzePatterns` (gated behind ≥5 trades logged)
  sends `computeStats` plus a trimmed projection of the most recent 200 trades (with a
  client-computed `weekday` field, not left for the model to derive) to `callAnthropic` for a
  written, non-spoken readout — best/worst setups, day-of-week tendencies, tilt patterns surfaced
  in `notes` — persisted via `S` under `polaris-insights` so it survives a reload. Deliberately a
  direct one-shot call, not routed through `sendToPolaris`/`POLARIS_TOOLS`: this job already knows
  it needs the whole journal, so there's nothing for the tool-use loop to decide to look up, and
  routing through it would drag in the spoken-reply word cap and dump the result into the voice
  chat transcript, both wrong for a longer written report.
- **Screenshot-to-journal**: `scanScreenshot` sends a resized image to Claude vision
  (`callAnthropic`) and parses trade candidates out of the JSON response.
- **Market scanner** (MARKET tab): `advanceScan` is a small state machine modeling
  sweep → change-in-state-of-delivery (CISD) → FVG retrace → rejection, fed candle-by-candle by
  `runScanner`. Data comes from Twelve Data (QQQ proxy, US hours) or a Yahoo Finance relay
  (`NQ=F`, delayed, 24hr) depending on `source`/`activeSource`. Scanner events are chimed and
  spoken (`emit` → `speak`) when live (not the initial silent backfill).
- **POLARIS chat** (POLARIS tab): `sendToPolaris` builds a short `buildSystemPrompt()` snapshot
  (today/all-time journal stats, last price, scanner on/off, memory) and runs a bounded agentic
  tool-use loop against Claude — see "Tool-use (agentic chat)" below — streaming the reply as it
  goes, same pipeline as "Streaming voice pipeline" below. The old `<trade>{...}</trade>`
  tag/`parseTradeBlock` path still exists as a zero-cost fallback but Polaris is no longer told
  about it; `log_trade` is the real mechanism now.
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
   capture the follow-up" path can reuse it verbatim. `startListening()`'s own `rec.onerror` used to
   flash the same "check microphone permission" message for every recognition error regardless of
   `e.error` — misleading when the real cause was a `no-speech` timeout, a `network` hiccup, or no
   mic detected (`audio-capture`) rather than an actually denied permission. Now discriminates error
   codes the same way `startWakeLoop`'s own `onerror` already did, and stays silent on `aborted`
   (a user-initiated stop, not a real error). Separately, `rec.onend` with an empty `finalText` —
   recognition ending cleanly having heard nothing, which fires with no preceding `onerror` at all
   on some browsers (notably Safari) — used to drop silently back to idle with zero feedback,
   indistinguishable from a tap that did nothing; now flashes "Didn't catch anything — try again"
   so that case is no longer silent either.
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

## Tool-use (agentic chat)

Landen asked for Polaris to feel "more like" an agentic assistant — adaptive/reactive, deciding
what to look up rather than reasoning off one fixed context dump. `buildSystemPrompt()` used to
embed a large JSON dump (last 25 trades, last 20 candles, last 6 scan events, the full indicator
status paragraph) into every single message; it's now a short "QUICK SNAPSHOT" (today/all-time net
P&L + win rate + streak in one line, last price/day% in one line, scanner on/off in one line, plus
the memory blob, already short) so trivial questions don't force a tool round trip, and a short
paragraph tells the model tools exist for anything beyond that.

`POLARIS_TOOLS` (module scope, near `coerceTradeInput`) is the real Anthropic `tools` array — 3
read-only lookups (`get_journal_stats`, `get_recent_trades`, `get_market_snapshot`) plus 1 write
tool (`log_trade`), each with a JSON Schema `input_schema`. This used to also carry
`get_scanner_status`/`get_alerts`/`mark_alert_status`, wired to the TradingView alerts pipeline —
removed along with the rest of that pipeline, see "Discretionary pivot" below.
`coerceTradeInput(raw)` (module scope) holds the trade validation/coercion logic (instrument/
direction enums, `Number.isFinite` checks, contracts > 0, setup-enum-or-"Other", date
regex-or-today) shared by both `log_trade` and the legacy `<trade>` tag fallback in
`parseTradeBlock` — one validator, two entry points. `executeTool(name, input)` (component scope,
closes over the same refs `buildSystemPrompt` already reads —
`tradesRef`/`candlesRef`/`dayInfoRef`/`scanningRef`) dispatches each call defensively, returning
`{error}` instead of throwing so the model can adapt. `log_trade` updates `tradesRef.current`
synchronously (not just through `persist`'s `setTrades`, which drives a React re-render) before
`await persist(next)`, so a `get_recent_trades` call later in the *same* tool loop sees the trade
just logged.

Deliberately excluded from tool scope: anything that would let Polaris adjust the guardian rules
(`DEFAULT_RULES`/max trades/max loss/cooldown exist specifically to constrain Landen — letting the
model loosen them defeats the point). The app has no live order-execution capability anywhere, so
the worst case of any tool misuse is a wrong journal entry, trivially human-correctable.

`streamAnthropicChat` now accepts an optional `tools` array and handles the full Anthropic
streaming tool-use SSE sequence, not just bare text: `content_block_start` (type `"text"` or
`"tool_use"`, tracked by `index` since a turn can carry a text block followed by one-or-more
`tool_use` blocks), `content_block_delta` (`text_delta.text` streamed into `onDelta` exactly as
before, or `input_json_delta.partial_json` concatenated per-block-index and only `JSON.parse`d once
that block's `content_block_stop` arrives — parsing a partial fragment throws), and
`message_delta.delta.stop_reason` as the authoritative "is the model done or does it want to call a
tool" signal. Return contract changed from a plain string to `{content, stopReason, fullText}`
(`content` is an array of `{type:"text", text}` / `{type:"tool_use", id, name, input}` blocks) —
`sendToPolaris` is the only caller, so this is a contained breaking change.

`sendToPolaris` is a bounded agentic loop, `MAX_TOOL_ROUNDS = 4`: each round calls
`streamAnthropicChat` with the running `conversation` array and `tools: POLARIS_TOOLS` (omitted on
the forced final round to guarantee a text-only wrap-up rather than let the loop run away), streams
text into the **same** transcript bubble across rounds by accumulating `visibleAccum` (prior
rounds' finalized text) instead of resetting per round, and — when `stopReason === "tool_use"` —
runs every `tool_use` block in that response through `executeTool` **concurrently** (`Promise.all`,
per Anthropic's documented best practice for parallel tool calls), appends one assistant turn (the
raw content blocks) plus one user turn (all corresponding `tool_result` blocks, `is_error: true`
set when a result carries `{error}`) to `conversation`, and loops. `parseTradeBlock` now runs
exactly once, after the loop, on the fully-accumulated `visibleAccum` — the tag's trailing-anchor
regex is correct automatically since `visibleAccum` *is* the end of the reply by construction, no
extra scoping needed. With zero tool calls the loop behaves identically to the pre-tool-use
implementation (one round, immediate break, same final `<trade>`/fallback-message logic) — this is
a strict superset of the old control flow, not a rewrite of the non-tool path. One `AbortController`
is created once and reused across every round, so an interrupt between rounds makes the next
`streamAnthropicChat` call reject immediately with `AbortError`, caught by the same top-level
`catch` as always.

Write tools get a post-execution confirmation toast via `TOOL_RESULT_FLASH` (module scope, maps
tool name → a `flash()` message formatter); read tools don't, since they're near-instant local ref
reads that fire too often to toast without flickering.

## Persisted localStorage keys

`nq-trades`, `polaris-voice`, `polaris-ears-on`, `polaris-anthropic-key`, `polaris-chat`,
`polaris-memory`, `polaris-rules`, `polaris-proactive-mode`, `polaris-pnl-threshold`,
`polaris-sync-token`, `polaris-sync-gistid`, `polaris-sync-enabled`, `polaris-elevenlabs`,
`polaris-tdkey`, `polaris-insights`.

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

## Discretionary pivot — the Pine indicator is no longer a signal generator

For a stretch, `pinescript/polaris-scanner.pine` ran a full sweep → CISD → FVG-retrace → rejection
state machine (five entry triggers, computed stop/target/confidence, a win-rate scorecard) that
fired webhook alerts into a Firebase backend (`functions/index.js`'s `receiveAlert` Cloud Function),
which stored them in Firestore, triggered Twilio SMS/voice calls, and fed two dashboard tabs in
`index.html` (ALERTS, INDICATOR) with AI-reviewed verdicts, self-calibration against the live
market feed, and per-trigger-type performance breakdowns. All of that shipped, and all of it is now
gone.

After trading off those alerts for a while — and after a real debugging session that surfaced how
easy it was for the live TradingView alert to silently drift out of sync with whatever the script's
logic currently said (a `webhookSecret`-bearing alert freezes the script version/inputs at creation
time; editing or re-pasting the script never propagates to an alert that already exists) — the
conclusion was that discretion beats acting on auto-fired signals. Landen asked for the indicator to
go back to doing what the original JS scanner in `index.html` (`advanceScan`, unaffected by any of
this) was actually good at: marking liquidity, structure, and confluence, and leaving the entry
decision to the trader.

**What changed:**
- `pinescript/polaris-scanner.pine` was rewritten from scratch. It no longer tracks any sequence
  state, computes any entry/stop/target, scores confidence, keeps a scorecard, or calls `alert()` at
  all — it does not talk to any webhook or backend. What's left, all independently toggleable: swing
  detection + equal-highs/lows (liquidity pools), order blocks, every significant FVG (with iFVG
  flip-on-violation), a higher-timeframe FVG zone (now purely visual — nothing "consumes" it as a
  trigger anymore, so it stays drawn while price actually trades into it instead of vanishing the
  instant it's tapped), premium/discount + Fibonacci/equilibrium/OTE, killzone session shading +
  per-session average realized range, standing structure bias (chart-native or sourced from a
  dedicated direction timeframe), higher-timeframe bias, market regime/ADX (now purely
  informational — nothing gates on it), volume strength, SMT divergence, and a 1-minute
  rejection-candle read. All of it feeds one top-right status HUD. The old on-chart trade log table
  and W/L resolution markers are gone along with the scorecard they depended on.
- The entire Firebase/Firestore/Cloud-Function backend was deleted: `functions/`, `firebase.json`,
  `.firebaserc`, `firestore.indexes.json`, `firestore.rules`, `firebaseConfig.js`,
  `DEPLOYMENT_STEPS.md`. Nothing in the repo talks to Firebase anymore.
- `index.html` lost the ALERTS and INDICATOR tabs entirely, the Firebase `<script>` tags in `<head>`,
  all Firestore subscription/write code (`tvAlerts`, `scannerStatus`, `resolutions` state, the
  signed-in-anonymously `useEffect`, `setAlertStatus`, `applyAlertToJournal`,
  `reviewAlertWithPolaris`/`buildAlertReviewPrompt`, `resolveAlertOutcomes`, `verdictAccuracy`/
  `calibrationSummary`, `performanceByTrigger`/`performanceByConfidence`, and the module-scope
  helpers those leaned on — `setupTypeLabel`, `explainTradePlan`, `alertTriggerBucket`,
  `alertRealizedR`, `confidenceTier`). `POLARIS_TOOLS` dropped `get_scanner_status`, `get_alerts`,
  and `mark_alert_status` — down to 3 read tools + `log_trade`, see "Tool-use (agentic chat)" above.
  `buildSystemPrompt()`'s snapshot no longer mentions indicator phase or AI-review calibration,
  since neither exists anymore.
- The in-app MARKET tab scanner (`advanceScan`/`runScanner`, its own independent JS port of the same
  sweep/CISD/FVG model) is **unaffected** — it still chimes and speaks scan events exactly as
  before. This pivot only touched the TradingView Pine indicator and its dashboard integration.

**Liquidity draws (BSL/SSL).** Follow-up to the pivot above: Landen asked for the chart to mark
"levels of importance," specifically significant draws on liquidity — classic ICT buy-side/sell-side
liquidity, not just any equal-high/low match. `Swing` got its `touches` field back (how many swings
have clustered at that price zone, starting at 1 — dropped during the rewrite since the old
target-selection code that used it was gone, now needed again for this). `findLiquidityDraw(dir,
refPrice)` finds the nearest swing beyond `refPrice` with `touches >= minDrawTouches` (default 3) —
a level multiple swings have actually clustered at, not a bare first EQH/EQL match. Redrawn every
confirmed bar (`showLiquidityDraws`, default on), same delete-then-recreate pattern as premium/
discount: a bold gold dashed line + label reading "BSL {price}" for the nearest untested pool above
price, "SSL {price}" for the nearest below, visually distinct from the routine faint dotted EQH/EQL
match-lines. Also gets its own two-row HUD entry (BSL/SSL prices, `--` when none exists yet) —
`table.new`'s `rows` bumped 9→11 to fit.

## Git

Primary branch: `main`. This session's work landed on `claude/polaris-living-system-ahe5fl`
(one commit per feature above) and has been merged to `main` (fast-forward, no divergent commits).
