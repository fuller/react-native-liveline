import type {
  LivelinePoint,
  LivelinePalette,
  Momentum,
  ReferenceLine,
  Padding,
  OrderbookData,
  DegenOptions,
  BadgeVariant,
  CandlePoint,
  LivelineFonts,
} from '../types';

/**
 * Serializable engine configuration — mirrored from props into a shared
 * value each commit and read by the frame worklet on the UI thread.
 *
 * formatValue/formatTime must be worklets. hiddenSeriesIds is an array
 * (not a Set) so the config stays cheaply shareable.
 */
export interface EngineConfig {
  data: LivelinePoint[];
  value: number;
  palette: LivelinePalette;
  windowSecs: number;
  lerpSpeed: number;
  showGrid: boolean;
  showBadge: boolean;
  showMomentum: boolean;
  momentumOverride?: Momentum;
  showFill: boolean;
  referenceLine?: ReferenceLine;
  formatValue: (v: number) => string;
  formatTime: (t: number) => string;
  padding: Required<Padding>;
  hasOnHover: boolean;
  showPulse: boolean;
  scrub: boolean;
  scrubActivationDelay?: number;
  active: boolean;
  exaggerate: boolean;
  degenOptions?: DegenOptions;
  badgeTail: boolean;
  badgeVariant: BadgeVariant;
  tooltipY: number;
  tooltipOutline: boolean;
  valueMomentumColor: boolean;
  showValue: boolean;
  orderbookData?: OrderbookData;
  loading?: boolean;
  paused?: boolean;
  emptyText?: string;
  noMotion: boolean;

  // Candlestick mode
  mode: 'line' | 'candle';
  candles?: CandlePoint[];
  candleWidth?: number;
  liveCandle?: CandlePoint;
  lineMode?: boolean;
  lineData?: LivelinePoint[];
  lineValue?: number;

  // Multi-series mode
  multiSeries?: MultiSeriesConfigEntry[];
  isMultiSeries?: boolean;
  hiddenSeriesIds?: string[];
}

/**
 * One caller-supplied series in `EngineConfig.multiSeries`. Named separately
 * so `EngineConfigStep` (below) can reuse it with `data` omitted, the same
 * way it omits `data`/`candles` from the top level.
 */
export interface MultiSeriesConfigEntry {
  id: string;
  data: LivelinePoint[];
  value: number;
  palette: LivelinePalette;
  label?: string;
}

/**
 * `EngineConfig` as mirrored into the UI-thread shared value and read by
 * `engineStep` — `data`/`candles` are excluded because they're synced
 * through their own delta-updated shared values instead (see
 * useLivelineEngine.ts's `dataBuf`/`candlesBuf`) and passed to `engineStep`
 * as explicit arguments, so this narrower config never re-serializes the
 * full arrays on every commit.
 *
 * Same treatment for each multi-series entry's `data`: it's synced through
 * its own delta-updated, per-series-id-keyed shared value instead (see
 * useLivelineEngine.ts's `multiDataBuf`) and passed to `engineStep`
 * separately, so `multiSeries` here carries id/value/palette/label only —
 * never the point arrays.
 */
export type EngineConfigStep = Omit<
  EngineConfig,
  'data' | 'candles' | 'multiSeries'
> & {
  multiSeries?: Array<Omit<MultiSeriesConfigEntry, 'data'>>;
  /**
   * Revision counter for the delta-synced `data` buffer — bumped by
   * useLivelineEngine whenever computeDelta reports an actual change.
   * Gives the line path cache an exact data identity (catches interior
   * mutations that endpoint-based heuristics would miss).
   */
  dataRev: number;
  /**
   * Same idea as `dataRev`, for the delta-synced `candles` buffer — bumped
   * by useLivelineEngine whenever computeDelta reports an actual change.
   * Gives the candle cache an exact data identity, catching a consumer
   * revising an already-closed candle in place (count/first-time/last-time/
   * min/max can all stay unchanged when that happens).
   */
  candlesRev: number;
  /**
   * Per-series revision counters for multi-series mode, keyed by series id.
   * Same mechanism as `dataRev`/`candlesRev` now that each series' data
   * rides its own delta-synced buffer (`multiDataBuf`): bumped by
   * useLivelineEngine whenever that series' `computeDelta` result isn't
   * `'same'`. Gives the multi-series line caches an exact per-series data
   * identity, catching a consumer revising an *interior* point of a series
   * in place — which the cache's len/firstT/lastT/lastV value heuristic
   * cannot see, and which a plain array-reference check (the previous
   * mechanism here, before multi-series data was delta-synced) would also
   * miss for a value-equal-but-recreated array. Absent (undefined) outside
   * multi-series mode.
   */
  multiRevs?: Record<string, number>;
};

/**
 * The per-frame inputs to `engineStep` that are neither the drawing context,
 * the config, nor the engine state — the canvas size, this frame's timing and
 * hover pixel, the fonts, and the three delta-synced data buffers.
 *
 * These were nine positional parameters (twelve in total), including two
 * adjacent `number` pairs — `w, h` and `dt, now_ms` — that a caller could
 * transpose with no type error and no test failure, only a wrong-looking
 * chart. As a struct they are named at the call site.
 *
 * **Pooled, not allocated per frame**: one instance lives on `EngineState`
 * (`frameInputs`), which the caller fills in place. `engineStep` destructures
 * it on entry and never retains it.
 */
export interface FrameInputs {
  /** Canvas width in px. */
  w: number;
  /** Canvas height in px. */
  h: number;
  /** Hover/scrub pixel X, or null when the finger is off the chart. */
  hoverPixelX: number | null;
  /** Delta time in ms since the last drawn frame. */
  dt: number;
  /** `performance.now()` for this frame. */
  now_ms: number;
  fonts: LivelineFonts;
  /** Line-mode data points — synced via its own delta-updated shared value. */
  data: LivelinePoint[];
  /** Candles — synced via its own delta-updated shared value; empty array
   * (never undefined) when there is no candle data, matching the `?? []`
   * fallback this replaced at every read site below. */
  candles: CandlePoint[];
  /** Multi-series data points, keyed by series id — synced via its own
   * delta-updated shared value (one buffer per series), same rationale as
   * `data`/`candles` above but keyed since series can be added/removed
   * independently. `cfg.multiSeries` entries carry id/value/palette/label
   * only; look up a series' points here (or via `multiSeriesData` below,
   * which also handles the reverse-morph stash case). */
  multiData: Record<string, LivelinePoint[]>;
}
