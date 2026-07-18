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
