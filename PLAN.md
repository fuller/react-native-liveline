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

**Nothing has run on a device/simulator yet.** All verification so far is
typecheck + lint + unit tests.

## Remaining work

### Phase 7 — Runtime verification, release
1. Run example on iOS simulator (`node .yarn/releases/yarn-4.11.0.cjs example ios`
   — Expo; may need `npx expo prebuild`/dev-client since Skia+Reanimated are
   native). Use the `agent-device` skill to drive/screenshot each screen.
2. Verify against the runtime-assumption checklist below; fix what breaks.
3. Compare visuals side-by-side with the web demo (`dev/` via vite in source clone).
4. npm publish (bob config already set); drop "not runtime-verified" caveat
   from CHANGELOG once verified.

### Runtime assumptions to verify on first launch (most likely breakage points)
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
