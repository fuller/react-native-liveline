import { lerp, quantize } from '../lerp';
import { computeRange } from '../range';
import { detectMomentum } from '../momentum';
import { interpolateAtTime } from '../interpolate';
import { niceTimeInterval } from '../intervals';
import {
  drawSpline,
  computeSplineTangents,
  emitSplineSegments,
  drawSplineTail,
  type SplinePath,
} from '../spline';
import { decimateMinMax } from '../decimate';
import type { LivelinePoint } from '../../types';

// -- lerp --

describe('lerp', () => {
  it('returns target when speed is 1', () => {
    expect(lerp(0, 100, 1, 16.67)).toBeCloseTo(100);
  });

  it('returns current when speed is 0', () => {
    expect(lerp(50, 100, 0, 16.67)).toBe(50);
  });

  it('moves toward target at default dt', () => {
    const result = lerp(0, 100, 0.1);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(100);
    expect(result).toBeCloseTo(10, 0);
  });

  it('moves more at higher dt (lower framerate)', () => {
    const at60fps = lerp(0, 100, 0.1, 16.67);
    const at30fps = lerp(0, 100, 0.1, 33.33);
    expect(at30fps).toBeGreaterThan(at60fps);
  });

  it('converges after many frames', () => {
    let v = 0;
    for (let i = 0; i < 200; i++) v = lerp(v, 100, 0.08, 16.67);
    expect(v).toBeCloseTo(100, 1);
  });
});

// -- quantize --

describe('quantize', () => {
  it('snaps to the nearest 1/64 step by default', () => {
    expect(quantize(0.5)).toBe(0.5); // exact step
    expect(quantize(0.501)).toBeCloseTo(0.5, 5);
    expect(quantize(1 / 64 + 0.001)).toBeCloseTo(1 / 64, 5);
  });

  it('is idempotent (quantizing a quantized value is a no-op)', () => {
    const q = quantize(0.3333);
    expect(quantize(q)).toBe(q);
  });

  it('preserves the endpoints 0 and 1', () => {
    expect(quantize(0)).toBe(0);
    expect(quantize(1)).toBe(1);
  });

  it('respects a custom step count', () => {
    expect(quantize(0.26, 4)).toBe(0.25); // nearest quarter
    expect(quantize(0.4, 2)).toBe(0.5); // nearest half
  });

  it('two inputs within the same step produce identical output (the whole point: cache-key stability)', () => {
    const a = quantize(0.503);
    const b = quantize(0.507);
    expect(a).toBe(b);
  });
});

// -- computeRange --

describe('computeRange', () => {
  const pts = (values: number[]): LivelinePoint[] =>
    values.map((v, i) => ({ time: i, value: v }));

  it('adds margin around data', () => {
    const { min, max } = computeRange(pts([10, 20]), 15);
    expect(min).toBeLessThan(10);
    expect(max).toBeGreaterThan(20);
  });

  it('includes current value in range', () => {
    const { max } = computeRange(pts([10, 20]), 25);
    expect(max).toBeGreaterThan(25);
  });

  it('includes reference value in range', () => {
    const { min } = computeRange(pts([10, 20]), 15, 5);
    expect(min).toBeLessThan(5);
  });

  it('enforces minimum range for flat data', () => {
    const { min, max } = computeRange(pts([10, 10, 10]), 10);
    expect(max - min).toBeGreaterThan(0);
  });

  it('returns symmetric range for single-value data', () => {
    const { min, max } = computeRange(pts([50]), 50);
    const mid = (min + max) / 2;
    expect(mid).toBeCloseTo(50, 1);
  });
});

// -- detectMomentum --

