import type { SkPath, SkPicture } from '@shopify/react-native-skia';
import type { LivelinePoint, LivelinePalette, CandlePoint } from '../types';
import type { ArrowState, ShakeState, MultiSeriesEntry } from '../draw';
import type { GridState } from '../draw/grid';
import type { TimeAxisState } from '../draw/timeAxis';
import { createOrderbookState, type OrderbookState } from '../draw/orderbook';
import { createLineCacheSlot, type LineCacheSlot } from '../draw/lineCache';
import {
  createCandleCacheSlot,
  type CandleCacheSlot,
} from '../draw/candleCache';
import { createGridLayerSlot, type GridLayerSlot } from '../draw/gridLayer';
import { createParticleState, type ParticleState } from '../draw/particles';
import { createShakeState } from '../draw';
import { createSkiaCache, type SkiaCache } from '../draw/canvas2d';
import type { WindowTransState } from './helpers';
import type { EngineConfigStep } from './types';

export interface BadgeState {
  displayW: number; // current lerped text width (0 = uninited)
  targetW: number;
  y: number | null; // lerped badge Y, null = uninited
  green: number; // momentum color blend 0 (red) → 1 (green)
  // Cached pill SkPath (origin at 0,0 — positioned via canvas translate at
  // draw time) + the geometry it was built for. The pill only changes size
  // while displayW is mid-lerp; caching skips the SVG-string build + native
  // parse on the (vast majority of) frames where geometry is unchanged.
  path: SkPath | null;
  pathW: number; // pillW the cached path was built for (-1 = none)
  pathTail: boolean; // whether the cached path includes the tail
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
  /** Scratch map for this frame's per-series smoothed values (multi-series
   * mode) — persisted and `.clear()`-ed each frame instead of a fresh `Map`,
   * since this is rebuilt on every frame regardless (the values it holds
   * are this frame's lerp output) but the container itself doesn't need to
   * be reallocated 60x/sec. */
  smoothValuesScratch: Map<string, number>;
  /** Scratch array for single-series mode's per-frame visible-points filter
   * (`filterVisiblePointsInto` in math/visible.ts) — reused and refilled
   * every frame instead of a fresh array, same rationale as
   * `smoothValuesScratch`. NOT used for candle mode's own visible-candles
   * build (see `candleVisibleScratch`) or multi-series (see
   * `multiVisibleScratch`) — each mode filters a differently-shaped point
   * array. */
  visibleScratch: LivelinePoint[];
  /** Scratch array for candle mode's per-frame visible-candles build
   * (`engine/step.ts`, the manual width-adjusted loop — NOT
   * `filterVisiblePointsInto`, see `math/visible.ts`'s docblock on why
   * candle visibility uses its own bound). CAUTION: candle mode also
   * aliases this frame's visible array into `lastCandles` for the
   * reverse-morph stash; that assignment copies (`.slice()`) specifically
   * because this array is reused in place next frame — see the comment at
   * the `s.lastCandles = ...` assignment. */
  candleVisibleScratch: CandlePoint[];
  /** Scratch array reused across multi-series's per-series union-range scan
   * (the `targetVisible` loop in `engine/step.ts`, seeding the window
   * transition's target Y range from ALL series, not just the first). A
   * single shared array is safe here because each iteration fills it,
   * reads it synchronously (via `computeRange`), and moves on before the
   * next iteration refills it — nothing holds a reference across
   * iterations or frames. */
  multiUnionVisibleScratch: LivelinePoint[];
  /** Per-series scratch arrays for multi-series mode's per-frame
   * visible-points filter, keyed by series id — mirrors `lineCaches`
   * below (same key, same cleanup-on-removal treatment) since each series
   * needs its own retained backing array rather than one shared buffer
   * (unlike `multiUnionVisibleScratch` above, these ARE retained past the
   * frame: they become `MultiSeriesEntry.visible`, read by `drawMultiFrame`
   * and by the hover-tooltip scan later in the same frame, so they can't
   * double as a single shared scratch slot). */
  multiVisibleScratch: Map<string, LivelinePoint[]>;
  /** Pooled `MultiSeriesEntry` objects for multi-series mode, keyed by
   * series id — mirrors `lineCaches`/`multiVisibleScratch` (same key, same
   * cleanup). Avoids allocating a fresh object literal per visible series
   * per frame; fields are overwritten in place instead. Confirmed safe:
   * `drawMultiFrame` (draw/index.ts) reads each entry synchronously to
   * build its own `pts`/`allPts` output and never stores the entry object
   * or its `.visible` array beyond that call. */
  multiSeriesEntryScratch: Map<string, MultiSeriesEntry>;
  /** Reused container for this frame's multi-series draw list — filled by
   * looking up/creating pooled entries in `multiSeriesEntryScratch` above,
   * `.length = 0` then pushed into each frame like `visibleScratch`. */
  seriesEntriesScratch: MultiSeriesEntry[];
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
  /** Cross-frame line SkPath cache, single-series mode (see draw/lineCache) */
  lineCache: LineCacheSlot;
  /** Per-series line path caches, multi-series mode — keyed by series id,
   * pruned alongside displayValues when series are removed */
  lineCaches: Map<string, LineCacheSlot>;
  /** Cross-frame grid (gridlines + Y-axis labels) SkPicture cache (see
   * engine/gridLayer). Single shared instance across modes since only one
   * mode draws per frame. */
  gridLayer: GridLayerSlot<SkPicture>;
  /** Dedicated Skia object cache for the grid layer's own sub-recording —
   * deliberately not shared with the main frame's SkiaCache (see
   * engine/gridLayer.ts's doc comment). */
  gridLayerCache: SkiaCache;
  /** Cross-frame closed-candle body+wick path cache, candle mode (see
   * draw/candleCache). */
  candleCache: CandleCacheSlot;

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
  /** `cfg.dataRev` the `lastData` stash was copied at, so the copy is
   * skipped on the ~17 of every 18 frames where the buffer hasn't changed.
   * -1 (never a real revision) forces the first copy. */
  lastDataStashRev: number;
  /** Same idea per series id, plus the copied arrays themselves so an
   * unchanged series can be re-used by reference instead of re-sliced.
   * The stash's cheap fields (value/palette/label) are still refreshed
   * every frame — only the point-array copy is revision-gated. */
  lastMultiStashRevs: Map<string, number>;
  lastMultiStashData: Map<string, LivelinePoint[]>;
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

