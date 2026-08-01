# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- **`react-native-gesture-handler` peer range widened to `>=2.30.0`** (was
  `>=3.0.0`). The v3 floor existed only because the engine imported a
  v3-only type name for a union it never used — the hook always returns a
  single `Gesture.Pan()`, so the return type is now just `GestureType`,
  which exists in both majors. Expo SDK 55 pins `~2.30.0`, so every SDK 55
  consumer previously hit a peer conflict and an `expo-doctor` failure on
  install. Verified by installing 2.30.0 and running the real typecheck, not
  by inspection.

### Changed

- **Declarative render shell** — the chart now renders as a fixed four-node
  Skia tree (`<Canvas>` → `<Group transform>` → `<Picture>`, plus a sibling
  `<Picture>`) instead of a single picture. The structure never changes after
  mount, so the Reanimated mapper that drives it stays entirely on the UI
  thread and the "keeps animating while the JS thread is blocked" guarantee
  is preserved. This is an architecture change, not a performance one; no
  speedup is claimed for it.
- **The single-series line's prefix stroke moved into that scroll layer** —
  the spline through all but the last data point is recorded once into its
  own `SkPicture` and composited at a horizontal offset via
  `<Group transform>`, re-recorded only when the line path cache misses; the
  per-frame screen picture strokes only the tail. The fill polygon is
  deliberately **not** split (it is one semi-transparent closed shape; every
  way of cutting it leaves a seam or a double-darkened column) and is still
  drawn whole every frame. Any frame that can't composite the layer at
  alpha 1 — the reveal morph, the loading/empty crossfade, scrub dimming,
  the degen shake — falls back to drawing the whole line live, because
  `drawPicture` ignores `globalAlpha`. Multi-series and candle mode are
  untouched and keep drawing the combined path. In accounting terms this
  removes roughly one draw call per frame; it was not measurable on device
  and no speedup is claimed for it.
- **Time-axis labels no longer re-format every frame** — `formatTime` is a
  pure function of a label's key, but the axis called it for every label on
  every frame and overwrote each label's text with a byte-identical string
  (~360 calls/sec at a 30s window, each allocating a `Date` and three
  `padStart` results with the default formatter). It now runs only for a key
  seen for the first time; a formatter swap is caught by reference identity
  and re-texts live labels in place without disturbing their fades. Also
  fixes a churn bug found by the new tests: labels one interval beyond each
  edge — deliberately targeted, but at alpha 0 — were deleted and re-created
  every single frame forever. Purely internal; per-label alpha, crossfades
  and edge fades are unchanged. Worth ~35% of that function's JS time in
  isolation, and undetectable on device (the whole time axis is 4.2% of a
  core).

- **The scroll layer's transform now runs at the display's full refresh
  rate.** Picture re-recording stays paced at ~60fps, but translating an
  already-recorded picture is nearly free, so the `<Group transform>` advances
  on every vsync — 120fps on a ProMotion display — while recording cost is
  unchanged. On a vsync that pacing skips there is no layout to recompute `dx`
  from, so it is linearly extrapolated from the last two recorded frames and
  overwritten with the exact value on the next one; a quiescence resume, a
  return from background or a JS stall leaves the transform untouched rather
  than flinging it. Note the consequence: the prefix moves at 120Hz while the
  tail is re-recorded at 60Hz, so on skipped vsyncs they shear by one frame of
  scroll — roughly 0.25px on a 10s window, 0.08px on 30s. Sub-pixel, but
  unverified: the iOS simulator renders at 60Hz and cannot show it either way.
- **`MIN_FRAME_INTERVAL_MS` and `MAX_SCROLL_EXTRAPOLATION_MS` are coupled** by
  two inequalities that are now documented in `engine/constants.ts` and
  asserted in `engine/__tests__/constants.test.ts`. Tuning either alone can
  silently disable high-refresh scrolling in a way only 120Hz hardware would
  reveal.

### Removed

- **`src/draw/timeAxisLayer.ts` and its tests** — pure label-selection logic
  built for a time-axis scroll layer that was measured, priced and parked
  rather than adopted, and which nothing imported. Recoverable from
  `302df29` / `82d8f6b` on `perf/scroll-layer-architecture` if the axis ever
  moves into a scroll layer. No API change; the module was never exported.
