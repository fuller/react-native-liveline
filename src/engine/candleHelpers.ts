import type { CandlePoint, ChartLayout } from '../types';
import { lerp } from '../math/lerp';
import {
  RANGE_LERP_SPEED,
  RANGE_ADAPTIVE_BOOST,
  WINDOW_TRANSITION_MS,
} from './constants';

// --- Candle-specific helper functions ---

export function computeCandleRange(candles: CandlePoint[]): {
  min: number;
  max: number;
} {
  'worklet';
  let min = Infinity;
  let max = -Infinity;
  for (const c of candles) {
    if (c.low < min) min = c.low;
    if (c.high > max) max = c.high;
  }
  if (!isFinite(min) || !isFinite(max)) return { min: 99, max: 101 };
  const range = max - min;
  const margin = range * 0.12;
  const minRange = range * 0.1 || 0.4;
  if (range < minRange) {
    const mid = (min + max) / 2;
    return { min: mid - minRange / 2, max: mid + minRange / 2 };
  }
  return { min: min - margin, max: max + margin };
}

export function candleAtX(
  candles: CandlePoint[],
  hoverX: number,
  candleWidth: number,
  layout: ChartLayout
): CandlePoint | null {
  'worklet';
  const time =
    layout.leftEdge +
    ((hoverX - layout.pad.left) / layout.chartW) *
      (layout.rightEdge - layout.leftEdge);
  let lo = 0;
  let hi = candles.length - 1;
  while (lo <= hi) {
    // eslint-disable-next-line no-bitwise
    const mid = (lo + hi) >> 1;
    const c = candles[mid]!;
    if (time < c.time) hi = mid - 1;
    else if (time >= c.time + candleWidth) lo = mid + 1;
    else return c;
  }
  return null;
}

/** Smooth Y range for candle mode — adaptive speed, no target tracking. */
export function updateCandleRange(
  computedRange: { min: number; max: number },
  rangeInited: boolean,
  displayMin: number,
  displayMax: number,
  isTransitioning: boolean,
  windowTransProgress: number,
  wt: {
    rangeFromMin: number;
    rangeFromMax: number;
    rangeToMin: number;
    rangeToMax: number;
  },
  chartH: number,
  dt: number
): {
  minVal: number;
  maxVal: number;
  valRange: number;
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
  } else {
    const curRange = displayMax - displayMin || 1;
    const gapMin = Math.abs(displayMin - computedRange.min);
    const gapMax = Math.abs(displayMax - computedRange.max);
    const gapRatio = Math.min((gapMin + gapMax) / curRange, 1);
    const speed = RANGE_LERP_SPEED + (1 - gapRatio) * RANGE_ADAPTIVE_BOOST;

    displayMin = lerp(displayMin, computedRange.min, speed, dt);
    displayMax = lerp(displayMax, computedRange.max, speed, dt);
    const pxThreshold = (0.5 * curRange) / chartH || 0.001;
    if (Math.abs(displayMin - computedRange.min) < pxThreshold)
      displayMin = computedRange.min;
    if (Math.abs(displayMax - computedRange.max) < pxThreshold)
      displayMax = computedRange.max;
  }

  return {
    minVal: displayMin,
    maxVal: displayMax,
    valRange: displayMax - displayMin || 0.001,
    displayMin,
    displayMax,
    rangeInited: true,
  };
}

/** Candle window transition — uses candle data instead of line points. */
export function updateCandleWindowTransition(
  targetWindowSecs: number,
  wt: {
    from: number;
    to: number;
    startMs: number;
    rangeFromMin: number;
    rangeFromMax: number;
    rangeToMin: number;
    rangeToMax: number;
  },
  displayWindow: number,
  displayMin: number,
  displayMax: number,
  now_ms: number,
  now: number,
  candles: CandlePoint[],
  liveCandle: CandlePoint | undefined,
  candleWidth: number,
  buffer: number
): { windowSecs: number; windowTransProgress: number } {
  'worklet';
  if (wt.to !== targetWindowSecs) {
    wt.from = displayWindow;
    wt.to = targetWindowSecs;
    wt.startMs = now_ms;
    wt.rangeFromMin = displayMin;
    wt.rangeFromMax = displayMax;
    const targetRightEdge = now + targetWindowSecs * buffer;
    const targetLeftEdge = targetRightEdge - targetWindowSecs;
    const targetVisible: CandlePoint[] = [];
    for (const c of candles) {
      if (c.time + candleWidth >= targetLeftEdge && c.time <= targetRightEdge) {
        targetVisible.push(c);
      }
    }
    if (
      liveCandle &&
      liveCandle.time + candleWidth >= targetLeftEdge &&
      liveCandle.time <= targetRightEdge
    ) {
      targetVisible.push(liveCandle);
    }
    if (targetVisible.length > 0) {
      const tr = computeCandleRange(targetVisible);
      wt.rangeToMin = tr.min;
      wt.rangeToMax = tr.max;
    }
  }

  let windowTransProgress = 0;
  let resultWindow: number;
  if (wt.startMs === 0) {
    resultWindow = targetWindowSecs;
  } else {
    const elapsed = now_ms - wt.startMs;
    const t = Math.min(elapsed / WINDOW_TRANSITION_MS, 1);
    const eased = (1 - Math.cos(t * Math.PI)) / 2;
    windowTransProgress = eased;
    const logFrom = Math.log(wt.from);
    const logTo = Math.log(wt.to);
    resultWindow = Math.exp(logFrom + (logTo - logFrom) * eased);
    if (t >= 1) {
      resultWindow = targetWindowSecs;
      wt.startMs = 0;
      windowTransProgress = 0;
    }
  }

  return { windowSecs: resultWindow, windowTransProgress };
}