  // --- Frame pacing (see engine/constants.ts's MIN_FRAME_INTERVAL_MS) ---
  /** `now_ms` as of the last frame that actually ran engineStep — the
   * source of `dt` (wall-clock elapsed, not vsync-to-vsync) and the pacing
   * gate. `null` until the first frame ever records. Left untouched by
   * both the quiescence skip and the pacing skip, so it always reflects
   * "when did state last actually advance." */
  lastFrameTimestamp: number | null;
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
    smoothValuesScratch: new Map<string, number>(),
    visibleScratch: [],
    candleVisibleScratch: [],
    multiUnionVisibleScratch: [],
    multiVisibleScratch: new Map<string, LivelinePoint[]>(),
    multiSeriesEntryScratch: new Map<string, MultiSeriesEntry>(),
    seriesEntriesScratch: [],
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
    gridState: {
      interval: 0,
      labels: new Map<number, number>(),
      targetsScratch: new Map<number, number>(),
    },
    timeAxisState: {
      labels: new Map<number, { alpha: number; text: string }>(),
      targetsScratch: new Set<number>(),
      visibleLabelsScratch: [],
      drawnScratch: [],
      labelEntryPool: [],
      formatTimeRef: null,
    },
    orderbookState: createOrderbookState(),
    particleState: createParticleState(),
    shakeState: createShakeState(),
    badge: {
      displayW: 0,
      targetW: 0,
      y: null,
      green: 1,
      path: null,
      pathW: -1,
      pathTail: false,
    },
    lineCache: createLineCacheSlot(),
    lineCaches: new Map<string, LineCacheSlot>(),
    gridLayer: createGridLayerSlot<SkPicture>(),
    gridLayerCache: createSkiaCache(),
    candleCache: createCandleCacheSlot(),

    scrubAmount: 0,
    lastHover: null,
    lastHoverEntries: [],
    lastEmitHover: null,

    chartReveal: 0,

    pauseProgress: 0,
    timeDebt: 0,

    lastData: [],
    lastMultiSeries: [],
    lastDataStashRev: -1,
    lastMultiStashRevs: new Map<string, number>(),
    lastMultiStashData: new Map<string, LivelinePoint[]>(),
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

    lastFrameTimestamp: null,
  };
}
