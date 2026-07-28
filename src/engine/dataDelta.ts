import type { LivelinePoint, CandlePoint } from '../types';

/**
 * Result of diffing `prev` against `next` for `useLivelineEngine`'s data/
 * candle mirror effect (see useLivelineEngine.ts). Runs on the JS thread —
 * no worklet directive needed.
 *
 * - `same`: nothing changed (reference-equal arrays) — skip the UI-thread
 *   write entirely.
 * - `delta`: `next` is `prev` with `drop` elements removed from the front,
 *   truncated to `keep` elements, then `tail` appended. Applying it moves
 *   only `tail` (usually 0-1 elements) across the runtime boundary instead
 *   of the whole array.
 * - `reset`: no cheap relationship between `prev` and `next` was found (or
 *   the delta wouldn't be worth it) — the caller should send the whole
 *   array across.
 */
export type DeltaResult<T> =
  | { kind: 'same' }
  | { kind: 'delta'; drop: number; keep: number; tail: T[] }
  | { kind: 'reset' };

/**
 * Above this fraction of `next.length`, a "delta" tail is no cheaper than
 * just sending the whole array, so computeDelta reports `reset` instead.
 */
const RESET_TAIL_RATIO = 0.5;

/** Binary search a time-ordered array for the index whose `.time` matches. */
function findByTime<T extends { time: number }>(
  arr: T[],
  time: number
): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    // eslint-disable-next-line no-bitwise
    const mid = (lo + hi) >> 1;
    const t = arr[mid]!.time;
    if (t === time) return mid;
    if (t < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Diff two time-ordered arrays sharing a common prefix relationship —
 * covers pure append, append+trim (ring-buffer `slice(-N)`), and
 * last-element-mutated (a live candle ticking) patterns. `eq` decides
 * element equality (so recreated-but-value-equal objects still produce a
 * delta instead of a spurious reset).
 */
export function computeDelta<T extends { time: number }>(
  prev: T[],
  next: T[],
  eq: (a: T, b: T) => boolean
): DeltaResult<T> {
  if (prev === next) return { kind: 'same' };
  if (prev.length === 0 || next.length === 0) return { kind: 'reset' };

  const drop = findByTime(prev, next[0]!.time);
  if (drop < 0 || !eq(prev[drop]!, next[0]!)) return { kind: 'reset' };

  const maxKeep = Math.min(prev.length - drop, next.length);
  let keep = 0;
  while (
    keep < maxKeep &&
    (prev[drop + keep] === next[keep] || eq(prev[drop + keep]!, next[keep]!))
  ) {
    keep++;
  }

  const tail = next.slice(keep);
  if (tail.length > next.length * RESET_TAIL_RATIO) return { kind: 'reset' };

  return { kind: 'delta', drop, keep, tail };
}

export function pointsEqual(a: LivelinePoint, b: LivelinePoint): boolean {
  return a.time === b.time && a.value === b.value;
}

export function candlesEqual(a: CandlePoint, b: CandlePoint): boolean {
  return (
    a.time === b.time &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close
  );
}
