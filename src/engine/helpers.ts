import type { LivelinePoint, ChartLayout, Padding, HoverPoint } from '../types';
import { lerp } from '../math/lerp';
import { computeRange } from '../math/range';
import { interpolateAtTime } from '../math/interpolate';
import { easeInOutCos, logLerp } from '../math/ease';
import { filterVisiblePoints } from '../math/visible';
import type { EngineConfigStep } from './types';
import {
  ADAPTIVE_SPEED_BOOST,
  SCRUB_LERP_SPEED,
  WINDOW_TRANSITION_MS,
} from './constants';

// --- Extracted helper functions (pure computation, called inside the frame worklet) ---

export interface WindowTransState {
  from: number;
  to: number;
  startMs: number;
  rangeFromMin: number;
  rangeFromMax: number;
  rangeToMin: number;
  rangeToMax: number;
}

/**
 * The slice of `EngineState` the window transition reads and writes. Declared
 * as its own narrow interface rather than taking `EngineState` itself: these
 * helpers get handed the engine state object directly (structural typing —
 * `engineStep` just passes `s`), so no allocation is involved, but the
 * signature still says exactly which four fields are in play.
 */
export interface WindowTransInputs {
  windowTransition: WindowTransState;
  displayWindow: number;
  displayMin: number;
  displayMax: number;
}

/** The slice of `EngineState` the Y-range smoothing reads. Same rationale as
 * `WindowTransInputs`. The updated values come back on the result object,
 * which the caller writes back — unchanged from before. */
export interface RangeInputs {
  windowTransition: WindowTransState;
  rangeInited: boolean;
  targetMin: number;
  targetMax: number;
  displayMin: number;
  displayMax: number;
}

/** Lerp display value with adaptive speed — slow for big jumps, fast for small ticks. */
export function computeAdaptiveSpeed(
  value: number,
  displayValue: number,
  displayMin: number,
  displayMax: number,
  lerpSpeed: number,
  noMotion: boolean
): number {
  'worklet';
  const valGap = Math.abs(value - displayValue);
  const prevRange = displayMax - displayMin || 1;
  const gapRatio = Math.min(valGap / prevRange, 1);
  return noMotion ? 1 : lerpSpeed + (1 - gapRatio) * ADAPTIVE_SPEED_BOOST;
}

/** Update window transition state, returning current display window and transition progress. */
export function updateWindowTransition(
  cfg: EngineConfigStep,
  /** The engine state — see `WindowTransInputs`. `windowTransition` is
   * mutated in place, exactly as the old `wt` argument was. */
  s: WindowTransInputs,
  noMotion: boolean,
  now_ms: number,
  now: number,
  points: LivelinePoint[],
  smoothValue: number,
  buffer: number
): { windowSecs: number; windowTransProgress: number } {
  'worklet';
  const wt = s.windowTransition;
  const displayMin = s.displayMin;
  const displayMax = s.displayMax;
  if (wt.to !== cfg.windowSecs) {
    wt.from = s.displayWindow;
    wt.to = cfg.windowSecs;
    wt.startMs = now_ms;
    wt.rangeFromMin = displayMin;
    wt.rangeFromMax = displayMax;
    const targetRightEdge = now + cfg.windowSecs * buffer;
    const targetLeftEdge = targetRightEdge - cfg.windowSecs;
    const targetVisible = filterVisiblePoints(
      points,
      targetLeftEdge,
      targetRightEdge
    );
    if (targetVisible.length > 0) {
      const targetRange = computeRange(
        targetVisible,
        smoothValue,
        cfg.referenceLine?.value,
        cfg.exaggerate
      );
      wt.rangeToMin = targetRange.min;
      wt.rangeToMax = targetRange.max;
    }
  }

  let windowTransProgress = 0;
  let resultWindow: number;
  if (noMotion || wt.startMs === 0) {
    resultWindow = cfg.windowSecs;
  } else {
    const elapsed = now_ms - wt.startMs;
    const duration = WINDOW_TRANSITION_MS;
    const t = Math.min(elapsed / duration, 1);
    const eased = easeInOutCos(t);
    windowTransProgress = eased;
    resultWindow = logLerp(wt.from, wt.to, eased);
    if (t >= 1) {
      resultWindow = cfg.windowSecs;
      wt.startMs = 0;
      windowTransProgress = 0;
    }
  }

  return { windowSecs: resultWindow, windowTransProgress };
}

/** Smooth Y range with lerp. During window transitions, interpolates between pre-computed ranges. */
export function updateRange(
  /** The engine state — see `RangeInputs`. Read only; the new values come
   * back on the result object for the caller to write back. */
  s: RangeInputs,
  computedRange: { min: number; max: number },
  isTransitioning: boolean,
  windowTransProgress: number,
  adaptiveSpeed: number,
  chartH: number,
  dt: number
): {
  minVal: number;
  maxVal: number;
  valRange: number;
  targetMin: number;
  targetMax: number;
  displayMin: number;
  displayMax: number;
  rangeInited: boolean;
} {
  'worklet';
  const wt = s.windowTransition;
  let targetMin = s.targetMin;
  let targetMax = s.targetMax;
  let displayMin = s.displayMin;
  let displayMax = s.displayMax;
  if (!s.rangeInited) {
    return {
      minVal: computedRange.min,
      maxVal: computedRange.max,
      valRange: computedRange.max - computedRange.min || 0.001,
      targetMin: computedRange.min,
      targetMax: computedRange.max,
      displayMin: computedRange.min,
      displayMax: computedRange.max,
      rangeInited: true,
    };
  }

  if (isTransitioning) {
    displayMin =
      wt.rangeFromMin + (wt.rangeToMin - wt.rangeFromMin) * windowTransProgress;
    displayMax =
      wt.rangeFromMax + (wt.rangeToMax - wt.rangeFromMax) * windowTransProgress;
    targetMin = computedRange.min;
    targetMax = computedRange.max;
  } else {
    const curRange = displayMax - displayMin;
    targetMin = computedRange.min;
    targetMax = computedRange.max;
    displayMin = lerp(displayMin, targetMin, adaptiveSpeed, dt);
    displayMax = lerp(displayMax, targetMax, adaptiveSpeed, dt);
    const pxThreshold = (0.5 * curRange) / chartH || 0.001;
    if (Math.abs(displayMin - targetMin) < pxThreshold) displayMin = targetMin;
    if (Math.abs(displayMax - targetMax) < pxThreshold) displayMax = targetMax;
  }

  return {
    minVal: displayMin,
    maxVal: displayMax,
    valRange: displayMax - displayMin || 0.001,
    targetMin,
    targetMax,
    displayMin,
    displayMax,
    rangeInited: true,
  };
}

