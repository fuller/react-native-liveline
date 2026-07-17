# react-native-liveline — Port Plan & Progress

**Read this first when resuming work.** This repo is a React Native port of
[benjitaylor/liveline](https://github.com/benjitaylor/liveline) (real-time
animated charts: line, multi-series, candlestick; 60fps) keeping the same SDK
shape. Full original plan: `~/.claude/plans/i-want-to-create-staged-locket.md`
(this file supersedes it for status).

## Key locations & commands

- **This repo:** `~/dev/react-native-liveline`
- **Web source being ported:** clone it if missing:
  `git clone --depth 1 https://github.com/benjitaylor/liveline /tmp/liveline-src`
  (a clone may still exist at
  `/private/tmp/claude-501/-Users-andrewfuller-dev/0bb98ac3-8fd4-4805-a43f-0acc8f49fbb6/scratchpad/liveline`)
- **Commands** (yarn 4 is vendored; there is NO global yarn):
  `node .yarn/releases/yarn-4.11.0.cjs <typecheck|lint|test>` from repo root.
  Example app: `node .yarn/releases/yarn-4.11.0.cjs example ios` (or `start`).
- Commit as `Andrew Fuller <andrew_fuller@outlook.com>` with
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- GitHub: repo not pushed yet; `gh` token is invalid (`gh auth login` needed
  before creating github.com/fuller/react-native-liveline).

## Architecture decisions (locked in, don't relitigate)

1. **UI-thread worklet engine.** `useLivelineEngine` runs the per-frame engine
   step in a Reanimated `useFrameCallback` worklet, records an `SkPicture` via
   `Skia.PictureRecorder`, and displays it with `<Canvas><Picture/></Canvas>`.
   Chart survives a blocked JS thread (this is the whole point).
2. **Canvas2D shim** (`src/draw/canvas2d.ts`): a worklet-safe adapter exposing
   the exact CanvasRenderingContext2D subset the web draw code uses, over
   SkCanvas. The ~1,700 lines of draw code were ported nearly verbatim against
   it — do NOT rewrite draw modules in Skia idioms; fidelity > elegance.
3. **Fonts**: CSS font strings → `LivelineFonts` bundle of SkFonts
   (`ctx.fonts.label|value|badge|crosshair|orderbook|empty|refLabel|seriesLabel`),
   defaults from `matchFont` (Menlo/monospace) in `src/draw/fonts.ts`.
4. **Badge** is drawn in-canvas (`src/engine/badge.ts`) from the same
   `badgeSvgPath` string via `Skia.Path.MakeFromSVGString` (web used a DOM/SVG
   overlay).
5. **Engine state** is a mutable object (with Maps) created lazily on the UI
   thread, held in a shared value the JS thread never reads
   (`src/engine/state.ts`).
6. **Config** is mirrored props → shared value every commit
   (`cfg.value = {...}` in an unconditional `useEffect`), same contract as the
   web `configRef`. `hiddenSeriesIds` is a string[] (not Set) for shareability.
7. **SDK deltas from web:** `formatValue`/`formatTime` must be worklets
   (defaults are); `style` is ViewStyle; `className`/`cursor` dropped; new
   optional `fonts` prop; scrub = touch-drag via gesture-handler Pan;
   `showValue` renders an animated TextInput (ReText pattern).

## Porting conventions

- `'worklet';` first statement of every function called from the frame worklet.
- tsconfig has `noUncheckedIndexedAccess` → use `arr[i]!`; `noUnusedLocals/Parameters` → `_param`.
- Prettier/eslint from scaffold; run `lint --fix` after writing; keep upstream
  comments/constants verbatim.
- Web engine refs map to `s.<field>` on `EngineState` (names match:
  `displayValueRef` → `s.displayValue`, etc.).

## Status — done (all committed, typecheck/lint/tests green)

| Phase | Content | State |
|---|---|---|
| 0 | Scaffold: create-react-native-library (JS-only, bob), Expo example, peer+dev deps (@shopify/react-native-skia 2.4.18, reanimated 4.2.1, gesture-handler 2.30), jest | ✅ |
| 1 | `src/math/*`, `src/types.ts`, `src/theme.ts` + 31 jest tests | ✅ |
| 2 | Canvas2D shim, fonts, all draw modules incl. candlestick, particles, orderbook; `drawFrame`/`drawMultiFrame`/`drawCandleFrame` | ✅ |
| 3 | Engine: `src/engine/{constants,types,helpers,candleHelpers,state,step,badge}.ts` — line + multi + candle pipelines, loading/empty/reveal, pause time-debt, window transitions, hover/scrub; `src/useLivelineEngine.ts` (frame callback, Pan gesture, AppState, reduced motion, onHover runOnJS) | ✅ |
| 4 | `src/Liveline.tsx` (controls, sliding indicators, Skia mini-icons, ReText value), `src/LivelineTransition.tsx`, `src/index.tsx` exports | ✅ |
| 5 | Multi-series + candles + orderbook + degen particles — all ported as part of phases 2–4 | ✅ (code-complete, unverified at runtime) |
| 6 | Example app demo screens (`example/src/`): tabbed sections — basic line, crypto, dashboard, candlestick, multi-series, orderbook; theme+accent switcher; "Block JS 2s" stress button | ✅ |
| 7a | README (prop tables verified against src/types.ts, RN deltas, fonts examples) + CHANGELOG 0.1.0 | ✅ |
| 7b | Runtime verification on iOS sim (iPhone 17 Pro): all 6 sections work; JS-block stress test PASSED 3× (chart animates through blocked JS); no memory leak (RSS flat over 3 min, no picture dispose needed); ReText/showValue, worklet font metrics, PictureRecorder-in-worklet all confirmed. Fixes: 555df6e, 672ce2c, 7c6a717 | ✅ |

