# Declarative render shell (react-native-graph-shaped)

**Date:** 2026-07-31
**Status:** Implemented and verified against this document 2026-08-01
(see "Conformance check" at the end)
**Branch:** `perf/declarative-shell` (off `e2c56d8`)

## Goal

Match react-native-graph's rendering *shape* — a declarative Skia tree with
continuous motion expressed as a `<Group transform>` driven by a shared value —
without losing either of the two things that make Liveline what it is: it keeps
animating while the JS thread is blocked, and its current visual output.

**This is an architecture goal, not a performance goal.** See "Honest cost"
below. The CPU case was measured and is weak; the user chose fidelity anyway.

## Target tree

```tsx
<Canvas>
  <Group transform={scrollTransform}>   {/* SharedValue<Transforms3d> */}
    <Picture picture={scrollPicture} />
  </Group>
  <Picture picture={screenPicture} />
</Canvas>
```

Four nodes, **fixed structure, never reconciled after mount**.

## Why this preserves the blocked-JS-thread guarantee

Verified in `example/node_modules/@shopify/react-native-skia/src/sksg/Container.native.ts:38-62`.
`NativeReanimatedContainer.redraw()` compiles the declarative tree once on the
JS thread, collects every shared value used as a prop, and then installs a
Reanimated mapper:

```js
this.mapperId = Rea.startMapper(() => {
  "worklet";
  sharedRecorder.applyUpdates(sharedValues);
  nativeDrawOnscreen(nativeId, sharedRecorder, picture);
}, sharedValues);
```

So shared-value prop updates run entirely on the UI thread. `redraw()` — the
only JS-thread step — runs on *structural* change. Our tree has no structural
change after mount, so nothing touches JS per frame.

`AnimatedProp<T> = T | { value: T }` (`renderer/processors/Animations/Animations.d.ts`)
confirms every Skia prop accepts a shared value, `<Group transform>` included.

## The ceiling on this approach

Variable-count content **cannot** go in the declarative tree without forfeiting
the guarantee: axis labels, candles, particles and orderbook bars change their
element count as data and scroll advance, and each change would require JS
reconciliation. During a JS block their counts would freeze, where today the
worklet still generates them.

That content therefore stays inside `<Picture>` nodes, which is why this design
is "react-native-graph-shaped" rather than a full port. Their model never faces
this because it has no continuous motion at all.

## What goes in the scroll layer

**`scrollPicture`: the line's prefix _stroke_ only** — the spline through
decimated points `0..N-2`, rebuilt only on a `lineCache` key miss.

**`screenPicture`: everything else**, including the *entire* fill polygon and
the tail stroke, drawn live every frame exactly as today.

### Why the fill is deliberately NOT split

The fill is one closed polygon: baseline → up the left edge → along the spline
→ down to baseline → close (`lineCache.ts:211-222`), and it is a semi-transparent
gradient (`palette.fillTop`/`fillBottom`). Splitting it at `cutX` gives three bad
options and no good one:

- **Abut two pieces.** Antialiased coverage on a shared edge sums to ~0.75, not
  1 — a visible hairline down the fill.
- **Overlap two pieces.** Semi-transparent overdraw double-darkens a 1px column.
- **Non-AA clip split.** Tiles exactly only if both sides round the boundary
  identically; at fractional `dx` a 1px gap or double-draw is possible. And
  rounding `dx` to whole pixels is not available to us: at a 30s window over
  ~300px the line moves ~0.17px/frame, so integer quantization would judder.

Keeping the fill whole sidesteps all of it. The **stroke** has no such problem:
it is opaque, and `drawSplineTail` already continues from `cutX` with the
prefix's end tangent (`lineCache.ts:197-206`), so the join is C1-continuous and
any overdraw is identical pixels.

## Honest cost

Because the fill still needs the full path every frame, `lineCache` keeps
running and this stage removes roughly **one draw call per frame**. It buys the
architecture, not speed.

