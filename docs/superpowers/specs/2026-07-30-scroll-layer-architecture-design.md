# Scroll-layer rendering architecture

**Date:** 2026-07-30
**Status:** Design approved, not yet implemented
**Branch:** `perf/scroll-layer-architecture`

## Problem

`useLivelineEngine`'s frame callback re-records a complete `SkPicture` every
frame, forever. Most of what it records is content whose only per-frame change
is a horizontal translation: the chart scrolls left because "now" advances.

Two pieces of this are already solved at the *path* level:

- `draw/lineCache.ts:189-206` caches the spline prefix and, on a hit,
  re-assembles the drawable path as `addPath(prefix)` + `offset(dx, 0)` + two
  tail cubics — no spline rebuild.
- `draw/gridLayer.ts` caches the grid as a composited `SkPicture`, replayed
  with a single `ctx.drawPicture` (`draw/index.ts:219`).

One piece is not solved at all. `draw/timeAxis.ts` has no cache: every frame it
recomputes the interval, calls `formatTime()` per label (the default formatter
allocates a `Date` and three `padStart` results *per label per frame*), walks
and lerps a label `Map`, measures, sorts, resolves overlaps, then issues
`save/beginPath/moveTo/lineTo/stroke/fillText/restore` per label. Its own source
comment records the gap: *"rebuilt unconditionally every frame (this function
has no picture-cache bypass, unlike `drawGrid`)"* (`timeAxis.ts:19-22`).

This design promotes the translate-instead-of-re-record technique from the path
level to the picture level, and extends it to the time axis.

### Scope note

The incremental win for the line specifically is modest, because `lineCache`
already captures most of it — roughly a dozen native calls per frame collapse to
about two. This was raised before the design was accepted and the full
architecture was chosen deliberately. The largest single win in this design is
the time axis, which is currently uncached.

## Architecture

### The scroll layer abstraction

A new module, `src/draw/scrollLayer.ts`, provides a generic **scroll layer
slot**: a cached `SkPicture` recorded in build-time screen coordinates and
composited each frame at a horizontal offset.

```
dx = layout.toX(slot.tRef) - slot.xRefAtBuild
```

This is the identical formula `lineCache.ts:189` uses — recomputed against the
build-time reference every frame, never accumulated, so there is no drift.

Composition:

```ts
ctx.save();
ctx.clipRect(slot.clipX, slot.clipY, slot.clipW, slot.clipH);
ctx.translate(dx, 0);
ctx.drawPicture(slot.picture);
ctx.restore();
```

Each slot carries its **own** clip region rather than sharing one: `lineScroll`
and `candleScroll` clip to the plot area, while `axisScroll` clips to the axis
strip below it (`h - pad.bottom` downward). A single shared chart-area clip
would erase the axis entirely.

The module is kept free of Skia imports (structural `Picture` type parameter,
exactly like `gridLayer.ts`) so jest can exercise the key-comparison and `dx`
logic without the native binding.

### Three instances, not one merged picture

Three independent slots: `lineScroll`, `candleScroll`, `axisScroll`.

- **Z-order.** Today's order is `… → line+fill → timeAxis → dot → …`
  (`draw/index.ts:253-289`). Merging line and axis into one picture would fuse
  two non-adjacent z positions.
- **Independent invalidation.** The line rebuilds on every tick; the axis
  rebuilds only when a label enters or leaves (roughly every `interval`
  seconds — about every 5s on a 30s window). Merging would drag the axis into
  the line's rebuild rate and destroy its entire advantage.

Cost: two extra `drawPicture` calls per frame.

### Layer membership

**Scroll layer** — rebuilt only when its key changes:

| Slot | Contents | Rebuild trigger |
|---|---|---|
| `lineScroll` | spline prefix through decimated points `0..N-2`, stroke + fill | tick / range / geometry change |
| `candleScroll` | closed candle bodies + wicks, batched by bull/bear | new or revised closed candle |
| `axisScroll` | axis baseline, ticks, labels at full alpha | label enters/leaves, interval change |

