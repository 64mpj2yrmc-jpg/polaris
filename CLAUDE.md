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

## Git

Primary branch: `main`. This session's work landed on `claude/polaris-living-system-ahe5fl`
(one commit per feature above) and has been pushed but not yet merged to `main`.