describe('detectMomentum', () => {
  const pts = (values: number[]): LivelinePoint[] =>
    values.map((v, i) => ({ time: i, value: v }));

  it('returns flat with fewer than 5 points', () => {
    expect(detectMomentum(pts([1, 2, 3]))).toBe('flat');
  });

  it('detects upward momentum', () => {
    expect(detectMomentum(pts([10, 11, 12, 13, 14, 15, 20]))).toBe('up');
  });

  it('detects downward momentum', () => {
    expect(detectMomentum(pts([20, 19, 18, 17, 16, 15, 10]))).toBe('down');
  });

  it('returns flat for stable data', () => {
    // Tail (last 5) delta must be < 30% of lookback range to be flat
    expect(detectMomentum(pts([10, 10.1, 10.2, 10.05, 10.15, 10.1]))).toBe(
      'flat'
    );
  });

  it('returns flat for all identical values', () => {
    expect(detectMomentum(pts([5, 5, 5, 5, 5, 5]))).toBe('flat');
  });
});

// -- interpolateAtTime --

describe('interpolateAtTime', () => {
  const pts: LivelinePoint[] = [
    { time: 0, value: 0 },
    { time: 1, value: 10 },
    { time: 2, value: 20 },
    { time: 3, value: 30 },
  ];

  it('returns null for empty array', () => {
    expect(interpolateAtTime([], 1)).toBeNull();
  });

  it('clamps to first value before range', () => {
    expect(interpolateAtTime(pts, -1)).toBe(0);
  });

  it('clamps to last value after range', () => {
    expect(interpolateAtTime(pts, 5)).toBe(30);
  });

  it('interpolates midpoint', () => {
    expect(interpolateAtTime(pts, 0.5)).toBeCloseTo(5);
  });

  it('returns exact value at data point', () => {
    expect(interpolateAtTime(pts, 2)).toBeCloseTo(20);
  });

  it('interpolates between non-uniform points', () => {
    const irregular: LivelinePoint[] = [
      { time: 0, value: 0 },
      { time: 10, value: 100 },
    ];
    expect(interpolateAtTime(irregular, 3)).toBeCloseTo(30);
  });
});

// -- niceTimeInterval --

describe('niceTimeInterval', () => {
  it('returns 2s for very short windows', () => {
    expect(niceTimeInterval(10)).toBe(2);
  });

  it('returns 5s for 30s window', () => {
    expect(niceTimeInterval(30)).toBe(5);
  });

  it('returns 10s for 1min window', () => {
    expect(niceTimeInterval(60)).toBe(10);
  });

  it('returns 1hr for 12hr window', () => {
    expect(niceTimeInterval(43200)).toBe(3600);
  });

  it('returns 1day for 1week window', () => {
    expect(niceTimeInterval(604800)).toBe(86400);
  });

  it('always returns a positive number', () => {
    for (const w of [1, 10, 60, 300, 3600, 86400, 604800, 999999]) {
      expect(niceTimeInterval(w)).toBeGreaterThan(0);
    }
  });
});

// -- drawSpline --

describe('drawSpline', () => {
  const recorder = () => {
    const calls: { op: 'lineTo' | 'cubicTo'; args: number[] }[] = [];
    const path: SplinePath = {
      lineTo: (x, y) => calls.push({ op: 'lineTo', args: [x, y] }),
      cubicTo: (...args) => calls.push({ op: 'cubicTo', args }),
    };
    return { path, calls };
  };

  it('does nothing with fewer than 2 points', () => {
    const { path, calls } = recorder();
    drawSpline(path, [[0, 0]]);
    expect(calls).toHaveLength(0);
  });

  it('draws a straight segment for exactly 2 points', () => {
    const { path, calls } = recorder();
    drawSpline(path, [
      [0, 0],
      [10, 5],
    ]);
    expect(calls).toEqual([{ op: 'lineTo', args: [10, 5] }]);
  });

  it('emits one cubic per segment for 3+ points', () => {
    const { path, calls } = recorder();
    drawSpline(path, [
      [0, 0],
      [10, 5],
      [20, 3],
      [30, 8],
    ]);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.op === 'cubicTo')).toBe(true);
    // Each cubic ends exactly on the next data point
    expect(calls[0]!.args.slice(4)).toEqual([10, 5]);
    expect(calls[2]!.args.slice(4)).toEqual([30, 8]);
  });

  it('never overshoots local extrema (monotone property)', () => {
    // Sample the cubics densely and check bounds
    const pts: [number, number][] = [
      [0, 0],
      [10, 10],
      [20, 10],
      [30, 0],
    ];
    const { path, calls } = recorder();
    drawSpline(path, pts);
    let prev: [number, number] = pts[0]!;
    for (const c of calls) {
      const [, y1, , y2, x3, y3] = c.args as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      for (let t = 0; t <= 1; t += 0.05) {
        const mt = 1 - t;
        const y =
          mt * mt * mt * prev[1] +
          3 * mt * mt * t * y1 +
          3 * mt * t * t * y2 +
          t * t * t * y3;
        expect(y).toBeGreaterThanOrEqual(-0.001);
        expect(y).toBeLessThanOrEqual(10.001);
      }
      prev = [x3, y3];
    }
  });
});