**Screen layer** — recorded live every frame, unchanged from today: line tail
(last data point + live tip), live candle, live dot, pulse ring, momentum
arrows, particles, shake, badge, value text, crosshair, edge fades. Plus the
value-space layers that never scroll and are unaffected: grid (already its own
cached picture), reference line, orderbook.

The static/moving split for line and candles is not new: it is exactly the
prefix/tail split `lineCache` and `candleCache` already encode.

### Build ordering

Scroll layers are rebuilt **before** `recorder.beginRecording()` opens the
frame's picture, never during it. This avoids depending on
`Skia.PictureRecorder()` being safely reentrant while another recording is open,
and makes the ordering explicit and testable. `useLivelineEngine.ts` gains a
"rebuild dirty scroll layers" step ahead of the existing recording block.

## The constraint that shapes everything: pictures bake paint

`ctx.drawPicture` ignores `globalAlpha` — documented at `canvas2d.ts:140-143`,
because Skia's `drawPicture` takes no paint argument. Applying alpha at
composite time would require `saveLayerAlpha`, which allocates an offscreen
render target — precisely the Android cost this work exists to avoid.

**Rule: a scroll layer is used only when its composite alpha is exactly 1.**
Otherwise the engine falls back to today's live-drawing path.

This is an existing pattern, not a new one: `draw/index.ts:218` already gates the
grid picture on `reveal >= 1` for the same reason. Practically it means the
reveal morph, the loading/empty crossfade, and scrub dimming all bypass scroll
layers. Those are transient; the steady state is what is being optimized.

A second consequence: **palette becomes part of every scroll-layer key**, unlike
the path caches. A picture bakes color, stroke width, and gradient stops that a
path did not.

## Time axis redesign

Labels and ticks bake at alpha 1. The per-label 50px `edgeAlpha` fade
(`timeAxis.ts:65-72`) is replaced by a gradient `destination-out` erase over the
axis strip at both edges, applied in the screen pass after compositing — the same
technique `drawEdgeFade` already uses for the chart body:

```ts
ctx.globalCompositeOperation = 'destination-out';
ctx.fillStyle = <linear gradient, 50px>;
ctx.fillRect(chartLeft, axisTop, 50, axisH);      // left
ctx.fillRect(chartRight - 50, axisTop, 50, axisH); // right
```

Per-label alpha state disappears. Label visibility becomes a pure function of
position, which also replaces the alpha-based overlap tiebreak
(`timeAxis.ts:184-198`) with a positional one.

**Accepted behavior change:** during a window transition, label set swaps become
hard rather than an alpha dissolve. This was chosen explicitly over a
pixel-identical hybrid design.

`timeAxis.ts` imports `Ctx2D` as a type only, so it is jest-testable with a fake
context. The redesign is therefore developed test-first.

## Invalidation keys

Following the existing discipline: flat values only, compared field-by-field, no
allocation per frame.

**`lineScroll`** — reuses `lineCacheHits`'s existing key
(`kDataRev`, `kDataSource`, `kLen`, `kFirstT`, `kLastT`, `kLastV`, `kMin`,
`kMax`, `kWindow`, `kH`, `kPadTop`, `kPadBottom`, `kChartW`) plus new
picture-only dimensions: line color, line width, fill enabled, fill gradient
stops. Bypassed entirely while `reveal < 1` or scrub dimming is active.

**`candleScroll`** — `candleCache`'s existing key plus `candlesRev`, bull/bear
body and wick colors, and `candleWidth`.

**`axisScroll`** — `interval`, a cheap visible-label-set identity (count + first
key + last key), `tRef`, `formatTime` reference equality, `palette.gridLine`,
`palette.timeLabel`, `pad`, `h`, `w`.

## Risks

