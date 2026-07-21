import type { ChartLayout, LivelinePalette } from '../types';

/**
 * Cross-frame cache for the grid layer (gridlines + Y-axis value labels).
 *
 * Unlike the line spline or the time axis, gridlines are positioned purely
 * by value (Y-range) — they never need to scroll horizontally, so this is a
 * simple "rebuild only when the key changes" cache (the same shape as the
 * badge pill cache in engine/badge.ts), not a translate-based one.
 *
 * Kept Skia-free (only a structural `SkPicture | null` reference) so jest
 * can exercise the key-comparison logic directly, the same way
 * draw/lineCache.ts does.
 */

export interface GridLayerSlot<Picture> {
  picture: Picture | null;
  /** Consecutive frames the key has matched. Compared against
   * QUIESCENT_FRAME_THRESHOLD by the caller — grid label fades are
   * documented (engine/quiescence.ts) to converge well under that many
   * frames, so reusing it here isn't a new magic number. */
  settledFrames: number;

  // Invalidation key — flat values only, compared field-by-field so a
  // per-frame check allocates nothing.
  kMinVal: number;
  kMaxVal: number;
  kW: number;
  kH: number;
  kPadTop: number;
  kPadBottom: number;
  kPadLeft: number;
  kPadRight: number;
  kGridLine: string;
  kGridLabel: string;
  kFormatValue: ((v: number) => string) | null; // reference equality
}

export function createGridLayerSlot<Picture>(): GridLayerSlot<Picture> {
  'worklet';
  return {
    picture: null,
    settledFrames: 0,
    kMinVal: 0,
    kMaxVal: 0,
    kW: 0,
    kH: 0,
    kPadTop: 0,
    kPadBottom: 0,
    kPadLeft: 0,
    kPadRight: 0,
    kGridLine: '',
    kGridLabel: '',
    kFormatValue: null,
  };
}

/** True when every key field already matches this frame's inputs. */
export function gridLayerKeyMatches<Picture>(
  slot: GridLayerSlot<Picture>,
  layout: ChartLayout,
  palette: LivelinePalette,
  formatValue: (v: number) => string
): boolean {
  'worklet';
  return (
    slot.picture !== null &&
    slot.kMinVal === layout.minVal &&
    slot.kMaxVal === layout.maxVal &&
    slot.kW === layout.w &&
    slot.kH === layout.h &&
    slot.kPadTop === layout.pad.top &&
    slot.kPadBottom === layout.pad.bottom &&
    slot.kPadLeft === layout.pad.left &&
    slot.kPadRight === layout.pad.right &&
    slot.kGridLine === palette.gridLine &&
    slot.kGridLabel === palette.gridLabel &&
    slot.kFormatValue === formatValue
  );
}

/** Writes this frame's inputs into the slot's key (call on a rebuild). */
export function writeGridLayerKey<Picture>(
  slot: GridLayerSlot<Picture>,
  layout: ChartLayout,
  palette: LivelinePalette,
  formatValue: (v: number) => string
): void {
  'worklet';
  slot.kMinVal = layout.minVal;
  slot.kMaxVal = layout.maxVal;
  slot.kW = layout.w;
  slot.kH = layout.h;
  slot.kPadTop = layout.pad.top;
  slot.kPadBottom = layout.pad.bottom;
  slot.kPadLeft = layout.pad.left;
  slot.kPadRight = layout.pad.right;
  slot.kGridLine = palette.gridLine;
  slot.kGridLabel = palette.gridLabel;
  slot.kFormatValue = formatValue;
}
