import type { LivelinePoint, CandlePoint } from 'react-native-liveline';

// --- Data generators (ported verbatim from the web dev playgrounds) ---

export type Volatility = 'calm' | 'normal' | 'spiky' | 'chaos';

/**
 * Ported from dev/demo.tsx `generatePoint` (a superset of dev/main.tsx's
 * version — passing no `baseValue` reproduces main.tsx's behavior exactly,
 * since `priceScale` becomes 1).
 */
export function generatePoint(
  prev: number,
  time: number,
  volatility: Volatility,
  baseValue = 100
): LivelinePoint {
  const v: Record<Volatility, number> = {
    calm: 0.15,
    normal: 0.8,
    spiky: 3,
    chaos: 8,
  };
  const bias: Record<Volatility, number> = {
    calm: 0.49,
    normal: 0.48,
    spiky: 0.47,
    chaos: 0.45,
  };
  const priceScale = baseValue / 100;
  const scale = v[volatility] * priceScale;
  // Occasional large spikes in spiky/chaos modes
  const spike =
    (volatility === 'spiky' || volatility === 'chaos') && Math.random() < 0.08
      ? (Math.random() - 0.5) * scale * 3
      : 0;
  const delta = (Math.random() - bias[volatility]) * scale + spike;
  return { time, value: prev + delta };
}

/** Aggregate tick data into OHLC candles by time bucket. Ported verbatim from dev/demo.tsx. */
export function aggregateCandles(
  ticks: LivelinePoint[],
  width: number
): { candles: CandlePoint[]; live: CandlePoint | null } {
  if (ticks.length === 0) return { candles: [], live: null };
  const candles: CandlePoint[] = [];
  let slot = Math.floor(ticks[0]!.time / width) * width;
  let o = ticks[0]!.value,
    h = o,
    l = o,
    c = o;
  for (let i = 1; i < ticks.length; i++) {
    const t = ticks[i]!;
    if (t.time >= slot + width) {
      candles.push({ time: slot, open: o, high: h, low: l, close: c });
      slot = Math.floor(t.time / width) * width;
      o = t.value;
      h = o;
      l = o;
      c = o;
    } else {
      c = t.value;
      if (c > h) h = c;
      if (c < l) l = c;
    }
  }
  return { candles, live: { time: slot, open: o, high: h, low: l, close: c } };
}

// --- Constants ---

export const TIME_WINDOWS = [
  { label: '10s', secs: 10 },
  { label: '30s', secs: 30 },
  { label: '1m', secs: 60 },
  { label: '5m', secs: 300 },
];

export const CRYPTO_WINDOWS = [
  { label: '5m', secs: 300 },
  { label: '15m', secs: 900 },
  { label: '1h', secs: 3600 },
];

export const TICK_RATES: { label: string; ms: number }[] = [
  { label: '50ms', ms: 50 },
  { label: '100ms', ms: 100 },
  { label: '300ms', ms: 300 },
  { label: '1s', ms: 1000 },
];

export const VOLATILITIES: Volatility[] = ['calm', 'normal', 'spiky', 'chaos'];

export const CANDLE_WIDTHS = [
  { label: '1s', secs: 1 },
  { label: '2s', secs: 2 },
  { label: '5s', secs: 5 },
  { label: '10s', secs: 10 },
];

/**
 * Fixed pixel sizes for the "Size variants" gallery row, ported verbatim from
 * dev/main.tsx (lines 288-292) and dev/demo.tsx (lines 389-393).
 */
export const SIZE_VARIANTS: { w: number; h: number; label: string }[] = [
  { w: 320, h: 180, label: '320×180' },
  { w: 240, h: 120, label: '240×120' },
  { w: 160, h: 100, label: '160×100' },
  { w: 120, h: 80, label: '120×80' },
];

export const MULTI_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b'];
export const MULTI_LABELS = ['Yes', 'No', 'Maybe', 'Other'];
export const MULTI_BIASES = [0.51, 0.49, 0.5, 0.48];
export const MULTI_WINDOWS = [
  { label: '10s', secs: 10 },
  { label: '30s', secs: 30 },
  { label: '1m', secs: 60 },
  { label: '5m', secs: 300 },
];

/**
 * $-formatted crypto value, e.g. `$65,432.10`. Must be Hermes/worklet-safe —
 * `toLocaleString` is not available on the UI-thread worklet runtime, so the
 * comma-grouping is done by hand.
 *
 * Web-parity sign order: web is
 * `'$' + v.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})`,
 * and `toLocaleString` puts the minus sign *after* the leading text is
 * prepended by string concat — i.e. the `-` lands between `$` and the digits
 * (e.g. `-1234.5` → `"$-1,234.50"`), not before the `$`. Match that exactly.
 */
export const formatCrypto = (v: number) => {
  'worklet';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  const fixed = abs.toFixed(2);
  const dotIdx = fixed.indexOf('.');
  const intPart = fixed.slice(0, dotIdx);
  const decPart = fixed.slice(dotIdx);
  let grouped = '';
  let count = 0;
  for (let i = intPart.length - 1; i >= 0; i--) {
    grouped = intPart[i] + grouped;
    count++;
    if (count % 3 === 0 && i !== 0) grouped = ',' + grouped;
  }
  return '$' + sign + grouped + decPart;
};

/** Percent formatter for the multi-series demo (e.g. `52.3%`). */
export const formatPercent = (v: number) => {
  'worklet';
  return v.toFixed(1) + '%';
};
