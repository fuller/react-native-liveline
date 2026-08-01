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
 * True when the prefix stroke may be composited from a pre-recorded picture
 * this frame — i.e. when the whole line pipeline is at full opacity *and*
 * untransformed, so compositing is pixel-identical to drawing live. Three
 * things disqualify a frame:
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
 * A boolean, not an alpha: the first two conditions are opacity conditions
 * and the third is a transform condition, and `scrollLayerUsable` only ever
 * asks "is this >= 1" anyway. Returning a fraction would suggest the layer
 * could be faded, which `ctx.drawPicture` cannot do (see `scrollLayer.ts`'s
 * alpha invariant).
 */
export function canCompositeLineScroll(
  chartReveal: number,
  scrubAmount: number,
  shakeAmplitude: number
): boolean {
  'worklet';
  if (chartReveal < 1) return false;
  if (scrubAmount > 0) return false;
  if (shakeAmplitude > 0) return false;
  return true;
}
/**
 * Writes this frame's candidate key for the prefix picture: begin, then one
 * push per dimension, unconditionally and always in this order (the push
 * order *is* the field identity — see the doc comment on
 * `ScrollLayerSlot`).
 *
 * Four dimensions, and no more, because the picture is a rendering of
 * `lineSlot.prefix` and the only question worth asking is **"has that prefix
 * been rebuilt since I recorded it?"** `lineSlot.buildRev` answers exactly
 * that, in one number, from the one place `prefix` is written. Copying the 13
 * `kFoo` dimensions of `lineCacheHits` in here instead would re-derive the
 * same answer from a mirror that silently misses any 14th dimension added to
 * the line cache later.
 *
 * The other three are what a *picture* bakes that the path did not:
 *
 * - `palette.lineWidth` / `palette.line` — stroke geometry and color are
 *   recorded into the picture; the cached path carries neither.
 * - `pad.left` — deliberately omitted from the line cache's key (it is a
 *   pure x-shift, absorbed by `dx`), but the composite clip is baked into
 *   this recording at `pad.left - 1`, so a padding change must re-record.
 */
export function writeLineScrollKey<Picture>(
  slot: ScrollLayerSlot<Picture>,
  lineSlot: LineCacheSlot,
  padLeft: number,
  palette: LivelinePalette
): void {
  'worklet';
  scrollLayerBeginKey(slot);
  scrollLayerPushNum(slot, lineSlot.buildRev);
  scrollLayerPushNum(slot, padLeft);
  scrollLayerPushNum(slot, palette.lineWidth);
  scrollLayerPushRef(slot, palette.line);
}