- **Non-existent `android`, `ios`, `cpp`, `*.podspec` and
  `react-native.config.js` entries from `files[]`** — this is a JS-only
  library. `npm pack` output is unchanged (255 files, 1.3 MB).

## [0.2.1] - 2026-07-28

### Changed

- **Candle mode skips building an unused line-overlay array** — in steady
  candle mode the engine was assembling the line-mode point array (one
  object per visible candle, or per visible tick during a density blend)
  on every frame, which the draw layer then discarded because the line
  overlay isn't drawn unless a line-mode or reveal transition is active.
  It's now built only when it will actually be used. Internal only, no
  visual change. Measured no CPU delta on a Debug simulator build — this
  removes provably dead work rather than making live work faster.
- **Line-overlay presence logic consolidated** — the draw layer's "is the
  candle-mode line overlay visible this frame" calculation and the engine's
  companion "should I build its points" check previously lived as separate
  inline expressions sharing a hardcoded threshold. Both now live in
  `draw/lineOverlay.ts`, with a test asserting the invariant that keeps them
  safe (the builder may only ever skip frames the drawer would ignore).
  Behavior is unchanged — the extracted presence function is bit-identical
  to the previous inline expression across the full input domain.

## [0.2.0] - 2026-07-27

### Added

- **`scrubActivationDelay` prop** — optional ms of long-press before the
  scrub pan gesture activates (via `.activateAfterLongPress`), for charts
  embedded in a `ScrollView`/`FlatList` so flick-scrolls aren't stolen by
  the crosshair on first touch. Default `0` preserves the existing
  immediate-activation behavior exactly. The example app gained a "Scroll"
  section demonstrating both modes.
- **`active` prop** — set `false` to suspend the engine's per-frame
  UI-thread callback entirely (e.g. wired to a `FlatList`'s
  `onViewableItemsChanged` so off-screen charts in a list cost nothing).
  Default `true`; combines with — does not replace — the existing
  AppState-backgrounding suspension. See the README's "Charts in lists"
  section for the intended wiring.

### Changed

- **Paint and path pooling in the Canvas2D shim** — draw calls now reuse
  three pooled `SkPaint` objects and a single rewound `SkPath` per frame
  instead of allocating fresh native objects per call (previously dozens
  of JSI host-object allocations per frame at 60fps, all on the UI
  thread); shadowed fills also stopped allocating an offset path copy.
  No visual change.
- **Data/candles delta sync** — the `data` and `candles` arrays are no
  longer re-serialized whole into the UI-thread config on every commit;
  each tick now sends only the changed tail (usually one point) across
  the runtime boundary, so per-tick JS cost no longer scales with buffer
  length. Internal only — the `data`/`candles` props are unchanged.
- **`onHover` fires on change only** — while a finger rests on the chart,
  the callback no longer re-fires every frame with an identical point;
  it now fires only when the hovered point actually changes (matching
  the web version's event-driven contract).
- **`Liveline` is memoized and the package declares `sideEffects: false`**
  — unrelated parent re-renders skip chart rows, and consumer bundlers
  can tree-shake the package.
- **Cross-frame Skia object caches** — gradient shaders, dash path
  effects, blur mask filters, parsed colors, text widths, and font
  metrics are now cached across frames (bounded, keyed on every input)
  instead of being re-created natively on every draw call.
- **Quiescent charts stop re-recording** — a paused, fully-settled chart
  now skips its per-frame picture recording entirely (~2% vs ~94% app
  CPU measured on the iOS simulator) and resumes instantly on any
  interaction, prop change, or resize. Behaviorally invisible: pause
  resume/catch-up timing is preserved.
- **Pixel-density point decimation** — the line spline now caps its input
  at ~2 points per pixel of chart width using min-max bucket decimation
  (spikes/wicks survive), so per-frame spline cost is bounded by chart
  width instead of tick density. Sparse feeds (the common case) hit a
  zero-allocation fast path and are completely unaffected; crosshair/hover
  interpolation still uses full-resolution data.
- **Cached line path with translate-based scroll** — the line spline's
  `SkPath` is now cached across frames and re-positioned with a single
  native translate, rebuilding only when the data, Y-range, window, or
  canvas size actually change. Between ticks on a settled chart (most
  frames), per-frame path work drops from a full spline rebuild plus one
  JSI segment call per point (previously run twice — fill and stroke) to
  about ten native calls; the two live-edge segments are still appended
  fresh each frame so tick animation is unchanged. Dense feeds get a
  stable absolute-time decimation grid so the cache also holds there.
  Applies to single- and multi-series line rendering; candle mode keeps
  the previous path. Curvature of the last ~3 segments can differ
  imperceptibly (the cache cut uses a one-sided tangent, C1-continuous
  at the junction).
- **Quiescence now actually engages** — the skip-re-recording condition
  wrongly required `pulse: false`, but `pulse` defaults to `true`, so no
  default-configured chart ever went quiescent. The condition was
  redundant (the pulse ring is already forced off at full pause) and has
  been removed.
- **Badge pill path cached, and no longer built from an SVG string** — the
  badge's `SkPath` was rebuilt via `Skia.Path.MakeFromSVGString` (a native
  string parse) on every frame; it's now built directly with primitive
  path calls (the same `arcToTangent` rounding `roundedRect` already uses
  for candle bodies) and cached, rebuilding only when the pill geometry
  changes and reusing the same native object across rebuilds rather than
  replacing it. Positioned via canvas translate instead of path mutation.
  Shares its lazy-cache mechanism with the line path cache below (see
  `draw/pathCache.ts`). No visual change — the geometry is a direct,
  tested port of the original SVG shape.
