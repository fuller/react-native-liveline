import { Skia, type SkPicture } from '@shopify/react-native-skia';
import type { ChartLayout, LivelinePalette, LivelineFonts } from '../types';
import { createCanvas2D, type SkiaCache } from '../draw/canvas2d';
import { strokeLinePath } from '../draw/line';
import { linePrefixPath, type LineCacheSlot } from '../draw/lineCache';
import {
  scrollLayerBuilt,
  scrollLayerKeyHits,
  type ScrollLayerSlot,
} from '../draw/scrollLayer';
import { writeLineScrollKey } from '../draw/lineScrollLayer';

/**
 * Keeps `slot.picture` — the line's prefix stroke, recorded once in
 * build-time screen coordinates — up to date, so the declarative shell can
 * composite it under a `<Group transform={[{ translateX: dx }]}>` instead of
 * re-stroking it every frame.
 *
 * Mirrors `engine/gridLayer.ts` (key check → record → commit); the pure half
 * — the gate and the key — lives in `draw/lineScrollLayer.ts`.
 *
 * ## Rebuild timing
 *
 * Called *before* `drawFrame`, and only on frames where `lineCacheHits` has
 * already reported a hit, so `lineSlot.prefix` is this frame's prefix and
 * the picture recorded from it is valid for this frame's own composite. The
 * consequence is that the frame which *misses* — the one where `drawLine`
 * rebuilds the prefix — draws the whole line live (no split, empty scroll
 * layer), and the re-record happens on the next frame instead. That is one
 * re-record per cache miss either way, and it keeps the ordering trivially
 * safe: the picture is never recorded from a prefix that the frame's own
 * screen pass has already moved past.
 *
 * ## Why the clip is baked in, not applied at composite time
 *
 * The composite is a Skia `<Group transform>` node in the declarative tree,
 * which applies a matrix and nothing else; clipping there would mean another
 * node whose rect changes with layout. So `drawLine`'s clip is recorded into
 * the picture instead, in build-time coordinates.
 *
 * That is sound here specifically because the layer only ever moves
 * *horizontally*:
 *
 * - The top/bottom clip edges are horizontal lines; translating in x leaves
 *   them exactly where the live clip would put them. They are what actually
 *   matters — `drawLine`'s clip exists to trim the stroke's half-width when
 *   a range lerp pins the line to the chart edge.
 * - The right clip edge travels left with the content, but the prefix ends
 *   at `cutX`, which is always well left of it (the tail and the live tip
 *   sit between `cutX` and the plot's right edge), so it can never reach the
 *   content.
 * - The left clip edge likewise travels left, letting through content that
 *   the live clip would have trimmed — but everything left of `pad.left` is
 *   erased outright by `drawEdgeFade`'s `destination-out` pass in the screen
 *   picture, which composites over the scroll layer because the two pictures
 *   share one surface (a transform-only `<Group>` creates no layer).
 *
 * Uses its own `SkiaCache` for the same reason `engine/gridLayer.ts` does:
 * createCanvas2D's pooled paths/paints are only safe to reuse when each
 * recording builds and flushes before the next starts, and sharing the main
 * frame's cache across a nested recording would make that an assumption
 * rather than a guarantee.
 */
export function updateLineScrollLayer(
  slot: ScrollLayerSlot<SkPicture>,
  lineSlot: LineCacheSlot,
  layout: ChartLayout,
  palette: LivelinePalette,
  layerCache: SkiaCache,
  fonts: LivelineFonts
): void {
  'worklet';
  writeLineScrollKey(slot, lineSlot, layout.pad.left, palette);
  if (scrollLayerKeyHits(slot)) return;

  const prefix = linePrefixPath(lineSlot);
  if (prefix === null) return;

  const recorder = Skia.PictureRecorder();
  // NO cull rect on purpose. `beginRecording(rect)` installs an
  // SkRTreeFactory BBH and culls at record time against that rect
  // (JsiSkPictureRecorder.h:36-38); the no-argument form uses a 2,000,000²
  // rect and a nullptr BBH. Record-time culling is wrong for content that is
  // translated *afterwards* — geometry culled against build-time bounds can
  // be exactly the geometry the transform brings back on screen. The screen
  // picture keeps its cull rect (it is never transformed); this one must not
  // have one.
  const canvas = recorder.beginRecording();
  const subCtx = createCanvas2D(canvas, fonts, layerCache);
  // Same clip `drawLine` puts around the combined path — see the header.
  subCtx.clipRect(
    layout.pad.left - 1,
    layout.pad.top,
    layout.chartW + 2,
    layout.chartH
  );
  // lineAlpha 1 and no color override: the gate in draw/lineScrollLayer.ts
  // guarantees chartReveal >= 1, which is exactly when `drawLine` strokes at
  // alpha 1 in the unblended `palette.line`.
  strokeLinePath(subCtx, palette, prefix, 1);

  // No position reference is stored on the slot: the picture is a rendering
  // of `lineSlot.prefix`, so the caller translates it with
  // `lineScrollDx(lineSlot, layout)` — the same number `assembleLineTail`
  // offsets the path by, so the two cannot disagree.
  scrollLayerBuilt(slot, recorder.finishRecordingAsPicture());
}