For context, measured on this repo 2026-07-30/31: the whole time axis is 4.2% of
a core (valid ceiling A/B, drift control agreeing to 0.1 points), and the
timeAxis memoization — a 35% improvement to that function's JS — was
undetectable on device. A one-draw-call change will not be measurable. Do not
claim otherwise.

## Alpha gate

`ctx.drawPicture` ignores `globalAlpha` (`canvas2d.ts:139-143`). Whenever the
line's composite alpha is < 1 — reveal morph, loading/empty crossfade, scrub
dimming — the engine must fall back to recording **everything** into
`screenPicture` and leave `scrollPicture` empty, so nothing is composited at the
wrong opacity. Same gate `draw/index.ts:218` already applies to the grid picture.

## Work split

Two workstreams, deliberately chosen for file disjointness:

| Stream | Files | Deliverable |
|---|---|---|
| A — stroke split | `src/draw/lineCache.ts`, `src/draw/line.ts` | Expose the prefix stroke as a separately-drawable path; tail stroke unchanged; fill untouched |
| B — declarative shell | `src/Liveline.tsx`, `src/useLivelineEngine.ts` | Two-picture + `<Group transform>` tree; engine exposes `scrollPicture` / `screenPicture` / `scrollTransform`. Ships as a structural no-op: `scrollPicture` starts empty. |

Integration (wiring A's prefix stroke into B's `scrollPicture`, plus the alpha
gate) is a third, sequential step once both land.

### Reuse `src/draw/scrollLayer.ts` — do not re-derive