- **Animated color blends quantized** — momentum/scrub/orderbook/live-candle
  color lerps now quantize their blend factor to 1/64 steps (visually
  lossless) so they produce repeating `rgb()` strings that hit the shim's
  color cache instead of a distinct cache-missing string per frame.
- **Simplified shadows on Android** — blurred (mask-filter) shadows
  re-raster the blur on every recorded frame, which is disproportionately
  expensive on Android GPUs. Android now draws a flat offset silhouette
  at reduced alpha for the live-dot and badge shadows (same depth cue,
  no blur cost) and skips the live-candle glow's blur pass (the pulsing
  brightness cycle is kept). iOS/web rendering is unchanged.
- **Candle mode can now go quiescent** — a `Math.sin(now_ms)`-driven glow
  animation on the live candle (and, during a line-mode morph, the dot's
  pulse ring) ran unconditionally, so a paused candle chart never stopped
  re-recording. Both now hard-cut off at `pauseProgress < 0.5`, matching the
  line-mode pulse ring's existing behavior, and candle mode is no longer
  excluded from the quiescence check.
- **Picture recording capped at ~60fps** — the engine previously re-recorded
  on every vsync, so a 120Hz Android display did twice the work of a 60Hz
  one for identical visual output. Frame skipping is safe because every
  animation lerp in the engine composes exactly under accumulated time deltas;
  two call sites (particle drag, orderbook churn smoothing) that weren't
  time-scaled were fixed as a prerequisite. Applies on iOS too — no visual
  trade-off at any frame rate, unlike the Android-only shadow simplification
  above.
- **Grid layer cached as a composited picture** — gridlines and Y-axis labels
  are now recorded into their own `SkPicture`, rebuilt only when the Y-range,
  canvas size, or palette actually change (or during the brief window right
  after they do, while label fades are still animating), and composited with
  a single native call the rest of the time instead of replaying every
  gridline stroke and label draw call every frame. Time-axis labels aren't
  cached yet — they scroll horizontally during live playback and need a
  translate-based approach like the line spline cache above, which is its
  own follow-up.
- **Animated color blends build an SkColor directly** — the dot's scrub-dim
  lerp, orderbook's label fade, the badge's momentum color, the line's
  reveal-morph stroke, and every candle color now build a Skia color object
  straight from their computed RGB numbers instead of formatting an
  `rgb()`/`rgba()` string and parsing it back natively — cheaper than even a
  color-cache hit, and slightly more precise (no more snapping the blend to
  1/64 steps to keep a string cache-key stable).
- **Candle draw calls batched** — each candle previously issued up to 3
  separate native draw calls (2 wicks + 1 body); non-live candles are now
  grouped by color (at most 2 groups) into a combined path per group, so a
  100-candle chart costs a handful of calls instead of 200-300+. Falls back
  to per-candle drawing while scrub-dimming is active, since that gives each
  candle its own alpha that can't be expressed as one paint-level alpha for
  a combined path.
