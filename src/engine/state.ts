import type { LivelinePoint, LivelinePalette, CandlePoint } from '../types';
import type { ArrowState, ShakeState } from '../draw';
import type { GridState } from '../draw/grid';
import type { TimeAxisState } from '../draw/timeAxis';
import { createOrderbookState, type OrderbookState } from '../draw/orderbook';
import { createParticleState, type ParticleState } from '../draw/particles';
import { createShakeState } from '../draw';
import type { WindowTransState } from './helpers';
import type { EngineConfigStep } from './types';

export interface BadgeState {
  displayW: number; // current lerped text width (0 = uninited)
  targetW: number;
  y: number | null; // lerped badge Y, null = uninited
  green: number; // momentum color blend 0 (red) → 1 (green)
}

export interface StashedSeries {
  id: string;
  data: LivelinePoint[];
  value: number;
  palette: LivelinePalette;
  label?: string;
}

/**
 * Mutable per-chart engine state. Created lazily on the UI thread inside
 * the frame worklet (Maps and object graphs stay native to the UI runtime;
 * the JS thread never reads this object).
 */
export interface EngineState {
  displayValue: number;
  displayValues: Map<string, number>;
  seriesAlpha: Map<string, number>;
  displayMin: number;
  displayMax: number;
  targetMin: number;
  targetMax: number;
  rangeInited: boolean;
  displayWindow: number;
  windowTransition: WindowTransState;
  arrowState: ArrowState;
  gridState: GridState;
  timeAxisState: TimeAxisState;
  orderbookState: OrderbookState;
  particleState: ParticleState;
  shakeState: ShakeState;
  badge: BadgeState;

  // Hover state
  scrubAmount: number;
  lastHover: { x: number; value: number; time: number } | null;
  lastHoverEntries: { color: string; label: string; value: number }[];
  /**
   * Last (time, value) delivered through onHover, used to skip re-emitting
   * an unchanged point every frame while a finger rests on the chart —
   * runOnJS traffic should be event-shaped (like the web version's
   * mousemove-driven onHover), not frame-shaped. null = nothing emitted
   * since the last hover ended.
   */
  lastEmitHover: { time: number; value: number } | null;

  // Reveal state (loading → chart morph)
  chartReveal: number;

  // Pause state
  pauseProgress: number;
  timeDebt: number; // accumulated seconds behind real time

  // Data stash for reverse morph (chart → flat line when data disappears)
  lastData: LivelinePoint[];
  lastMultiSeries: StashedSeries[];
  frozenNow: number;

  // Pause data snapshot — freeze visible data when pausing to prevent
  // consumer-side pruning from eroding the left edge of the line
  pausedData: LivelinePoint[] | null;
  pausedMultiData: Map<string, { data: LivelinePoint[]; value: number }> | null;

  // Loading ↔ empty crossfade
  loadingAlpha: number;

  // --- Candle mode state (only used when mode='candle') ---
  displayCandle: CandlePoint | null;
  liveBirthAlpha: number;
  liveBull: number;
  lineSmoothClose: number;
  lineSmoothInited: boolean;
  closeLineSmooth: number;
  closeLineSmoothInited: boolean;
  lineModeProg: number;
  lineModeTrans: { startMs: number; from: number; to: number };
  lineDensityProg: number;
  lineDensityTrans: { startMs: number; from: number; to: number };
  lineTickSmooth: number;
  lineTickSmoothInited: boolean;
  candleWidthTrans: {
    fromWidth: number;
    toWidth: number;
    startMs: number;
    rangeFromMin: number;
    rangeFromMax: number;
    rangeToMin: number;
    rangeToMax: number;
    oldCandles: CandlePoint[];
    oldWidth: number;
  };
  prevCandleData: { candles: CandlePoint[]; width: number };
  pausedCandles: CandlePoint[] | null;
  pausedLive: CandlePoint | null;
  pausedLineData: LivelinePoint[] | null;
  pausedLineValue: number | null;
  lastCandles: CandlePoint[];
  lastLive: CandlePoint | null;
  lastLineDataStash: LivelinePoint[];
  lastLineValueStash: number | undefined;

  // --- Quiescence tracking (skip picture re-recording when provably
  // static — see engine/quiescence.ts + useLivelineEngine.ts's frame
  // callback) ---
  /** Consecutive frames that passed the quiescence break conditions +
   * `isQuiescentCandidate`. Reset to 0 the instant either breaks. */
  quiescentFrames: number;
  /** Identity of the `cfg.value` object mirrored on the last frame — a
   * fresh object every commit, so `!==` here means "something committed
   * since last frame" (prop change, theme switch, tick, ...). */
  lastCfgObj: EngineConfigStep | null;
  /** Canvas size as of the last frame a picture was actually recorded —
   * a resize while frames are being skipped must break quiescence. */
  lastRecordedW: number;
  lastRecordedH: number;
}

export function createEngineState(
  value: number,
  windowSecs: number,
  loading: boolean,
  candleWidth: number
): EngineState {
  'worklet';
  return {
    displayValue: value,
    displayValues: new Map<string, number>(),
    seriesAlpha: new Map<string, number>(),
    displayMin: 0,
    displayMax: 0,
    targetMin: 0,
    targetMax: 0,
    rangeInited: false,
    displayWindow: windowSecs,
    windowTransition: {
      from: windowSecs,
      to: windowSecs,
      startMs: 0,
      rangeFromMin: 0,
      rangeFromMax: 0,
      rangeToMin: 0,
      rangeToMax: 0,
    },
    arrowState: { up: 0, down: 0 },
    gridState: { interval: 0, labels: new Map<number, number>() },
    timeAxisState: {
      labels: new Map<number, { alpha: number; text: string }>(),
    },
    orderbookState: createOrderbookState(),
    particleState: createParticleState(),
    shakeState: createShakeState(),
    badge: { displayW: 0, targetW: 0, y: null, green: 1 },

    scrubAmount: 0,
    lastHover: null,
    lastHoverEntries: [],
    lastEmitHover: null,

    chartReveal: 0,

    pauseProgress: 0,
    timeDebt: 0,

    lastData: [],
    lastMultiSeries: [],
    frozenNow: 0,

    pausedData: null,
    pausedMultiData: null,

    loadingAlpha: loading ? 1 : 0,

    displayCandle: null,
    liveBirthAlpha: 1,
    liveBull: 0.5,
    lineSmoothClose: 0,
    lineSmoothInited: false,
    closeLineSmooth: 0,
    closeLineSmoothInited: false,
    lineModeProg: 0,
    lineModeTrans: { startMs: 0, from: 0, to: 0 },
    lineDensityProg: 0,
    lineDensityTrans: { startMs: 0, from: 0, to: 0 },
    lineTickSmooth: 0,
    lineTickSmoothInited: false,
    candleWidthTrans: {
      fromWidth: candleWidth,
      toWidth: candleWidth,
      startMs: 0,
      rangeFromMin: 0,
      rangeFromMax: 0,
      rangeToMin: 0,
      rangeToMax: 0,
      oldCandles: [],
      oldWidth: candleWidth,
    },
    prevCandleData: { candles: [], width: candleWidth },
    pausedCandles: null,
    pausedLive: null,
    pausedLineData: null,
    pausedLineValue: null,
    lastCandles: [],
    lastLive: null,
    lastLineDataStash: [],
    lastLineValueStash: undefined,

    quiescentFrames: 0,
    lastCfgObj: null,
    // -1 so the very first frame's size comparison always mismatches
    // (a real frame is always <= 0 guarded upstream, so 0×0 never records).
    lastRecordedW: -1,
    lastRecordedH: -1,
  };
}