**Added 2026-07-31 after stream A flagged the omission.** This branch already
carries `src/draw/scrollLayer.ts` (commit `3db71f1`, "scroll-layer slot
foundation"), which provides exactly what integration needs and which the
original version of this doc failed to mention or place in either workstream's
file list:

- `ScrollLayerSlot<Picture>` — picture + build-time `tRef`/`xRefAtBuild` +
  per-slot clip region + a push-built invalidation key.
- `scrollLayerDx(slot, layout)` — the dx formula, identical to `lineCache.ts`'s
  `lineScrollDx`. A slot wrapping the line's prefix picture takes its
  `tRef`/`xRefAtBuild` straight from the line cache slot, so the two agree by
  construction.
- `scrollLayerUsable(slot, alpha)` — the alpha≥1 gate described below, already
  written.

Integration must consume these rather than re-implement dx or alpha handling.

### Naming collision to avoid

`scrollLayerDx(slot, layout)` is a **pure function returning a number**.
`scrollTransform` is a **shared value holding `[{ translateX }]`** that
`<Group transform>` reads. Earlier wording in this doc blurred the two; they are
different things, and the frame callback converts the former into the latter.

## Risks

- **Double-draw.** Once integrated, `screenPicture` must not also draw the
  prefix stroke. A visual diff at identical data is the check.
- **Transform units.** `scrollTransform` is `[{ translateX: dx }]` where `dx`
  is `scrollLayerDx`'s value — screen pixels, recomputed against the build-time
  reference every frame, never accumulated (`lineCache.ts:166-175`).
- **Z-order.** Two `<Picture>` siblings must composite in source order. Verify
  on device, not by assumption.
- **Text subpixel.** Nothing text-bearing is in the scroll layer in this design,
  so the jitter risk flagged earlier does not apply yet. It returns if the axis
  is ever moved in.

---

## Addendum 2026-08-01 — what the cleanup pass changed

This document is a dated record of what was decided *before* implementation.
Two API names it references no longer exist; the design itself is unchanged.

- **`scrollLayerDx` is gone.** It and `lineCache.ts`'s `lineScrollDx` had
  identical bodies and both doc comments claimed to be the single place the
  `toX(tRef) - xRefAtBuild` subtraction was written. `lineScrollDx` survives;
  `ScrollLayerSlot` no longer carries `tRef`/`xRefAtBuild` at all, because they
  were copied from the line cache slot and could therefore go stale.
- **`setScrollLayerClip` and the `clipX/clipY/clipW/clipH` fields are gone,**
  along with the "each slot clips to its OWN region" invariant above. They
  described an imperative `ctx.clipRect` + `ctx.translate` + `ctx.drawPicture`
  composite. The implementation composites through `<Group transform>` and
  bakes the clip into the recording instead, so none of it ever executed.
- **The scroll layer's invalidation key is four dimensions, not sixteen.** A
  `buildRev` counter on `LineCacheSlot` replaced the thirteen dimensions that
  were being copied verbatim out of the line cache's own key — which would have
  silently missed a fourteenth had one ever been added there.

Also added, and not anticipated here: `MIN_FRAME_INTERVAL_MS` and
`MAX_SCROLL_EXTRAPOLATION_MS` turn out to be coupled by two inequalities, now
documented in `engine/constants.ts` and asserted in `engine/__tests__/
constants.test.ts`. Tuning either alone can silently disable high-refresh
scrolling in a way only 120Hz hardware would reveal.

## Addendum 2 — the high-refresh transform, added after this doc was written

`33c23cb` added behaviour this document does not describe, and it is arguably
the most consequential runtime change on the branch. Recorded here so the spec
is not silently incomplete.

**Picture recording stays paced at ~60fps; the scroll transform advances on
every vsync** — 120fps on a ProMotion display. Translating an already-recorded
picture is nearly free, so the layer moves at the display's refresh rate while
recording cost is unchanged. Without this the layer would judder in lockstep
with the paced recording, and the split would have bought a draw call rather
than smoother motion.

On a vsync the pacing gate skips there is no `layout` — it is computed inside
`engineStep` — so `dx` cannot be recomputed and is linearly extrapolated from
the last two *recorded* frames (`engine/scrollExtrapolate.ts`, Skia-free so
jest can reach it). Extrapolating observed motion rather than recomputing from
`windowSecs`/`chartW` keeps no second copy of the engine's time-advance rules,
so pause, window transitions and time-debt catch-up need no special cases.
Every recorded frame overwrites with the exact value, so error cannot
accumulate past one vsync.

Three guards, all load-bearing:
- Only when a layer is actually compositing (`EngineState.scrollActive`).
- Only within `MAX_SCROLL_EXTRAPOLATION_MS` of the last recorded frame — a
  quiescence resume or a JS stall leaves the transform untouched rather than
  flinging it.
- **`layerChanged`** — no rate is observable across a frame where the layer's
  identity moved. `dx` is an offset *of a particular recorded picture*, so two
  frames 16ms apart can report `-35` then `0` with the line perfectly
  continuous, because the prefix was rebuilt in between. Differencing those
  describes a jump that never happened; unguarded, the next paced-out vsync
  shoves the layer ~35px sideways and the following frame snaps it back. The
  gap bound cannot catch this — a rebuild happens on an ordinary 16ms frame.

**Known and unverified:** the prefix now moves at 120Hz while the tail is
re-recorded at 60Hz, so on skipped vsyncs they shear by one frame of scroll —
`chartW / (windowSecs * refreshHz)`, about 0.25px on a 10s window and 0.08px on
30s. Sub-pixel, but a shimmer at the join rather than a clean offset. The iOS
simulator renders at 60Hz and cannot show it either way; this needs real
ProMotion hardware.

## Conformance check — 2026-08-01

Verified against the implementation at `0350072`, claim by claim:

| Claim | Status |
|---|---|
| Four-node tree, no conditionals | matches |
| `scrollPicture` = prefix stroke only | matches |
| `screenPicture` = everything else | matches |
| Fill deliberately not split, still built whole | matches |
| Alpha gate, binary, via `scrollLayerUsable` | matches |
| `dx` never accumulated | matches (no `dx +=` anywhere in src/) |
| No double-draw — split selects tail, not both | matches |
| Nothing text-bearing in the scroll layer | matches |
| Addendum 1: `scrollLayerDx` removed | matches |
| Addendum 1: clip API removed | matches |
| Addendum 1: key is 4 dimensions | matches (`buildRev`, `padLeft`, `lineWidth`, `line`) |

The one divergence was omission, not contradiction: the high-refresh transform
above shipped without a design record. Now written down.