- **Closed-candle geometry cached with translate-based scroll** — the
  body+wick paths for every closed candle are now built once into four
  combined paths (bull/bear × body/wick) and re-positioned each frame with a
  single native translate, rebuilding only when the candle data, Y-range,
  candle width, window, or canvas size actually change. Between candle
  closes (most frames) this replaces a full geometry rebuild — for wide
  candles each body is a rounded rect, nine native path calls apiece — with
  four fill/stroke calls against cached paths. The live candle is still
  drawn fresh every frame, so tick animation is unchanged, and colors are
  never baked into the cached geometry, so accent-blend and line-mode-morph
  color animation keep working on top of it. Mirrors the line spline cache
  above, sharing its lazy-cache mechanism (`draw/pathCache.ts`). The cache
  sits out entirely during scrub-dimming, candle-width morph, mid
  line-mode-morph, and the reveal OHLC-collapse window, all of which reshape
  every candle per frame. No visual change.
- **Live-candle OHLC lerp snaps to its target** — the live candle's
  open/high/low/close smoothing had no exact-snap step, unlike every other
  lerp in the engine, so it approached its target asymptotically without ever
  reaching it. Since the visible Y-range is computed across all candles
  including the live one, that left the range drifting by an epsilon every
  frame whenever the live candle held the window extreme — which invalidated
  the candle geometry cache above on every frame in exactly the case it
  matters most. Now snapped sub-pixel, matching the existing line/value snap
  thresholds. Invisible at any zoom level.
- **Per-frame allocations removed from the multi-series step** — the
  hidden-series lookup built a fresh `Set` every frame where an array scan
  over a handful of ids is cheaper, and the stale-entry cleanup allocated a
  container every frame to do nothing in the steady state; the cleanup is now
  guarded on a size comparison that skips it entirely unless a series was
  actually removed. The per-frame smoothed-values map is reused across frames
  rather than reallocated.
- **Line path cache no longer pays for the work it exists to skip** — the
  spline decimation and the per-point screen-coordinate array were built
  *before* the cache was consulted, then discarded on every cache hit (the
  hit path reads only the two live-tail points). The cheap key check now runs
  first, so a hit skips decimation entirely and allocates two points instead
  of up to two per pixel of chart width — per series, per frame. The key
  comparison lives in one place shared by both the early check and the
  rebuild path, so the fast and slow paths can't drift apart, and the
  assembled output is verified identical between them.
- **Orderbook charts can now go quiescent** — the orderbook's label spawn,
  drift, and expiry ran off raw wall-clock `dt` rather than the pause-scaled
  `dt` the rest of the engine uses, so a chart with `orderbookData` re-recorded
  forever even when fully paused and was excluded from the quiescence check
  outright. It now uses the same pause-scaled delta as every other animation,
  matching what candle mode already did. Orderbook label flow freezes at full
  pause, consistent with every other pause-gated animation.
- **Per-frame point arrays pooled** — the visible-window filter allocated a
  fresh array per pipeline (and per series in multi-series mode) every frame,
  plus one object per visible series for the draw list. These now refill
  reusable buffers held on engine state, pruned when a series is removed. The
  candle-mode reverse-morph stash copies at the stash point rather than
  aliasing the frame's buffer.
- **Draw-layer per-frame allocations pooled** — the time axis was the biggest
  remaining one: unlike the grid, it has no composited-picture bypass, so it
  rebuilt a target set, two container arrays, and one object per visible
  label on every single frame. Those now refill buffers held on the axis
  state. The grid's per-call target map is pooled the same way (lower impact,
  since the grid picture cache already skips it in steady state), and the
  orderbook stopped rebuilding a combined level array on every label spawn
  (~25×/sec even when the book hasn't changed) and now caches its outline
  color string against the palette RGB instead of rebuilding it per frame.
  Weighted-pick distribution is unchanged — same scan order and totals.
- **The per-frame drawing context is built once, not rebuilt every frame** —
  the Canvas2D shim's context object (23 method closures, 14 properties, a
  style stack and three helper closures) was constructed inside the frame
  callback, ~27 allocations per frame before anything was drawn. Only the
  recording canvas actually varies per frame, so the context is now built
  once and cached, with the canvas rebound and every piece of mutable state
  reset each frame. Measured ~10% lower process CPU on the iOS simulator,
  though the host was too noisy to pin the figure tightly.