// -- computeSplineTangents / emitSplineSegments --

describe('computeSplineTangents + emitSplineSegments', () => {
  const recorder = () => {
    const calls: { op: 'cubicTo'; args: number[] }[] = [];
    const path: SplinePath = {
      lineTo: () => {
        throw new Error('emitSplineSegments should never call lineTo');
      },
      cubicTo: (...args) => calls.push({ op: 'cubicTo', args }),
    };
    return { path, calls };
  };

  const pts: [number, number][] = [
    [0, 0],
    [10, 5],
    [20, 3],
    [30, 8],
    [40, 1],
  ];

  it('composes to the exact same output as drawSpline at full count', () => {
    const full = recorder();
    drawSpline(full.path, pts);

    const composed = recorder();
    const { m, h } = computeSplineTangents(pts);
    emitSplineSegments(composed.path, pts, m, h);

    expect(composed.calls).toEqual(full.calls);
  });

  it('an explicit count equal to pts.length matches the implicit default', () => {
    const a = recorder();
    const { m: mA, h: hA } = computeSplineTangents(pts);
    emitSplineSegments(a.path, pts, mA, hA);

    const b = recorder();
    const { m: mB, h: hB } = computeSplineTangents(pts, pts.length);
    emitSplineSegments(b.path, pts, mB, hB, pts.length);

    expect(b.calls).toEqual(a.calls);
  });

  it('count truncates to a prefix: matches drawSpline run on that prefix', () => {
    // This is exactly how the line path cache builds its cached prefix —
    // over all but the last two (moving) points.
    const prefixCount = pts.length - 2;
    const prefix = pts.slice(0, prefixCount);

    const viaPrefixArray = recorder();
    drawSpline(viaPrefixArray.path, prefix);

    const viaCount = recorder();
    const { m, h } = computeSplineTangents(pts, prefixCount);
    emitSplineSegments(viaCount.path, pts, m, h, prefixCount);

    expect(viaCount.calls).toEqual(viaPrefixArray.calls);
    // And the truncated tangent/interval arrays are exactly prefixCount /
    // prefixCount-1 long — nothing computed past the requested count.
    expect(m).toHaveLength(prefixCount);
    expect(h).toHaveLength(prefixCount - 1);
  });

  it('emitSplineSegments with count=2 emits exactly one segment', () => {
    const { path, calls } = recorder();
    const { m, h } = computeSplineTangents(pts, 2);
    emitSplineSegments(path, pts, m, h, 2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(4)).toEqual(pts[1]);
  });

  it('the alpha²+beta²≤9 constraint clamps an overshoot-prone tangent (steep segment into a near-flat one)', () => {
    // A steep rise (delta=10) straight into a near-flat run (delta=0.01):
    // the naive averaged tangent at the join, (10 + 0.01) / 2 = 5.005, is
    // wildly disproportionate to the flat segment it feeds into and would
    // overshoot it — this is exactly the shape the Fritsch-Carlson
    // constraint exists to catch.
    const steepThenFlat: [number, number][] = [
      [0, 0],
      [1, 10],
      [2, 10.01],
      [3, 10.02],
    ];
    const { m } = computeSplineTangents(steepThenFlat);
    expect(m[1]).not.toBeCloseTo(5.005, 2); // the clamp must have engaged

    // Verify the actual constraint it enforces, from the formula: for the
    // flat segment (index 1), alpha² + beta² ≤ 9 — equality once clamped.
    const delta1 =
      (steepThenFlat[2]![1] - steepThenFlat[1]![1]) /
      (steepThenFlat[2]![0] - steepThenFlat[1]![0]);
    const alpha = m[1]! / delta1;
    const beta = m[2]! / delta1;
    expect(alpha * alpha + beta * beta).toBeCloseTo(9, 6);
  });

  it('a zero-width segment (two points sharing the same x — a duplicate timestamp) produces a zero slope, not NaN/Infinity', () => {
    const dupX: [number, number][] = [
      [0, 0],
      [5, 5],
      [5, 8], // same x as the previous point
      [10, 10],
    ];
    const { m, h } = computeSplineTangents(dupX);
    expect(h[1]).toBe(0);
    expect(m.every((v) => Number.isFinite(v))).toBe(true);
    expect(h.every((v) => Number.isFinite(v))).toBe(true);
  });
});

