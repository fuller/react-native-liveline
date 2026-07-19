# react-native-liveline — Perf/best-practice hardening vs. react-native-graph

**STATUS: COMPLETE (2026-07-18).** All four items landed as separate commits —
#1 paint pooling `27b0dfc`, #2 min-max decimation `7c3c668`, #3
`scrubActivationDelay` `413af2d`, #4 `active` prop `6347873` — each gated on
typecheck/lint/test plus an iOS-sim check (incl. Block JS 2s). Only open
thread: the scrub-vs-scroll feel of #3 needs a manual finger check (synthetic
input can't reach RNGH Pan on the sim; see the example "Scroll" section).

**Read this first when resuming work.** This is a standalone follow-up
workstream, separate from `PLAN.md` (the original web→RN port plan, which is
fully shipped as of v0.1.0 — don't relitigate anything marked done there).
This file exists because `PLAN.md`'s "Deferred / nice-to-have" section already
flagged two of these items speculatively ("if profiling shows cost" / "if GC
pressure shows up") — this doc replaces that speculation with a concrete,
source-verified comparison against a real production library solving an
adjacent problem, plus an actual implementation plan. Once work starts here,
update `PLAN.md`'s deferred section to point at this file instead of
duplicating status.

## How this doc came to be

Compared this repo's rendering engine against
[margelo/react-native-graph](https://github.com/margelo/react-native-graph)
(v1.2.0, MIT, by Marc Rousavy/Margelo — a mature Skia+Reanimated line-chart
library used in crypto wallet apps). Source files fetched directly from GitHub
(`raw.githubusercontent.com/margelo/react-native-graph/main/...`) and read in
full: `src/CreateGraphPath.ts`, `src/AnimatedLineGraph.tsx`,
`src/hooks/usePanGesture.ts`, `src/GetYForX.ts`, `src/SelectionDot.tsx`,
`src/StaticLineGraph.tsx`, `package.json`. Local files read in full for the
comparison: `src/Liveline.tsx`, `src/useLivelineEngine.ts`,
`src/draw/canvas2d.ts`, `src/draw/line.ts`, `src/math/spline.ts`, plus targeted
greps of `src/engine/step.ts` (1484 lines — grepped, not fully read) and
`package.json` peer deps.

**Peer dep versions are already aligned** — no upgrade needed:
- This repo: `@shopify/react-native-skia@2.4.18`, `react-native-reanimated@4.2.1`,
  `react-native-gesture-handler@~2.30.0`
- react-native-graph: Skia `^2.5.3`, Reanimated `^4.2.3`, gesture-handler `^2.30.0`

## The core architectural difference (context for everything below)

The two libraries solve different problems, so react-native-graph's model
doesn't transplant wholesale — this isn't a "copy their architecture" plan,
it's a "borrow four specific techniques" plan.

- **react-native-graph**: fully declarative, event-driven. `createGraphPath`
  (`CreateGraphPath.ts`) runs once per data change inside a `useEffect`,
  producing a fixed-vertex-count `SkPath`. When data changes, it interpolates
  from the previous path to the new one using Skia's *native*
  `path.interpolate()`, driven by a single `withSpring(0→1)` on a shared value
  (`AnimatedLineGraph.tsx` — `interpolateProgress`). No continuous frame loop
  exists. Once the spring settles, zero JS/UI-thread work happens until the
  next data change.
- **This repo (Liveline)**: a permanent `useFrameCallback` in
  `useLivelineEngine.ts` fully re-records an `SkPicture` every frame, forever,
  via the Canvas2D-over-Skia shim in `draw/canvas2d.ts`. Necessary because
  this is a genuinely *live* ticking chart (continuous time-axis scroll,
  momentum glow, degen-mode particles, orderbook depth) — react-native-graph's
  discrete-update model literally cannot do continuous scroll; it has no
  concept of "now" moving forward between data points.

Given that, the frame-loop-forever model is the right call and should **not**
be replaced. What follows are four concrete techniques worth adopting *within*
that model, plus two things already confirmed to be better than
react-native-graph's approach (no action needed — noted so nobody
"fixes" them later).

## Findings & plan, ranked by impact

### 1. Paint object pooling (highest impact, do this first)

**Problem:** `src/draw/canvas2d.ts` — `fill()` (~line 308), `stroke()` (~line
336), `fillRect()` (~line 357), `fillText()` (~line 368), `strokeText()`
(~line 382) each call `Skia.Paint()` fresh — a native JSI host-object
allocation — on **every single draw call, every frame**. react-native-graph
never does this: Paint lifecycle is internal to its declarative
`<Path>`/`<Circle>`/`<LinearGradient>` component tree, allocated once by Skia's
reconciler. With grid lines, the line/fill stroke, dashed current-price line,
badge, momentum arrow, live dot, particles (degen mode), and orderbook bars
all drawing every frame at 60fps, that's dozens of Paint allocations per
second, compounding GC/allocation pressure on the one thread (UI thread) that
cannot afford to stall — this is literally the thread the whole
`useFrameCallback` architecture exists to protect.

**Plan:**
- Add a small paint-pool/cache inside `createCanvas2D` (`draw/canvas2d.ts`),
  scoped to the recorder's lifetime (i.e. per-frame, since a new `SkCanvas`
  recording starts each frame anyway — pooling *within* a frame across the
  many draw calls is the win, not persisting paints *across* frames, which
  would need careful invalidation).
- Simplest version: keep 2 reusable `SkPaint` objects (one fill-style, one
  stroke-style) as closure state in `createCanvas2D`, and have `fill()` /
  `stroke()` / `fillRect()` / `fillText()` / `strokeText()` mutate them via
  `setColor()` / `setStrokeWidth()` / `setStrokeCap()` / etc. instead of
  calling `Skia.Paint()` each time. Watch out for the shadow-paint path in
  `fill()` (~line 316-332) which allocates a second paint conditionally —
  pool that one separately since it's only used when `shadowBlur > 0`.
- Verify `setShader`/`setMaskFilter`/`setBlendMode` correctly reset between
  calls (a pooled paint from a previous *gradient* fill must not leak its
  shader into a later *solid-color* fill) — Skia's `SkPaint.setShader(null)`
  (or Skia's equivalent reset call) needs to run when switching from
  gradient→solid or blend-mode→normal.
- Test: run the existing "Block JS 2s" stress button
  (`example/src/StressButton.tsx`) before/after and confirm no visual
  regression; ideally profile allocation count via Xcode Instruments /
  Android Studio profiler on the UI thread during a live-updating chart,
  before/after, to quantify the win.

### 2. Pixel-density point capping for the spline

**Problem:** `CreateGraphPath.ts` (`createGraphPathBase`, ~line 148-176 in the
fetched source) deliberately steps through the path pixel-by-pixel
(`PIXEL_RATIO = 2`), capping the resulting path's vertex count at roughly
`canvasWidth / 2` **regardless of how many actual data points exist** in that
range. This repo's `draw/line.ts` (`drawLine`) instead feeds *every* point in
`visible` into `drawSpline` (`math/spline.ts`), whose Fritsch-Carlson
monotone-cubic tangent computation is O(n) over that array — **every frame**.
`engine/step.ts` filters `visible` only by time window (`leftEdge`/`rightEdge`
checks around line 1017-1019, 1300-1303), not by pixel density. For a
high-frequency tick feed (this library's actual use case — live prices), the
per-frame cost of the spline pass scales with tick density, not chart width,
and is unbounded as data gets denser.

**Plan:**
- Add a decimation step between "points visible in the time window" and "the
  array formed into `pts` for `drawSpline`" in `draw/line.ts` / wherever
  `visible` is finalized in `engine/step.ts` before hitting the draw layer.
- Use min-max decimation (not naive stride-sampling) so price spikes/wicks
  aren't silently dropped — for each pixel-wide bucket along `chartW`, keep
  the min and max value points, not just the first or last.
- Target ~1-2 points per screen pixel of `chartW` (mirror
  react-native-graph's `PIXEL_RATIO` reasoning, tuned via testing rather than
  copied verbatim since this repo's rendering isn't pixel-columnar the same
  way).
- Careful: this must not change behavior for the *common* case (sparse
  real-time ticks, e.g. one point per second) — only kicks in when point
  density actually exceeds the pixel budget. Add a fast-path early return
  when `visible.length <= chartW` (or similar threshold) so this never adds
  overhead to the normal case.
- Test with a synthetic high-density data generator (e.g. thousands of points
  in a 30s window) added temporarily to the example app, confirm frame time
  doesn't regress vs. today's behavior at that density, and confirm normal
  low-density usage (existing example screens) is visually unchanged.

### 3. Optional gesture activation delay for scroll-embedded usage

**Problem:** `hooks/usePanGesture.ts` in react-native-graph defaults
`enablePanGesture=false` and, when enabled, wires
`.activateAfterLongPress(holdDuration=300)` — specifically so scrubbing
doesn't compete with an outer `ScrollView`/`FlatList`'s own pan recognizer;
users can flick past a chart in a feed, and only a deliberate long-press
starts the crosshair. This repo's `Gesture.Pan().enabled(scrub)` in
`useLivelineEngine.ts` (~line 136-152) activates immediately in `onBegin`
with no hold delay. Fine for a full-bleed single chart screen, but if a
Liveline chart is ever embedded in a scrollable list (e.g. a list of ticker
rows — a very plausible use case for a "live" price chart library), the
immediate-activate Pan will steal the parent list's scroll gesture on first
touch.

**Plan:**
- Add an optional prop (name TBD — e.g. `scrubActivationDelay?: number`,
  default `0` to preserve current behavior exactly) threaded through
  `LivelineProps` (`src/types.ts`) → `EngineConfig`
  (`src/engine/types.ts`) → the `Gesture.Pan()` builder in
  `useLivelineEngine.ts`, calling `.activateAfterLongPress(delay)` when the
  prop is set `> 0`.
- This was already anticipated in `PLAN.md`'s deferred section
  ("`activateAfterLongPress` option for scrub inside ScrollViews") — this is
  that item, now with a concrete API shape.
- No behavior change for existing consumers (default `0` preserves current
  immediate-activation feel); purely additive.
- Test: add an example screen embedding a Liveline chart inside a
  `ScrollView` alongside other scrollable content, with and without the new
  prop set, confirm the difference is visible/correct on-device.

### 4. Off-screen / idle frame-loop suspension

**Problem:** `frame.setActive()` (`useLivelineEngine.ts` ~line 129) is only
wired to `AppState` backgrounding. Confirmed via grep of `engine/step.ts`
that `paused` does **not** stop the frame loop — it freezes data snapshots
(`s.pausedCandles`, `s.pausedData`, etc., set around lines 116-186) but the
`useFrameCallback` keeps running at 60fps regardless, handling
`pauseProgress` lerp and gesture/crosshair interaction. react-native-graph has
no equivalent problem by construction (spring-driven, not RAF-driven), so
there's nothing to port here directly — but the gap is real for this
library's likely usage pattern: a list of many Liveline ticker rows (e.g. a
FlashList/FlatList portfolio screen) would keep N independent 60fps UI-thread
callbacks running even for rows scrolled off-screen.

**Plan:**
- Add an optional `active?: boolean` prop (default `true`, purely additive)
  to `LivelineProps`, threaded to call `frame.setActive(active && appState ===
  'active')` in `useLivelineEngine.ts` — combine with the existing AppState
  listener rather than replacing it.
- Document the intended pattern in the README: wire this to the host list's
  viewability callback (e.g. `FlatList`'s `onViewableItemsChanged` /
  `viewabilityConfig`) so off-screen rows suspend their frame loop.
- Lower priority than #1–#3 — this is a "nice to have for list-heavy
  consumers" item, not a correctness or default-usage perf bug. Do it last,
  and only if #1–#3 land cleanly first.

## Already better than react-native-graph — do NOT "fix" these

- **Spline algorithm**: `math/spline.ts` uses genuine Fritsch-Carlson
  monotone cubic interpolation, which *guarantees* no overshoot past local
  min/max. react-native-graph's curve construction
  (`CreateGraphPath.ts` cubicTo calls, ~line 184-192) is a simple
  Catmull-Rom-style construction that **can** overshoot near sharp price
  reversals. This repo's approach is more correct; don't replace it with
  something "simpler" during this work.
- **Window-transition smoothing**: `engine/step.ts`'s `windowResult`
  (lerped `windowSecs`, e.g. ~line 425-438, 999-1005) already smoothly
  animates time-window changes rather than snapping — functionally
  equivalent in spirit to react-native-graph's path-interpolate morph, just
  implemented at the range level, which fits this repo's continuous-scroll
  model better than path-level interpolation would. No action needed.

## Suggested execution order

1. **#1 Paint pooling** — standalone, contained to `draw/canvas2d.ts`,
   lowest risk, highest and most easily measured impact. Do this first.
2. **#2 Point decimation** — contained to `draw/line.ts` +
   `engine/step.ts`'s `visible` construction; needs a synthetic
   high-density-data test in the example app to validate.
3. **#3 Gesture activation delay** — small, purely additive prop; low risk.
4. **#4 Visibility-based frame suspension** — purely additive prop; do last,
   lowest urgency.

After each item: run `node .yarn/releases/yarn-4.11.0.cjs typecheck`,
`lint`, and `test` from repo root (yarn 4 is vendored, no global yarn — see
`PLAN.md`'s "Key locations & commands" for the full command reference), plus
a manual on-device check via the example app (iOS sim and/or Android
emulator — see `PLAN.md` for the device-testing workflow already established
during the original port). Commit each item separately rather than bundling
all four into one commit, so a regression in one is easy to bisect.