**Cull rect (highest).** A picture records with a cull rect in its own
coordinate space; content outside it may be dropped at record time. Compositing
at `translate(dx, 0)` then shifts the result. Two mitigations, both applied:
record each scroll layer with a cull rect expanded to cover the full
pre-rebuild scroll range, and always `clipRect` to that slot's own region at
composite time so translated content cannot bleed into the padding, the badge,
or across the plot/axis boundary.

**Text subpixel jitter.** Compositing at fractional `dx` re-rasterizes glyphs at
a new subpixel position. Vector content stays crisp, but glyph hinting could
produce ~1px jitter on axis labels while scrolling. Verify visually; if it
appears, round `dx` to whole pixels for `axisScroll` only (labels sit at
computed intervals, so a sub-pixel snap is invisible).

**Alpha-1 gating reduces coverage.** Any chart spending significant time mid-
reveal, mid-crossfade, or scrub-dimmed gets no benefit. Acceptable: those states
are transient.

**Blast radius.** Touches `engine/step.ts` (1,813 lines), `draw/index.ts`, and
every affected draw module's coordinate assumptions. `PLAN_MAINT.md` item 4
(positional-parameter soup) already blocked one smaller perf change in
`drawLine`; the scroll-layer parameter is threaded as part of an options object
rather than a 17th positional parameter.

## Testing

- New `src/draw/__tests__/scrollLayer.test.ts` — key comparison, `dx`
  computation, rebuild triggering, alpha-1 gating. Fake picture recorders, same
  pattern as `lineCache.test.ts`.
- New time-axis tests — label-set selection and positional overlap resolution,
  using a fake `Ctx2D`.
- Extend `lineCache.test.ts` / `candleCache.test.ts` for the new palette key
  dimensions.
- Per stage: `typecheck`, `lint`, `test` from repo root via the vendored yarn
  (`node .yarn/releases/yarn-4.11.0.cjs <script>`).
- Per stage: visual verification on iOS simulator and Android emulator.

## Staging

Four landings, each its own commit so a regression is bisectable.

| Stage | Content | Behavior change |
|---|---|---|
| 0 | `draw/scrollLayer.ts` + tests | None — nothing consumes it yet |
| 1 | `lineScroll` wired into the line pipeline | None expected |
| 2 | `candleScroll` wired into the candle pipeline | None expected |
| 3 | `axisScroll` + time-axis redesign | Window-transition label swap becomes hard |

Each stage gates on typecheck + lint + test, plus:

- **iOS CPU A/B** using the established `run-and-profile` protocol: swap only
  `src/`, 3 runs per arm over fixed 20s windows, drift-control re-measure. FPS
  cannot show this win — frame pacing caps recording at ~60
  (`MIN_FRAME_INTERVAL_MS`), so both arms read 60 regardless. Measure CPU time.
- **Android emulator release build**, with two preconditions checked first,
  both of which have previously produced false "still slow" signals:
  `hw.gpu.enabled` in the AVD config, and host `uptime` before each arm.

Emulator relative CPU deltas are meaningful for this work because it is a
CPU-side change (fewer draw calls recorded per frame). They would *not* be
meaningful for GPU-compositor-side questions such as `opaque`/TextureView.

Rollback: every stage keeps the live-draw path intact as the alpha<1 fallback,
so any stage reverts as a single commit.

## Out of scope

- **Declarative `<Group transform>` promotion.** Chosen as an explicit
  follow-up: land the imperative split first, since the layer boundary is the
  hard part, then evaluate promoting it.
- **Multi-series scroll layers.** Multi-series already has per-series
  `lineCache` slots and is excluded from quiescence. Extending scroll layers
  per-series is mechanical but multiplies the surface; deferred.
- **`opaque` / TextureView→SurfaceView.** Independent, GPU-compositor-side, and
  requires physical Android hardware to evaluate honestly. Tracked separately.