// -- drawSplineTail --

describe('drawSplineTail', () => {
  const recorder = () => {
    const calls: { op: 'lineTo' | 'cubicTo'; args: number[] }[] = [];
    const path: SplinePath = {
      lineTo: (x, y) => calls.push({ op: 'lineTo', args: [x, y] }),
      cubicTo: (...args) => calls.push({ op: 'cubicTo', args }),
    };
    return { path, calls };
  };

  it('emits two cubics on the normal (monotone-increasing x) path', () => {
    const { path, calls } = recorder();
    drawSplineTail(path, 0, 0, 1, 10, 8, 20, 20);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.op === 'cubicTo')).toBe(true);
    expect(calls[0]!.args.slice(4)).toEqual([10, 8]); // ends at the last data point
    expect(calls[1]!.args.slice(4)).toEqual([20, 20]); // ends at the live tip
  });

  it('the first cubic’s incoming control point uses mCut verbatim (C1 continuity at the cut)', () => {
    const { path, calls } = recorder();
    const cutX = 5;
    const cutY = 2;
    const mCut = 1.5;
    const h0 = 10 - cutX;
    drawSplineTail(path, cutX, cutY, mCut, 10, 8, 20, 20);
    const first = calls[0]!.args;
    // Control point 1 = (cutX + h0/3, cutY + mCut*h0/3) — the exact formula
    // drawSpline itself uses for a segment's leading control point.
    expect(first[0]).toBeCloseTo(cutX + h0 / 3, 9);
    expect(first[1]).toBeCloseTo(cutY + (mCut * h0) / 3, 9);
  });

  it('degenerate ordering (x1 <= cutX) falls back to two straight lineTos, no cubics', () => {
    const { path, calls } = recorder();
    drawSplineTail(path, 10, 5, 1, 10, 8, 20, 20); // x1 === cutX
    expect(calls).toEqual([
      { op: 'lineTo', args: [10, 8] },
      { op: 'lineTo', args: [20, 20] },
    ]);
  });

  it('degenerate ordering (x1 < cutX) also falls back to lineTos', () => {
    const { path, calls } = recorder();
    drawSplineTail(path, 10, 5, 1, 5, 8, 20, 20);
    expect(calls).toEqual([
      { op: 'lineTo', args: [5, 8] },
      { op: 'lineTo', args: [20, 20] },
    ]);
  });

  it('a stalled tip (x2 <= x1, e.g. reveal/paused edge case) emits one cubic then a lineTo', () => {
    const { path, calls } = recorder();
    drawSplineTail(path, 0, 0, 1, 10, 8, 10, 8); // tip hasn't advanced past the last point
    expect(calls).toHaveLength(2);
    expect(calls[0]!.op).toBe('cubicTo');
    expect(calls[0]!.args.slice(4)).toEqual([10, 8]);
    expect(calls[1]).toEqual({ op: 'lineTo', args: [10, 8] });
  });

  it('the interior tangent (m1) never exceeds the three-times monotonicity limit', () => {
    // A sharp direction change right at the cut — the averaged secant would
    // overshoot without clamping.
    const { path, calls } = recorder();
    const cutX = 0;
    const cutY = 0;
    drawSplineTail(path, cutX, cutY, 0, 1, 100, 2, 100.01);
    const d0 = (100 - cutY) / (1 - cutX);
    const d1 = (100.01 - 100) / (2 - 1);
    const lim = 3 * Math.min(Math.abs(d0), Math.abs(d1));
    // m1 is embedded in the first cubic's outgoing control point:
    // y1 - (m1 * h0) / 3 = args[3], with h0 = x1 - cutX = 1.
    const impliedM1 = ((100 - calls[0]!.args[3]!) * 3) / 1;
    expect(Math.abs(impliedM1)).toBeLessThanOrEqual(lim + 1e-9);
  });

  it('the clamp also engages on the negative side (steep descent into a near-flat one)', () => {
    const { path, calls } = recorder();
    const cutX = 0;
    const cutY = 0;
    drawSplineTail(path, cutX, cutY, 0, 1, -100, 2, -100.01);
    const d0 = (-100 - cutY) / (1 - cutX);
    const d1 = (-100.01 - -100) / (2 - 1);
    const lim = 3 * Math.min(Math.abs(d0), Math.abs(d1));
    const impliedM1 = ((-100 - calls[0]!.args[3]!) * 3) / 1;
    expect(impliedM1).toBeLessThan(0); // clamped to -lim, not zeroed
    expect(Math.abs(impliedM1)).toBeCloseTo(lim, 9);
  });

  it('opposite-signed secants (a local extremum at the cut) zero the interior tangent', () => {
    const { path, calls } = recorder();
    // Rising into the cut, falling out of it — d0 > 0, d1 < 0 at the join.
    drawSplineTail(path, 0, 0, 1, 10, 10, 20, 0);
    const h0 = 10;
    const impliedM1 = ((10 - calls[0]!.args[3]!) * 3) / h0;
    expect(impliedM1).toBeCloseTo(0, 9);
  });
});

