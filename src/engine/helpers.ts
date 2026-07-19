import type { LivelinePoint, ChartLayout, Padding, HoverPoint } from '../types';
import { lerp } from '../math/lerp';
import { computeRange } from '../math/range';
import { interpolateAtTime } from '../math/interpolate';
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
  wt: WindowTransState,
  displayWindow: number,
  displayMin: number,
  displayMax: number,
  noMotion: boolean,
  now_ms: number,
  now: number,
  points: LivelinePoint[],
  smoothValue: number,
  buffer: number
): { windowSecs: number; windowTransProgress: number } {
  'worklet';
  if (wt.to !== cfg.windowSecs) {
    wt.from = displayWindow;
    wt.to = cfg.windowSecs;
    wt.startMs = now_ms;
    wt.rangeFromMin = displayMin;
    wt.rangeFromMax = displayMax;
    const targetRightEdge = now + cfg.windowSecs * buffer;
    const targetLeftEdge = targetRightEdge - cfg.windowSecs;
    const targetVisible: LivelinePoint[] = [];
    for (const p of points) {
      if (p.time >= targetLeftEdge - 2 && p.time <= targetRightEdge) {
        targetVisible.push(p);
      }
    }
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
    const eased = (1 - Math.cos(t * Math.PI)) / 2;
    windowTransProgress = eased;
    const logFrom = Math.log(wt.from);
    const logTo = Math.log(wt.to);
    resultWindow = Math.exp(logFrom + (logTo - logFrom) * eased);
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
  computedRange: { min: number; max: number },
  rangeInited: boolean,
  targetMin: number,
  targetMax: number,
  displayMin: number,
  displayMax: number,
  isTransitioning: boolean,
  windowTransProgress: number,
  wt: WindowTransState,
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
  if (!rangeInited) {
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

/** Compute hover position, interpolated value, and scrub amount. */
export function updateHoverState(
  hoverPixelX: number | null,
  pad: Required<Padding>,
  w: number,
  layout: ChartLayout,
  now: number,
  visible: LivelinePoint[],
  scrubAmount: number,
  lastHover: { x: number; value: number; time: number } | null,
  noMotion: boolean,
  leftEdge: number,
  rightEdge: number,
  chartW: number
): HoverStateResult {
  'worklet';
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
