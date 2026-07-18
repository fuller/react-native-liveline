# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- **Peer dependency ranges tightened**: `react-native-reanimated` now requires
  `>=4.0.0` (was `>=3.16.0`, which was never actually verified — this library
  has only ever been built and tested against 4.2.1). Reanimated 4 split its
  worklets runtime into a separate `react-native-worklets` package, which is
  now declared as a required peer dependency (`>=0.3.0`, matching what
  Reanimated 4 itself requires) — previously undeclared, which meant a
  fresh install on Reanimated 4 could silently break the same way our own
  example app build did before we added it there.
- **`react-native-gesture-handler` bumped to `>=3.0.0`** (was `>=2.16.0`).
  Gesture-handler 3.x renamed what `ComposedGesture` refers to (it now means
  the new v3 declarative gesture model) and exposes the old builder API's
  composed-gesture type under `LegacyComposedGesture` instead — this library
  still uses the classic `Gesture.Pan().onBegin/.onUpdate/.onFinalize()`
  builder API unchanged (deprecated in 3.x but not removed), just with the
  corrected type import. No gesture logic changed. A migration to the new
  hook-based `usePanGesture()` API is deferred to a future release.
- `@shopify/react-native-skia` peer range is unchanged (`>=2.0.0`) —
  verified accurate as-is against its own published peerDependencies.

## [0.1.0] - 2026-07-17

Initial release: a React Native port of
[liveline](https://github.com/benjitaylor/liveline) with the same SDK shape,
rendered on the UI thread via Reanimated + Skia.

### Added

- **UI-thread worklet engine** (`useLivelineEngine`) — the per-frame render
  step runs inside a Reanimated `useFrameCallback` worklet, recording an
  `SkPicture` displayed via `<Canvas><Picture /></Canvas>`. The chart keeps
  animating even when the JS thread is blocked.
- **Canvas2D shim** (`src/draw/canvas2d.ts`) — a worklet-safe adapter exposing
  the `CanvasRenderingContext2D` subset the original web draw code uses, over
  `SkCanvas`, so the draw modules could be ported near-verbatim.
- **Line chart pipeline** — data/value streaming, grid, badge (in-canvas via
  `Skia.Path.MakeFromSVGString`), momentum dot/glow/arrows, fill gradient,
  pulsing live dot, reference line, loading (breathing line) and empty
  states, pause/resume with time-debt catch-up.
- **Multi-series pipeline** (`series` prop) — overlapping lines with
  per-series palettes, endpoint labels, built-in toggle chips, dynamic
  Y-axis range as series are hidden/shown.
- **Candlestick pipeline** (`mode="candle"`) — OHLC bodies/wicks, live candle
  updates, and line/candle morph (`lineMode`) with density-matched tick data.
- **Orderbook overlay** (`orderbook` prop) — bid/ask depth stream rendering.
- **Degen mode** (`degen` prop) — burst particles + chart shake on momentum
  swings.
- **Crosshair scrubbing** — touch-drag via a `react-native-gesture-handler`
  `Pan` gesture, with `onHover` dispatched back to the JS thread.
- **Live value overlay** (`showValue`) — animated `TextInput` driven from the
  UI thread (ReText pattern), with optional momentum coloring.
- **`fonts` prop** (`LivelineFonts`) — overridable Skia fonts (label, value,
  badge, crosshair, orderbook, empty, reference-label, series-label), with
  platform-monospace defaults built via `matchFont`.
- **`LivelineTransition`** — cross-fade wrapper for switching between chart
  variants (e.g. line ↔ candlestick).
- Time window buttons (`windows`/`onWindowChange`) and mode toggle
  (`onModeChange`) with animated sliding indicators, in `default`, `rounded`,
  and `text` styles.
- Full TypeScript types (`LivelineProps`, `LivelineSeries`, `CandlePoint`,
  `LivelineFonts`, `OrderbookData`, `DegenOptions`, etc.) and unit tests for
  the math/theme/engine layers.

### React Native SDK deltas from the web version

- `formatValue` / `formatTime` must be worklets (defaults already are).
- `style` is a `ViewStyle`, not `CSSProperties`; `className` and `cursor` are
  dropped (no native equivalent).
- New optional `fonts` prop with no web counterpart.
- `scrub` is touch-drag instead of mouse hover.

### Verification

- Runtime-verified on the iOS simulator and an Android emulator (Pixel 7,
  API 34): all chart modes render, the chart keeps animating through a
  fully blocked JS thread on both platforms, and memory stays flat/settles
  under sustained streaming (Android's cache warm-up takes a bit longer to
  plateau than iOS's, not a leak).
- Visual parity with the web version confirmed side-by-side across line,
  candle, multi-series, orderbook, loading/empty/paused states, and small
  sizes in both themes.
- Scrub/crosshair-follows-finger confirmed by manual touch on iOS; not yet
  manually checked on Android (automated gesture injection doesn't reach
  the underlying Pan recognizer on either simulator/emulator, so this step
  is manual-only on both platforms). Not yet verified on a physical device.
