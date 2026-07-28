import {
  computeDelta,
  pointsEqual,
  candlesEqual,
  type DeltaResult,
} from '../dataDelta';
import type { LivelinePoint, CandlePoint } from '../../types';

const pts = (times: number[]): LivelinePoint[] =>
  times.map((t) => ({ time: t, value: t * 10 }));

const candle = (t: number, close: number): CandlePoint => ({
  time: t,
  open: close - 1,
  high: close + 1,
  low: close - 2,
  close,
});

/** Plain-JS reference implementation of applying a delta, for round-trip checks. */
function applyDelta<T>(prev: T[], result: DeltaResult<T>): T[] {
  if (result.kind === 'same') return prev;
  if (result.kind === 'reset') throw new Error('cannot apply a reset delta');
  const arr = prev.slice();
  arr.splice(0, result.drop);
  arr.length = result.keep;
  for (const item of result.tail) arr.push(item);
  return arr;
}

describe('computeDelta', () => {
  it('reports same for reference-equal arrays', () => {
    const prev = pts([1, 2, 3]);
    const result = computeDelta(prev, prev, pointsEqual);
    expect(result).toEqual({ kind: 'same' });
  });

  it('handles pure append', () => {
    const prev = pts([1, 2, 3]);
    const next = [...prev, ...pts([4, 5])];
    const result = computeDelta(prev, next, pointsEqual);
    expect(result).toEqual({
      kind: 'delta',
      drop: 0,
      keep: 3,
      tail: pts([4, 5]),
    });
    expect(applyDelta(prev, result)).toEqual(next);
  });

  it('handles append + trim (ring-buffer slice(-N) shape)', () => {
    // window of 5, one new point pushed, oldest dropped
    const prev = pts([1, 2, 3, 4, 5]);
    const appended = [...prev, ...pts([6])];
    const next = appended.slice(-5); // [2,3,4,5,6]
    const result = computeDelta(prev, next, pointsEqual);
    expect(result).toEqual({
      kind: 'delta',
      drop: 1,
      keep: 4,
      tail: pts([6]),
    });
    expect(applyDelta(prev, result)).toEqual(next);
  });

  it('handles last-element-mutated (live candle tick)', () => {
    const prev = [candle(1, 10), candle(2, 20), candle(3, 30)];
    const next = [candle(1, 10), candle(2, 20), candle(3, 31)]; // last mutated
    const result = computeDelta(prev, next, candlesEqual);
    expect(result).toEqual({
      kind: 'delta',
      drop: 0,
      keep: 2,
      tail: [candle(3, 31)],
    });
    expect(applyDelta(prev, result)).toEqual(next);
  });

  it('handles last-element-mutated with a new candle appended', () => {
    const prev = [candle(1, 10), candle(2, 20), candle(3, 30)];
    const next = [candle(1, 10), candle(2, 20), candle(3, 31), candle(4, 40)];
    const result = computeDelta(prev, next, candlesEqual);
    expect(result).toEqual({
      kind: 'delta',
      drop: 0,
      keep: 2,
      tail: [candle(3, 31), candle(4, 40)],
    });
    expect(applyDelta(prev, result)).toEqual(next);
  });

  it('resets on a mid-array change', () => {
    const prev = pts([1, 2, 3, 4, 5, 6, 7, 8]);
    const next = prev.slice();
    next[3] = { time: 4, value: 999 }; // mutate a middle point
    const result = computeDelta(prev, next, pointsEqual);
    expect(result.kind).toBe('reset');
  });

  it('resets on shrink to an unrelated smaller dataset', () => {
    const prev = pts([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const next = pts([101, 102, 103]);
    const result = computeDelta(prev, next, pointsEqual);
    expect(result.kind).toBe('reset');
  });

  it('resets when going from empty to N points', () => {
    const result = computeDelta([], pts([1, 2, 3]), pointsEqual);
    expect(result.kind).toBe('reset');
  });

  it('resets when going from N points to empty', () => {
    const result = computeDelta(pts([1, 2, 3]), [], pointsEqual);
    expect(result.kind).toBe('reset');
  });

  it('produces a delta for recreated-but-equal objects (no shared references)', () => {
    const prev = pts([1, 2, 3]);
    // Deep-clone every element so nothing is reference-equal to prev.
    const next = [...prev.map((p) => ({ ...p })), { time: 4, value: 40 }];
    expect(next[0]).not.toBe(prev[0]);
    const result = computeDelta(prev, next, pointsEqual);
    expect(result).toEqual({
      kind: 'delta',
      drop: 0,
      keep: 3,
      tail: [{ time: 4, value: 40 }],
    });
    expect(applyDelta(prev, result)).toEqual(next);
  });

  it('resets when the tail would be more than half of next (large reshuffle)', () => {
    // Only the very first point survives; everything else is new — the
    // delta wouldn't be any cheaper than sending the whole array.
    const prev = pts([1, 2, 3, 4, 5, 6]);
    const next = [prev[0]!, ...pts([201, 202, 203, 204, 205])];
    const result = computeDelta(prev, next, pointsEqual);
    expect(result.kind).toBe('reset');
  });
});