// -- decimateMinMax --

describe('decimateMinMax', () => {
  const pts = (values: number[]): LivelinePoint[] =>
    values.map((v, i) => ({ time: i, value: v }));

  it('returns the input unchanged (same reference) when at or below the pixel budget', () => {
    const input = pts([1, 5, 3, 8, 2]);
    const result = decimateMinMax(input, 400);
    expect(result).toBe(input); // same reference, not just equal content
  });

  it('returns the input unchanged when length exactly equals chartW', () => {
    const input = pts(Array.from({ length: 100 }, (_, i) => i));
    const result = decimateMinMax(input, 100);
    expect(result).toBe(input);
  });

  it('preserves the first and last elements exactly when decimating', () => {
    const input = pts(Array.from({ length: 5000 }, (_, i) => Math.sin(i)));
    const result = decimateMinMax(input, 100);
    expect(result[0]).toBe(input[0]);
    expect(result[result.length - 1]).toBe(input[input.length - 1]);
  });

  it('produces chronologically monotonic output (required by drawSpline)', () => {
    const input = pts(Array.from({ length: 3000 }, () => Math.random() * 100));
    const result = decimateMinMax(input, 150);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.time).toBeGreaterThanOrEqual(result[i - 1]!.time);
    }
  });

  it('has no duplicate points despite first/last special-casing', () => {
    const input = pts(Array.from({ length: 2000 }, (_, i) => i % 7));
    const result = decimateMinMax(input, 80);
    const seen = new Set(result.map((p) => p.time));
    expect(seen.size).toBe(result.length);
  });

  it('a synthetic spike mid-array survives decimation', () => {
    const values = Array.from({ length: 4000 }, () => 10);
    const spikeIndex = 2137;
    values[spikeIndex] = 9999;
    const input = pts(values);
    const result = decimateMinMax(input, 200);
    expect(result.some((p) => p.value === 9999)).toBe(true);
  });

  it('a synthetic dip mid-array (negative spike) survives decimation', () => {
    const values = Array.from({ length: 4000 }, () => 10);
    const dipIndex = 913;
    values[dipIndex] = -9999;
    const input = pts(values);
    const result = decimateMinMax(input, 200);
    expect(result.some((p) => p.value === -9999)).toBe(true);
  });

  it('bounds output length to roughly 2x buckets plus a small constant', () => {
    const input = pts(Array.from({ length: 8000 }, (_, i) => i % 50));
    const chartW = 300;
    const result = decimateMinMax(input, chartW);
    expect(result.length).toBeLessThanOrEqual(chartW * 2 + 2);
  });

  it('decimates dense input (10k points, chartW 400) to the expected order of magnitude', () => {
    const input = pts(
      Array.from({ length: 10000 }, (_, i) => Math.sin(i * 0.01) * 100)
    );
    const chartW = 400;
    const result = decimateMinMax(input, chartW);
    // Should be dramatically smaller than the input, and in the same
    // ballpark as chartW (bounded above by 2*chartW + 2), not e.g. still
    // thousands of points.
    expect(result.length).toBeLessThan(input.length / 5);
    expect(result.length).toBeLessThanOrEqual(chartW * 2 + 2);
    expect(result.length).toBeGreaterThan(chartW / 4);
  });

  it('handles all-identical timestamps without throwing or producing NaN buckets', () => {
    const input: LivelinePoint[] = Array.from({ length: 500 }, (_, i) => ({
      time: 42,
      value: i,
    }));
    const result = decimateMinMax(input, 50);
    expect(result[0]).toBe(input[0]);
    expect(result[result.length - 1]).toBe(input[input.length - 1]);
    expect(result.every((p) => Number.isFinite(p.value))).toBe(true);
  });

  it('a duplicate timestamp at the tail (a same-instant burst tick) is not dropped by the bucket-index clamp', () => {
    // The interior loop excludes index n-1 (`last`) but not n-2 — if an
    // interior point shares `last`'s exact timestamp (two ticks landing in
    // the same instant, which real feeds do produce), its raw bucket index
    // computes to exactly `bucketCount` (one past the last valid bucket)
    // and must be clamped rather than silently indexing out of bounds.
    // Chosen so the division is exact (64 / 8 = 8), not a float-rounding
    // fluke: first.time=0, last.time=64, chartW=8 → bucketWidth=8 exactly.
    const input: LivelinePoint[] = [{ time: 0, value: 0 }];
    for (let i = 1; i <= 6; i++) input.push({ time: i * 9, value: i });
    input.push({ time: 64, value: 999 }); // interior, time === last.time
    input.push({ time: 64, value: 1000 }); // the actual last
    const result = decimateMinMax(input, 8);
    expect(result[0]).toBe(input[0]);
    expect(result[result.length - 1]).toBe(input[input.length - 1]);
    // The duplicated interior point must still show up somewhere — proof
    // it landed in the clamped bucket instead of an out-of-bounds slot
    // that's never read back.
    expect(result.some((p) => p.value === 999)).toBe(true);
  });

  // -- bucketSecs: absolute-time-aligned grid --

  describe('with bucketSecs (absolute grid)', () => {
    it('uses exactly `count` buckets at the fallback boundary (count === chartW*4), and falls back to chartW buckets just past it', () => {
      const chartW = 10;
      const bucketSecs = 1;
      // Dense, alternating values so every ~1s bucket contributes 2 distinct
      // points (a min and a max) — bucket count becomes directly observable
      // via output length, without inspecting internals.
      const dense = (span: number): LivelinePoint[] =>
        Array.from({ length: 4000 }, (_, i) => ({
          time: (i / 3999) * span,
          value: i % 2 === 0 ? 0 : 1,
        }));

      // count = floor(39.5/1) - floor(0/1) + 1 = 40 === chartW*4 → still the
      // absolute grid: up to 40 buckets, output length can exceed 2*chartW+2.
      const atBoundary = decimateMinMax(dense(39.5), chartW, bucketSecs);
      expect(atBoundary.length).toBeGreaterThan(chartW * 2 + 2);

      // count = floor(40.5/1) - floor(0/1) + 1 = 41 > chartW*4 → falls back
      // to the relative grid: exactly chartW buckets, output length bounded.
      const pastBoundary = decimateMinMax(dense(40.5), chartW, bucketSecs);
      expect(pastBoundary.length).toBeLessThanOrEqual(chartW * 2 + 2);
    });

    it('bucket boundaries are pinned to absolute time, not the window start', () => {
      // Two windows over the same underlying 1Hz grid, offset by a
      // non-bucket-aligned amount — points that fall in the same absolute
      // 1-second bucket in both windows must decimate to the same selection
      // wherever the windows overlap (this is the whole point: it's what
      // lets a scrolling chart reuse a cached spline path between ticks).
      const chartW = 20;
      const bucketSecs = 1;
      const all: LivelinePoint[] = Array.from({ length: 200 }, (_, i) => ({
        time: i * 0.1,
        value: Math.sin(i * 0.31) * 10,
      }));
      const windowA = all.slice(0, 150); // t in [0, 14.9]
      const windowB = all.slice(20, 170); // t in [2.0, 16.9]

      const outA = decimateMinMax(windowA, chartW, bucketSecs);
      const outB = decimateMinMax(windowB, chartW, bucketSecs);

      // Interior selections (excluding each window's own first/last, which
      // are window-dependent by contract) agree wherever both windows had
      // full, comparable bucket coverage — away from either edge.
      const key = (p: LivelinePoint) => `${p.time}:${p.value}`;
      const overlapStart = windowB[0]!.time + bucketSecs;
      const overlapEnd = windowA[windowA.length - 1]!.time - bucketSecs;
      const selA = new Set(
        outA
          .slice(1, -1)
          .filter((p) => p.time >= overlapStart && p.time <= overlapEnd)
          .map(key)
      );
      const selB = new Set(
        outB
          .slice(1, -1)
          .filter((p) => p.time >= overlapStart && p.time <= overlapEnd)
          .map(key)
      );
      expect(selA.size).toBeGreaterThan(0); // sanity: the overlap isn't empty
      expect(selA).toEqual(selB);
    });

    it('a spike survives decimation under the absolute grid too', () => {
      const input: LivelinePoint[] = Array.from({ length: 500 }, (_, i) => ({
        time: i * 0.5,
        value: Math.sin(i * 0.7) * 10,
      }));
      input[250] = { time: input[250]!.time, value: 99 };
      const out = decimateMinMax(input, 40, 6);
      expect(out.length).toBeLessThan(input.length);
      expect(out[0]).toBe(input[0]);
      expect(out[out.length - 1]).toBe(input[input.length - 1]);
      expect(out.some((p) => p.value === 99)).toBe(true);
      for (let i = 1; i < out.length; i++) {
        expect(out[i]!.time).toBeGreaterThanOrEqual(out[i - 1]!.time);
      }
    });

    it('falls back to the relative grid (still correct) when bucketSecs would need more than chartW*4 buckets', () => {
      const input: LivelinePoint[] = Array.from({ length: 2000 }, (_, i) => ({
        time: i, // spans 0..1999
        value: Math.sin(i * 0.05) * 10,
      }));
      // bucketSecs=1 over a 2000s span needs ~2000 buckets — far past
      // chartW*4 (400) — so this must fall back, not allocate ~2000-length
      // index arrays.
      const result = decimateMinMax(input, 100, 1);
      expect(result[0]).toBe(input[0]);
      expect(result[result.length - 1]).toBe(input[input.length - 1]);
      expect(result.length).toBeLessThanOrEqual(100 * 2 + 2);
    });
  });
});
