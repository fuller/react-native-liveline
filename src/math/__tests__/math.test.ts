import { lerp } from '../lerp';
import { computeRange } from '../range';
import { detectMomentum } from '../momentum';
import { interpolateAtTime } from '../interpolate';
import { niceTimeInterval } from '../intervals';
import { drawSpline, type SplinePath } from '../spline';
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
});
