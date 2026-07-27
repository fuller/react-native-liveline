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
  multiSeries?: Array<{
    id: string;
    data: LivelinePoint[];
    value: number;
    palette: LivelinePalette;
    label?: string;
  }>;
  isMultiSeries?: boolean;
  hiddenSeriesIds?: string[];
}

/**
 * `EngineConfig` as mirrored into the UI-thread shared value and read by
 * `engineStep` — `data`/`candles` are excluded because they're synced
 * through their own delta-updated shared values instead (see
 * useLivelineEngine.ts's `dataBuf`/`candlesBuf`) and passed to `engineStep`
 * as explicit arguments, so this narrower config never re-serializes the
 * full arrays on every commit.
 */
export type EngineConfigStep = Omit<EngineConfig, 'data' | 'candles'> & {
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
   * The multi-series line caches previously passed a hardcoded `dataRev: 0`
   * and leaned entirely on the len/firstT/lastT/lastV value heuristic, which
   * — exactly like the candle cache before `candlesRev` — cannot see a
   * consumer revising an *interior* point of a series (every heuristic field
   * stays put). Bumped per series by useLivelineEngine when that series'
   * `data` array reference changes; see the comment there for what that does
   * and doesn't catch. Absent (undefined) outside multi-series mode.
   */
  multiRevs?: Record<string, number>;
};
