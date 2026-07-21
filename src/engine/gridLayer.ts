import { Skia, type SkPicture } from '@shopify/react-native-skia';
import type { ChartLayout, LivelinePalette, LivelineFonts } from '../types';
import { createCanvas2D, type SkiaCache } from '../draw/canvas2d';
import { drawGrid, type GridState } from '../draw/grid';
import {
  gridLayerKeyMatches,
  writeGridLayerKey,
  type GridLayerSlot,
} from '../draw/gridLayer';
import { QUIESCENT_FRAME_THRESHOLD } from './constants';

/**
 * Keeps `slot.picture` up to date, re-recording the grid into its own
 * SkPicture only when the key has changed or hasn't yet settled for
 * QUIESCENT_FRAME_THRESHOLD frames — otherwise every frame reuses the last
 * recorded picture as-is (composited by the caller via `ctx.drawPicture`).
 *
 * `gridState`'s label fades still run every frame the layer is unsettled
 * (exactly as they do without this cache), so the crossfade animation is
 * unaffected — this only skips the *replay* of gridline/label draw calls
 * once the fades have converged.
 *
 * Uses its own dedicated `SkiaCache` (not the main frame's) — createCanvas2D's
 * pooled path/paints are only safe to reuse when each recording that touches
 * them fully builds-and-flushes before the next one starts, which a shared
 * cache across the main ctx and this sub-layer's ctx would ride on as an
 * undocumented invariant rather than guarantee.
 */
export function updateGridLayer(
  slot: GridLayerSlot<SkPicture>,
  gridState: GridState,
  layout: ChartLayout,
  palette: LivelinePalette,
  formatValue: (v: number) => string,
  dt: number,
  gridCache: SkiaCache,
  fonts: LivelineFonts
): void {
  'worklet';
  const hit = gridLayerKeyMatches(slot, layout, palette, formatValue);
  if (hit && slot.settledFrames > QUIESCENT_FRAME_THRESHOLD) {
    slot.settledFrames++;
    return;
  }

  const recorder = Skia.PictureRecorder();
  const canvas = recorder.beginRecording(
    Skia.XYWHRect(0, 0, layout.w, layout.h)
  );
  const subCtx = createCanvas2D(canvas, fonts, gridCache);
  drawGrid(subCtx, layout, palette, formatValue, gridState, dt);
  slot.picture = recorder.finishRecordingAsPicture();
  writeGridLayerKey(slot, layout, palette, formatValue);
  slot.settledFrames = hit ? slot.settledFrames + 1 : 0;
}