export interface HoverStateResult {
  hoverX: number | null;
  hoverValue: number | null;
  hoverTime: number | null;
  scrubAmount: number;
  isActiveHover: boolean;
  lastHover: { x: number; value: number; time: number } | null;
  /** Point to emit through onHover (null = don't emit this frame) */
  emitPoint: HoverPoint | null;
}

/**
 * Compute hover position, interpolated value, and scrub amount.
 *
 * Took `pad`, `w`, `leftEdge`, `rightEdge` and `chartW` as five extra
 * positional arguments alongside `layout` — every one of them a field of the
 * `layout` it was handed (see `makeLayout`, which is built from exactly those
 * values). Reading them off `layout` costs nothing, removes five arguments,
 * and makes it impossible to hand this function a layout and a set of edges
 * that disagree.
 */
export function updateHoverState(
  hoverPixelX: number | null,
  layout: ChartLayout,
  now: number,
  visible: LivelinePoint[],
  scrubAmount: number,
  lastHover: { x: number; value: number; time: number } | null,
  noMotion: boolean
): HoverStateResult {
  'worklet';
  const { pad, w, leftEdge, rightEdge, chartW } = layout;
  let hoverValue: number | null = null;
  let hoverTime: number | null = null;
  let hoverChartX: number | null = null;
  let isActiveHover = false;
  let emitPoint: HoverPoint | null = null;

  if (
    hoverPixelX !== null &&
    hoverPixelX >= pad.left &&
    hoverPixelX <= w - pad.right
  ) {
    const maxHoverX = layout.toX(now);
    const clampedX = Math.min(hoverPixelX, maxHoverX);
    const t =
      leftEdge + ((clampedX - pad.left) / chartW) * (rightEdge - leftEdge);
    const v = interpolateAtTime(visible, t);
    if (v !== null) {
      hoverValue = v;
      hoverTime = t;
      hoverChartX = clampedX;
      isActiveHover = true;
      lastHover = { x: clampedX, value: v, time: t };
      emitPoint = { time: t, value: v, x: clampedX, y: layout.toY(v) };
    }
  }

  // Lerp scrub amount
  const scrubTarget = isActiveHover ? 1 : 0;
  if (noMotion) {
    scrubAmount = scrubTarget;
  } else {
    scrubAmount += (scrubTarget - scrubAmount) * SCRUB_LERP_SPEED;
    if (scrubAmount < 0.01) scrubAmount = 0;
    if (scrubAmount > 0.99) scrubAmount = 1;
  }

  // Use last known position during fade-out
  let drawHoverX = hoverChartX;
  let drawHoverValue = hoverValue;
  let drawHoverTime = hoverTime;
  if (!isActiveHover && scrubAmount > 0 && lastHover) {
    drawHoverX = lastHover.x;
    drawHoverValue = lastHover.value;
    drawHoverTime = lastHover.time;
  }

  return {
    hoverX: drawHoverX,
    hoverValue: drawHoverValue,
    hoverTime: drawHoverTime,
    scrubAmount,
    isActiveHover,
    lastHover,
    emitPoint,
  };
}

/** The three range fields `makeLayout` reads — structurally satisfied by
 * both `updateRange`'s and `updateCandleRange`'s result objects. */
export interface LayoutRange {
  minVal: number;
  maxVal: number;
  valRange: number;
}

/**
 * Build the per-frame `ChartLayout` shared by all three pipelines (line,
 * candle, multi-series). Previously this exact literal — closures included
 * — was written out three times in `engine/step.ts`.
 *
 * `toX`/`toY` stay closures on purpose: one allocation per frame per chart,
 * which is what the inline literals already did. Do NOT "optimize" them
 * into a shared object with mutable captured state — the three pipelines
 * would alias each other's edges and range.
 */
export function makeLayout(
  w: number,
  h: number,
  pad: Required<Padding>,
  chartW: number,
  chartH: number,
  leftEdge: number,
  rightEdge: number,
  range: LayoutRange
): ChartLayout {
  'worklet';
  const { minVal, maxVal, valRange } = range;
  return {
    w,
    h,
    pad,
    chartW,
    chartH,
    leftEdge,
    rightEdge,
    minVal,
    maxVal,
    valRange,
    toX: (t: number) =>
      pad.left + ((t - leftEdge) / (rightEdge - leftEdge)) * chartW,
    toY: (v: number) => pad.top + (1 - (v - minVal) / valRange) * chartH,
  };
}