- **The reverse-morph stash stopped copying whole buffers every frame** —
  the stash that keeps a chart drawable while data disappears was rebuilt on
  every frame, re-copying every series' entire point array (~half a million
  element copies a second on a four-series feed) to maintain something read
  only during that transition. It now refreshes when the data revision
  actually moves. The stash's colour/label/value fields are still refreshed
  per frame, since those can change without the data changing.
- **Visible-window selection uses binary search** — finding the on-screen
  points scanned the entire buffer every frame, per series; it now binary
  searches for the window's start (the buffer is time-ordered, an invariant
  `computeDelta` and `candleAtX` already rely on) and stops at its end. On a
  short window over a long buffer that is a couple of thousand comparisons
  replaced by about a dozen.
- **Live dot stopped parsing a color string it usually discarded** — the dot
  parsed `badgeOuterBg` (a regex match, three `parseInt`s and a match array)
  on every frame, but only used the result while scrub-dimming. Both parses
  now sit inside that branch. Investigated while checking whether the pulse
  ring was a frame-rate cost: measured with the ring toggled on and off, it
  isn't — it draws for 900ms of every 1500ms cycle and costs one `addCircle`
  plus one stroke when it does.
- **Multi-series data no longer crosses the runtime boundary whole** — `data`
  and `candles` were long ago pulled out of the mirrored config and given their
  own delta-synced buffers, because re-serializing large point arrays into the
  UI runtime on every commit was expensive. Multi-series data never got the
  same treatment: each series' full point array rode along inside the config
  and was deep-copied on every commit (four series of a few thousand points,
  several times a second). Each series now syncs through its own
  delta-updated, id-keyed buffer, so a tick sends only the changed tail. The
  per-series cache revisions added above are now derived from those deltas
  rather than an array-reference check, which also catches a value-equal but
  recreated array. Internal only — the `multiSeries` prop is unchanged.
- **Multi-series line caches get a real data revision** — they passed a
  hardcoded `dataRev: 0` and relied entirely on a length/first-time/last-time/
  last-value heuristic, which cannot see a consumer revising an *interior*
  point of a series: every heuristic field stays put and the stale line keeps
  rendering. This is the same defect `candlesRev` fixed for candles, and it
  now has the same fix — a per-series revision counter, so an interior
  revision invalidates only the series that changed.
- **Clipping uses a non-antialiased rect instead of an antialiased path** —
  every clip in the library is an axis-aligned rectangle, but all of them
  went through `clipPath(..., doAntiAlias: true)`. An antialiased path clip
  can't lower to a GPU scissor, so Skia falls back to a clip mask or analytic
  AA coverage — substantially more expensive per draw call, and these clips
  wrap the innermost, most-executed draws in the library (the line
  stroke/fill and the entire candle body). They now use `clipRect` with
  antialiasing off, which for an axis-aligned rect has no visual cost. The
  `beginPath()`/`rect()` path construction those sites paid is gone too.
- **The per-frame scratch path is marked volatile** — the pooled `SkPath`
  that's rewound and refilled every frame now sets `isVolatile`, telling Skia
  not to treat it as static geometry worth caching or uploading as a
  long-lived resource. Deliberately applied only to that one path: the
  cross-frame line, candle, and badge caches are long-lived by design and
  benefit from exactly the caching volatility disables.
- **Remaining shim allocations pooled** — constant dash patterns are hoisted
  to module-level constants (they previously cost up to three array
  allocations per use, per frame, between the inline literal and two
  defensive copies), the linear-gradient descriptor is reused rather than
  rebuilt as a fresh object plus two arrays plus a closure on each of its
  ~2-3 calls per frame, and the `SkRect` handed to `rect`/`arc`/`fillRect`/
  `clipRect` and to the picture recorder's cull rect is reused in place.

### Internal

- Shared helpers extracted for logic that had been copied across modules:
  cosine ease-in-out and log-space interpolation (4 sites), the reveal
  smoothstep ramp (3 sites, each of which also allocated a closure per frame),
  the scrub-fade opacity curve (3 sites), the left-edge fade gradient (4
  sites), and the visible-window point filter (4 sites). No behavior change —
  these were byte-identical copies whose tuning constants could silently
  diverge.

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
