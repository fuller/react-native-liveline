import type { SkPath, SkPicture } from '@shopify/react-native-skia';
import type {
  LivelinePoint,
  LivelinePalette,
  CandlePoint,
  LivelineFonts,
} from '../types';
import type { ArrowState, ShakeState, MultiSeriesEntry } from '../draw';
import type { GridState } from '../draw/grid';
import type { TimeAxisState } from '../draw/timeAxis';
import { createOrderbookState, type OrderbookState } from '../draw/orderbook';
import {
  createLineCacheSlot,
  type LineCacheSlot,
  type LineCacheRef,
} from '../draw/lineCache';
import { createLineDrawArgs, type LineDrawArgs } from '../draw/line';
import { createCandleDrawArgs, type CandleDrawArgs } from '../draw/candlestick';
import {
  createCandleCacheSlot,
  type CandleCacheSlot,
  type CandleCacheRef,
} from '../draw/candleCache';
import { createGridLayerSlot, type GridLayerSlot } from '../draw/gridLayer';
import {
  createScrollLayerSlot,
  type ScrollLayerSlot,
} from '../draw/scrollLayer';
import { createParticleState, type ParticleState } from '../draw/particles';
import { createShakeState } from '../draw';
import { createSkiaCache, type SkiaCache } from '../draw/canvas2d';
import type { WindowTransState } from './helpers';
import type { EngineConfigStep, FrameInputs } from './types';

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
  /** Pooled `LineCacheRef` — the (slot, dataRev, dataSource,
   * splitPrefixStroke) bundle `lineCacheHits`/`drawLine` take. Overwritten in
   * place each frame instead of allocating a fresh literal, and repointed at
   * each series' own slot inside the multi-series loop (`drawMultiFrame`
   * reads it synchronously per series and retains nothing). Starts pointing
   * at `lineCache` above, which is the single-series pipeline's slot. */
  lineCacheRef: LineCacheRef;
  /** Pooled argument struct for `drawLine` — see `LineDrawArgs`. One
   * instance, refilled before every call (including once per series in
   * multi-series mode); only one pipeline draws per frame, and `drawLine`
   * never retains it. Same pooling rationale as `multiSeriesEntryScratch`. */
  lineDrawArgs: LineDrawArgs;
  /** Pooled argument struct for `drawCandlesticks` — see `CandleDrawArgs`.
   * Refilled between the two halves of the candle-width cross-fade. */
  candleDrawArgs: CandleDrawArgs;
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
  /** Cross-frame SkPicture of the line's prefix stroke, single-series mode —
   * the declarative shell's scroll layer, composited under a
   * `<Group transform>` instead of being re-stroked every frame (see
   * engine/lineScrollLayer, draw/scrollLayer). Only the single-series line
   * pipeline populates it; multi-series and candle mode keep drawing the
   * combined path. */
  lineScroll: ScrollLayerSlot<SkPicture>;
  /** Dedicated Skia object cache for the line scroll layer's own
   * sub-recording — same reasoning as `gridLayerCache` above. */
  lineScrollCache: SkiaCache;

  // --- Scroll-transform extrapolation. On a vsync the frame-pacing gate
  // skips, the scroll layer's translate is extrapolated from the last two
  // recorded frames instead of recomputed. Full rationale in
  // engine/scrollExtrapolate.ts, which owns it.
  /** Whether the last recorded frame published a scroll picture — i.e.
   * whether there is anything for the extrapolated transform to move. Set
   * from `result.scrollPicture !== null`, where the answer is already
   * known. */
  scrollActive: boolean;
  /** dx at the last recorded frame. */
  scrollDxLast: number;
  /** Timestamp (ms) of the last recorded frame; -1 before the first. */
  scrollDxLastT: number;
  /** Observed dx change per ms across the last two recorded frames. */
  scrollDxRate: number;
  /**
   * `lineCache.buildRev` as of the last recorded frame, i.e. WHICH prefix
   * picture `scrollDxLast` is an offset of.
   *
   * `dx` is `layout.toX(tRef) - xRefAtBuild`, so it resets to ~0 the frame
   * the prefix is rebuilt while the line on screen does not move at all.
   * Differencing across that frame yields a rate that describes a jump that
   * never happened — see `observeScrollRate`'s `layerChanged` guard, which
   * this field feeds. `-1` before the first recorded frame (no slot has
   * `buildRev` -1, so the first frame always reads as a change; harmless,
   * since `scrollDxLastT < 0` already suppresses it).
   */
  scrollDxBuildRev: number;
  /** Cross-frame closed-candle body+wick path cache, candle mode (see
   * draw/candleCache). */
  candleCache: CandleCacheSlot;
  /** Pooled `FrameInputs` for `engineStep` — the caller (useLivelineEngine's
   * frame worklet) overwrites its fields each frame and hands it straight
   * back in, so the twelve-argument call became a four-argument one without
   * adding a per-frame allocation. See `FrameInputs` in engine/step.ts. */
  frameInputs: FrameInputs;
  /** Pooled `CandleCacheRef` — the (slot, dataSource, candlesRev) bundle
   * `drawCandlesticks`/`updateCandleCache` take. Overwritten in place each
   * candle frame instead of allocating a fresh literal. */
  candleCacheRef: CandleCacheRef;

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
  /** `cfg.candlesRev` the `prevCandleData.candles` copy was taken at, so the
   * copy is skipped on every frame where the candle buffer hasn't changed
   * (same mechanism, and same reason, as `lastDataStashRev` above — the only
   * consumer is the candle-width-change branch, which fires when the *user*
   * changes candle width). `.width` is still refreshed every frame: it must
   * always describe the previous frame's width for that branch to read.
   * -1 (never a real revision) forces the first copy. */
  prevCandleDataRev: number;
  /** Pooled frozen copy of the live candle for the reverse-morph stash.
   * `s.displayCandle` (== `smoothLive`, and the last element of the visible
   * array) is lerped in place every frame, so `lastCandles = visible.slice()`
   * alone would leave the "frozen" stash still moving. Safe to pool: it is
   * only written on `hasData` frames and only read on `!hasData` frames (see
   * `useStash` in step.ts), which are disjoint. */
  lastLiveStash: CandlePoint;
  /** Scratch array for candle mode's per-frame *old*-candles visible build
   * (the candle-width morph's outgoing set). Reused/refilled like
   * `candleVisibleScratch`; never retained past the frame — `drawCandleFrame`
   * reads `oldCandles` synchronously (and `.map()`s it into a fresh array
   * when the OHLC collapse is active). */
  candleOldVisibleScratch: CandlePoint[];
  /** Pooled candle handed to `drawCandleFrame` as `closePriceCandle` — the
   * raw live candle with its close replaced by the smoothed close. Read
   * synchronously by `drawClosePrice` and never retained, so one reused
   * object beats a fresh spread every candle frame. */
  closePriceScratch: CandlePoint;
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
  /**
   * `now_ms` as of the last frame that credited `timeDebt` — a SEPARATE
   * clock from `lastFrameTimestamp`, and deliberately so.
   *
   * `lastFrameTimestamp` answers "when did state last advance", which is
   * exactly what the pacing gate and `dt` want, and exactly what accrual
   * must not use: the quiescence skip credits debt without advancing state,
   * so measuring it against a fixed origin makes every consecutive skipped
   * frame re-count the same interval (see `engine/timeAccrual.ts`). This
   * field advances on every frame that credits, so credited intervals
   * tile the timeline exactly once.
   *
   * `null` until the first credit. Recorded frames set it too — their
   * accrual is done inside `engineStep` off `dt` — so the first quiescent
   * frame after a record measures from that record, not from whenever
   * quiescence last ended.
   */
  lastAccrualTimestamp: number | null;
}

