# Declarative render shell (react-native-graph-shaped)

**Date:** 2026-07-31
**Status:** Design approved, implementation dispatched
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
