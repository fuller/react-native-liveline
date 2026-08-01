import type { LivelinePalette } from '../types';
import type { LineCacheSlot } from './lineCache';
import {
  scrollLayerBeginKey,
  scrollLayerPushNum,
  scrollLayerPushRef,
  type ScrollLayerSlot,
} from './scrollLayer';

/**
 * Pure logic for the **line prefix scroll layer** — the half of
 * `draw/scrollLayer.ts`'s contract that is specific to the single-series
 * line: which frames may composite the layer at all, and what the layer's
 * invalidation key is.
 *
 * The recording itself lives in `engine/lineScrollLayer.ts` (it needs Skia);
 * this module stays Skia-free so jest can exercise the gate and the key with
 * plain objects, exactly like `draw/gridLayer.ts` vs `engine/gridLayer.ts`.
 *
 * ## What the layer holds
 *
 * `lineCache.linePrefixPath(slot)` — the spline through decimated points
 * `0..N-2`, in build-time screen coordinates — stroked with the line's paint.
 * Nothing else. The fill polygon and the tail stroke stay in the per-frame
 * screen picture; see the "Split stroke API" section comment in
 * `draw/lineCache.ts` for why the fill is deliberately not split.
 *
 * ## Z-order note (read before changing the palette contract)
 *
 * The scroll layer composites *below* the screen picture, so the prefix
 * stroke ends up **under** the fill polygon, where today's combined path
 * draws it **over**. With the built-in theme that is a no-op: `theme.ts`
 * derives `fillTop`/`fillBottom` as the *line color* at alpha 0.12→0, and
 * compositing a color over itself is the identity. A caller supplying a
 * custom palette whose fill hue differs from `palette.line` would see the
 * lower half of the prefix stroke tinted by up to 12% of that hue. If that
 * ever needs to be exact, the gate below is where to add the check — do not
 * try to split the fill (see `lineCache.ts`).
 */

/**
 * Composite alpha the prefix stroke would be drawn at this frame, as the
 * `alpha` argument for `scrollLayerUsable`. Returns 1 only when the whole
 * line pipeline is at full opacity *and* untransformed, i.e. when
 * compositing a pre-recorded picture is pixel-identical to drawing live:
 *
 * - `chartReveal < 1` — the reveal morph / loading / empty crossfade. The
 *   line is drawn at a breathing alpha, in a blended color, and its geometry
 *   depends on `now_ms`; `drawLine` also bypasses the path cache entirely
 *   there, so there is no stable prefix to record.
 * - `scrubAmount > 0` — the scrub draws the line twice under two clips, the
 *   right-hand one dimmed. A single translated picture cannot express that.
 *   `scrubAmount` snaps to exactly 0 (helpers.ts's `updateHoverState`), so
 *   this re-enables cleanly rather than asymptoting.
 * - `shakeAmplitude > 0` — the degen shake translates the whole frame by a
 *   fresh random offset. `drawFrame` zeroes the amplitude below its own
 *   threshold, so any non-zero value here means a translate is applied this
 *   frame and the scroll layer (outside that translate) would tear away
 *   from the rest of the chart.
 *
 * Returns 0, not the true fractional alpha: `scrollLayerUsable` only ever
 * asks "is this >= 1", and inventing a partial alpha would suggest the
 * layer could be faded, which `ctx.drawPicture` cannot do (see
 * `scrollLayer.ts` invariant 1).
 */
export function lineScrollLayerAlpha(
  chartReveal: number,
  scrubAmount: number,
  shakeAmplitude: number
): number {
  'worklet';
  if (chartReveal < 1) return 0;
  if (scrubAmount > 0) return 0;
  if (shakeAmplitude > 0) return 0;
  return 1;
}

/**
 * Writes this frame's candidate key for the prefix picture: begin, then one
 * push per dimension, unconditionally and always in this order (the push
 * order *is* the field identity — see the doc comment on
 * `ScrollLayerSlot`).
 *
 * The key is the line cache slot's **committed** key, verbatim, plus what a
 * picture bakes that a path does not (stroke color and width) plus
 * `pad.left`. Keying off the committed key rather than off this frame's raw
 * inputs is the point: the recorded picture is a rendering of
 * `slot.prefix`, so it is stale exactly when `slot.prefix` has been rebuilt,
 * and `slot.kFoo` is precisely the identity `slot.prefix` was built from.
 * Re-deriving the same dimensions from `layout`/`visible` would be a second
 * copy of `lineCacheHits` that could drift from the first.
 *
 * `pad.left` is the one dimension the line cache deliberately omits (it is a
 * pure x-shift, absorbed by `dx`) but this layer needs: the composite clip
 * is baked into the recording at `pad.left - 1`, so a padding change must
 * re-record.
 */
export function writeLineScrollKey<Picture>(
  slot: ScrollLayerSlot<Picture>,
  lineSlot: LineCacheSlot,
  padLeft: number,
  palette: LivelinePalette
): void {
  'worklet';
  scrollLayerBeginKey(slot);
  scrollLayerPushNum(slot, lineSlot.kDataRev);
  scrollLayerPushNum(slot, lineSlot.kDataSource);
  scrollLayerPushNum(slot, lineSlot.kLen);
  scrollLayerPushNum(slot, lineSlot.kFirstT);
  scrollLayerPushNum(slot, lineSlot.kLastT);
  scrollLayerPushNum(slot, lineSlot.kLastV);
  scrollLayerPushNum(slot, lineSlot.kMin);
  scrollLayerPushNum(slot, lineSlot.kMax);
  scrollLayerPushNum(slot, lineSlot.kWindow);
  scrollLayerPushNum(slot, lineSlot.kH);
  scrollLayerPushNum(slot, lineSlot.kPadTop);
  scrollLayerPushNum(slot, lineSlot.kPadBottom);
  scrollLayerPushNum(slot, lineSlot.kChartW);
  scrollLayerPushNum(slot, padLeft);
  scrollLayerPushNum(slot, palette.lineWidth);
  scrollLayerPushRef(slot, palette.line);
}