/** The subset of `Map` that {@link pruneByIds} needs — lets one array hold
 * per-series maps with differently-typed values (`Map<string, V>` is
 * invariant in `V`, so `Map<string, unknown>[]` would not accept them). */
export interface PrunableMap {
  readonly size: number;
  keys(): IterableIterator<string>;
  delete(key: string): boolean;
}

/**
 * Every per-series map on `EngineState` whose keys are series ids owned by
 * the *current* multi-series set, and which therefore must be pruned
 * together when a series is removed. Registration lives here, next to the
 * field declarations above: adding a new per-series map means adding one
 * line to this array, not hand-writing another delete loop at the call
 * site (which is how `seriesAlpha` came to leak).
 *
 * Deliberately NOT included, each for its own reason:
 * - `smoothValuesScratch` — `.clear()`-ed at the top of every multi frame
 *   (`step.ts`), so it can never hold a dead id past that frame.
 * - `lastMultiStashRevs` / `lastMultiStashData` — keyed by the *stashed*
 *   (previous) series set rather than the current one, and pruned on their
 *   own in the stash-build block in `step.ts`; pruning them against the
 *   live ids here would throw away the reverse-morph data that block
 *   exists to keep.
 * - `pausedMultiData` — a nullable whole-map snapshot, rebuilt on pause and
 *   set back to `null` on resume, so it has no cross-series-set lifetime.
 *
 * Allocates a small array per call; only ever called from the
 * series-removal branch (guarded by a size check), never per frame.
 */