**Intentional divergences from the web demos (Phase 6/7 fidelity pass, deliberate — not gaps):**
- `CryptoSection` and `OrderbookSection` are RN-only additions: crypto follows
  the README "Crypto-style" recipe (`degen`, `valueMomentumColor`, `showValue`),
  not a port of any web `dev/*.tsx` demo — there is no crypto/orderbook demo
  upstream to port.
- `DashboardSection` is the PLAN-specified RN-only screen (windows + no badge);
  it does not map to a web demo either. The web's *actual* size-variant
  galleries (`dev/main.tsx` lines 285–326, `dev/demo.tsx` lines 386–429) now
  live where they belong: inside `BasicLineSection` and `CandlestickSection`
  respectively, alongside each section's main chart.
- `CandlestickSection`'s control panel deliberately fixes an upstream demo bug:
  web `dev/demo.tsx`'s Window section always renders `TIME_WINDOWS` buttons
  regardless of preset, so in crypto mode it shows 10s/30s/1m/5m labels that
  don't match the 300/900/3600s values actually driving the chart. Our panel
  switches to `CRYPTO_WINDOWS` buttons in crypto preset instead; the in-chart
  window pills still match web exactly (crypto-only, via the chart's `windows`
  prop, no `onWindowChange` on the chart).
- Global accent context (`useAppTheme().accent`, picker in `App.tsx`) replaces
  the web demos' fixed per-demo colors for the non-crypto sections; crypto
  preset keeps the fixed `#f7931a` (bitcoin-orange) color as upstream does.

### iOS dev loop (verified working — use these)
- One-time: `example/package.json` needs `react-native-worklets` (Reanimated 4 peer,
  supplies the worklet babel plugin); `CI=1 npx expo prebuild --platform ios` from example/.
- Build: `RCT_METRO_PORT=8082 npx expo run:ios --port 8082 --device <UDID>` (~15 min).
- **Port 8081 is off-limits** (often occupied by ~/dev/predict Metro; a foreign bundler
  causes "Cannot find native module" redboxes). Use 8082:
  `npx expo start --dev-client --port 8082` (background) and pin the app once via
  `xcrun simctl spawn booted defaults write liveline.example RCT_jsLocation "localhost:8082"`.
- Reload after src changes: `xcrun simctl terminate booted liveline.example && xcrun simctl launch booted liveline.example`.
- Automation: agent-device for snapshot/press only; launch via simctl; screenshots via
  `xcrun simctl io booted screenshot`. agent-device synthetic drags do NOT reach RNGH
  Pan gestures on this sim — scrub needs a manual finger check.
- **Worklet gotcha (bit us twice):** module-scope helpers/consts referenced by a worklet
  factory must be declared ABOVE the factory, else they're captured as `undefined` at
  module eval (555df6e, 672ce2c). Whole src/ scanned clean as of 7c6a717.

**Nothing has run on a device/simulator yet.** All verification so far is
typecheck + lint + unit tests.

## Remaining work

### Phase 7 — remaining
1. ~~Visual parity pass~~ ✅ 2026-07-17: full structural match across all areas,
   both themes. All four open items (window-pill windows[0] init, 120×80
   window-pill crowding, orderbook light-theme fade, LogBox banner) adjudicated
   as verbatim-upstream behavior / dev-only chrome — no code changes needed.
   Pairs saved as parity-*-{web,sim}.png in phase7-screenshots/.
2. **Manual (user):** finger-scrub a chart to confirm crosshair lands under
   the finger (RNGH Pan can't be automated on this sim; forced-hover injection
   verified the full crosshair draw path already).
3. **Release (user-gated):** `gh auth login` (token invalid), push repo,
   npm publish (bob config ready). CHANGELOG caveat already updated to
   verified status.

### Runtime assumptions — ALL VERIFIED on sim 2026-07-17 (kept for reference)
Scrub e.x container-relative: verified by API contract + forced-hover draw-path
test only; needs one manual finger check. Stale-fonts and published-package
Metro transform: consumer-side, deferred as planned.
- `Skia.PictureRecorder()` usable inside a Reanimated worklet; `<Picture>`
  accepting a `SharedValue<SkPicture>` that's reassigned every frame.
- `font.measureText().width` + `getMetrics()` in worklets; `matchFont` weights
  on Android (`monospace` + fontWeight '500'/'600' may need fallback).
- Old-picture disposal: if memory climbs, call `.dispose()` on the previous
  picture after replacing it.
- `useFrameCallback` closure captures `fonts` (memoized) — if fonts prop
  changes at runtime the callback may hold stale fonts; acceptable v1.
- Gesture `e.x` is container-relative (matches web offset math).
- Animated `text` prop on TextInput (ReText pattern) under new architecture.
- Published-package consumers: Metro babel-transforms node_modules, so shipped
  `'worklet'` directives get processed (same as victory-native). Verify once.

### Deferred / nice-to-have (post-v0.1)
- Perf: avoid re-serializing full `data` array into the config shared value on
  every tick (append-only path or ring buffer) if profiling shows cost.
- Paint/path object pooling in the shim if GC pressure shows up.
- `activateAfterLongPress` option for scrub inside ScrollViews.
- CI runs on GitHub once repo is pushed (workflows already scaffolded).

## Task list mapping (session task tool)
#1–#5 phases 0–4 complete; #6 = remaining candle/orderbook runtime polish
(effectively folded into #7/#8); #7 = example app; #8 = docs/verify/release.