export function perSeriesMaps(s: EngineState): PrunableMap[] {
  'worklet';
  return [
    s.displayValues,
    s.seriesAlpha,
    s.multiVisibleScratch,
    s.multiSeriesEntryScratch,
    s.lineCaches,
  ];
}

/** Delete every entry whose key is not in `currentIds`, from each map. */
export function pruneByIds(currentIds: Set<string>, maps: PrunableMap[]): void {
  'worklet';
  for (const map of maps) {
    for (const key of map.keys()) {
      if (!currentIds.has(key)) map.delete(key);
    }
  }
}

export function createEngineState(
  value: number,
  windowSecs: number,
  loading: boolean,
  candleWidth: number
): EngineState {
  'worklet';
  // Built before the literal so `lineCacheRef` can point at the very same
  // slot object rather than a copy.
  const lineCache = createLineCacheSlot();
  const candleCache = createCandleCacheSlot();
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
    lineCache: lineCache,
    lineCacheRef: { slot: lineCache, dataRev: 0, dataSource: 0 },
    lineDrawArgs: createLineDrawArgs(),
    candleDrawArgs: createCandleDrawArgs(),
    lineCaches: new Map<string, LineCacheSlot>(),
    gridLayer: createGridLayerSlot<SkPicture>(),
    gridLayerCache: createSkiaCache(),
    lineScroll: createScrollLayerSlot<SkPicture>(),
    lineScrollCache: createSkiaCache(),
    scrollActive: false,
    scrollDxLast: 0,
    scrollDxLastT: -1,
    scrollDxRate: 0,
    scrollDxBuildRev: -1,
    candleCache: candleCache,
    frameInputs: {
      w: 0,
      h: 0,
      hoverPixelX: null,
      dt: 0,
      now_ms: 0,
      // Every field is filled by the caller before the first `engineStep`;
      // the placeholders here exist only so the struct is fully shaped at
      // creation rather than growing properties later. There is no "empty"
      // `LivelineFonts` to seed with — the real one is supplied by the frame
      // worklet, which is the only thing that ever reads this.
      fonts: null as unknown as LivelineFonts,
      data: [],
      candles: [],
      multiData: {},
    },
    candleCacheRef: { slot: candleCache, dataSource: 0, candlesRev: 0 },

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
    prevCandleDataRev: -1,
    lastLiveStash: { time: 0, open: 0, high: 0, low: 0, close: 0 },
    candleOldVisibleScratch: [],
    closePriceScratch: { time: 0, open: 0, high: 0, low: 0, close: 0 },
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
    lastAccrualTimestamp: null,
  };
}
