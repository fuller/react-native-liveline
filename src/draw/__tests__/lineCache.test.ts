import {
  createLineCacheSlot,
  updateLinePaths,
  lineCacheHits,
  assembleLineTail,
  MIN_CACHE_POINTS,
  type CachePath,
} from '../lineCache';
import { drawSpline } from '../../math/spline';
import type { ChartLayout, LivelinePoint, Padding } from '../../types';

// ── Fakes ──────────────────────────────────────────────────────────────────

interface Verb {
  op: 'M' | 'L' | 'C' | 'Z' | 'A';
  c: number[];
}

class FakePath implements CachePath {
  verbs: Verb[] = [];
  rewinds = 0;

  moveTo(x: number, y: number) {
    this.verbs.push({ op: 'M', c: [x, y] });
  }
  lineTo(x: number, y: number) {
    this.verbs.push({ op: 'L', c: [x, y] });
  }
  cubicTo(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number
  ) {
    this.verbs.push({ op: 'C', c: [x1, y1, x2, y2, x3, y3] });
  }
  close() {
    this.verbs.push({ op: 'Z', c: [] });
  }
  arcToTangent(x1: number, y1: number, x2: number, y2: number, r: number) {
    this.verbs.push({ op: 'A', c: [x1, y1, x2, y2, r] });
  }
  rewind() {
    this.verbs.length = 0;
    this.rewinds++;
  }
  addPath(src: CachePath, _matrix?: undefined, extend?: boolean) {
    const s = src as FakePath;
    for (let i = 0; i < s.verbs.length; i++) {
      const v = s.verbs[i]!;
      if (extend === true && i === 0 && v.op === 'M') {
        this.verbs.push({ op: 'L', c: v.c.slice() });
      } else {
        this.verbs.push({ op: v.op, c: v.c.slice() });
      }
    }
  }
  offset(dx: number, dy: number) {
    for (const v of this.verbs) {
      for (let i = 0; i < v.c.length; i += 2) {
        v.c[i]! += dx;
        v.c[i + 1]! += dy;
      }
    }
  }
}

const PAD: Required<Padding> = { top: 10, right: 20, bottom: 20, left: 10 };

/** Layout matching engineStep's construction (step.ts line-mode branch). */
function makeLayout(
  now: number,
  minVal: number,
  maxVal: number,
  windowSecs = 60,
  w = 400,
  h = 200
): ChartLayout {
  const chartW = w - PAD.left - PAD.right;
  const chartH = h - PAD.top - PAD.bottom;
  const buffer = 0.05;
  const rightEdge = now + windowSecs * buffer;
  const leftEdge = rightEdge - windowSecs;
  const valRange = maxVal - minVal || 1;
  return {
    w,
    h,
    pad: PAD,
    chartW,
    chartH,
    leftEdge,
    rightEdge,
    minVal,
    maxVal,
    valRange,
    toX: (t: number) =>
      PAD.left + ((t - leftEdge) / (rightEdge - leftEdge)) * chartW,
    toY: (v: number) => PAD.top + (1 - (v - minVal) / valRange) * chartH,
  };
}

/** Screen pts as drawLine builds them (settled: no morph, clamp is a no-op). */
function buildPts(
  decimated: LivelinePoint[],
  layout: ChartLayout,
  smoothValue: number,
  now: number
): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < decimated.length; i++) {
    const p = decimated[i]!;
    const y =
      i === decimated.length - 1
        ? layout.toY(smoothValue)
        : layout.toY(p.value);
    pts.push([layout.toX(p.time), y]);
  }
  pts.push([layout.toX(now), layout.toY(smoothValue)]);
  return pts;
}

/** Smooth, gently-varying series (no FC clamping) with 1s spacing. */
function makeData(count: number, t0: number): LivelinePoint[] {
  const out: LivelinePoint[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ time: t0 + i, value: 100 + Math.sin(i * 0.4) * 5 });
  }
  return out;
}

interface Harness {
  slot: ReturnType<typeof createLineCacheSlot>;
  made: FakePath[];
  makePath: () => CachePath;
}

function makeHarness(): Harness {
  const made: FakePath[] = [];
  const makePath = () => {
    const p = new FakePath();
    made.push(p);
    return p;
  };
  return { slot: createLineCacheSlot(), made, makePath };
}

function update(
  hz: Harness,
  layout: ChartLayout,
  data: LivelinePoint[],
  smoothValue: number,
  now: number,
  wantFill = false,
  dataRev = 0,
  dataSource = 0
): boolean {
  const pts = buildPts(data, layout, smoothValue, now);
  return updateLinePaths(
    hz.slot,
    hz.makePath,
    layout,
    data,
    pts,
    wantFill,
    dataRev,
    dataSource,
    data.length,
    data[0]!.time,
    data[data.length - 1]!.time,
    data[data.length - 1]!.value
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('updateLinePaths', () => {
  const NOW = 1000;
  const N = 20;

  it('returns false below MIN_CACHE_POINTS', () => {
    const hz = makeHarness();
    const data = makeData(MIN_CACHE_POINTS - 1, NOW - 30);
    const layout = makeLayout(NOW, 90, 110);
    expect(update(hz, layout, data, data[data.length - 1]!.value, NOW)).toBe(
      false
    );
    expect(hz.made.length).toBe(0);
  });

  it('matches the full spline: shared segments exact, junction C1', () => {
    const hz = makeHarness();
    const data = makeData(N, NOW - 30);
    const smooth = data[data.length - 1]!.value; // settled
    const layout = makeLayout(NOW, 90, 110);
    const pts = buildPts(data, layout, smooth, NOW);

    expect(update(hz, layout, data, smooth, NOW)).toBe(true);
    const cached = hz.slot.scratch as FakePath;

    const full = new FakePath();
    full.moveTo(pts[0]![0], pts[0]![1]);
    drawSpline(full, pts);

    // Same verb structure: 1 moveTo + N segments (pts.length = N+1 points)
    expect(cached.verbs.length).toBe(full.verbs.length);
    expect(cached.verbs[0]!.op).toBe('M');

    // Segments 0..N-4 are untouched by the prefix cut and must match exactly
    // (the last prefix segment and the two tail segments may deviate — the
    // cut tangent is one-sided there by design).
    for (let i = 0; i <= N - 4; i++) {
      const cv = cached.verbs[i + 1]!;
      const fv = full.verbs[i + 1]!;
      expect(cv.op).toBe('C');
      for (let k = 0; k < 6; k++) {
        expect(cv.c[k]!).toBeCloseTo(fv.c[k]!, 9);
      }
    }

    // Every segment's on-curve endpoint is the original point in both builds
    for (let i = 1; i < cached.verbs.length; i++) {
      const cv = cached.verbs[i]!;
      expect(cv.c[4]!).toBeCloseTo(pts[i]![0], 9);
      expect(cv.c[5]!).toBeCloseTo(pts[i]![1], 9);
    }

    // C1 at the cut (between segment N-2 and N-1 in cached verbs): the
    // control point leaving the cut continues the tangent entering it.
    const cutIdx = N - 1; // verbs index of the last prefix segment
    const inSeg = cached.verbs[cutIdx]!;
    const outSeg = cached.verbs[cutIdx + 1]!;
    const cutX = inSeg.c[4]!;
    const cutY = inSeg.c[5]!;
    const slopeIn = (cutY - inSeg.c[3]!) / (cutX - inSeg.c[2]!);
    const slopeOut = (outSeg.c[1]! - cutY) / (outSeg.c[0]! - cutX);
    expect(slopeOut).toBeCloseTo(slopeIn, 9);
  });

  it('is translation-invariant: hit at a later now equals a fresh build', () => {
    const data = makeData(N, NOW - 30);
    const smooth = data[data.length - 1]!.value;

    const hz = makeHarness();
    expect(update(hz, makeLayout(NOW, 90, 110), data, smooth, NOW)).toBe(true);
    const madeAfterBuild = hz.made.length;

    const later = NOW + 4.2;
    expect(update(hz, makeLayout(later, 90, 110), data, smooth, later)).toBe(
      true
    );
    // Hit: no new paths, no prefix re-record
    expect(hz.made.length).toBe(madeAfterBuild);
    expect((hz.slot.prefix as FakePath).rewinds).toBe(1);
    const translated = (hz.slot.scratch as FakePath).verbs;

    const fresh = makeHarness();
    expect(update(fresh, makeLayout(later, 90, 110), data, smooth, later)).toBe(
      true
    );
    const rebuilt = (fresh.slot.scratch as FakePath).verbs;

    expect(translated.length).toBe(rebuilt.length);
    for (let i = 0; i < translated.length; i++) {
      expect(translated[i]!.op).toBe(rebuilt[i]!.op);
      for (let k = 0; k < translated[i]!.c.length; k++) {
        expect(translated[i]!.c[k]!).toBeCloseTo(rebuilt[i]!.c[k]!, 6);
      }
    }
  });

  it('rebuilds when any key input changes', () => {
    const data = makeData(N, NOW - 30);
    const smooth = data[data.length - 1]!.value;
    const base = () => makeLayout(NOW, 90, 110);

    const cases: {
      name: string;
      run: (hz: Harness) => boolean;
    }[] = [
      {
        name: 'dataRev',
        run: (hz) => update(hz, base(), data, smooth, NOW, false, 1),
      },
      {
        name: 'dataSource',
        run: (hz) => update(hz, base(), data, smooth, NOW, false, 0, 1),
      },
      {
        name: 'range min',
        run: (hz) => update(hz, makeLayout(NOW, 89, 110), data, smooth, NOW),
      },
      {
        name: 'range max',
        run: (hz) => update(hz, makeLayout(NOW, 90, 111), data, smooth, NOW),
      },
      {
        name: 'window',
        run: (hz) =>
          update(hz, makeLayout(NOW, 90, 110, 120), data, smooth, NOW),
      },
      {
        name: 'canvas size',
        run: (hz) =>
          update(hz, makeLayout(NOW, 90, 110, 60, 500), data, smooth, NOW),
      },
      {
        name: 'data tail',
        run: (hz) => {
          const grown = data.concat([{ time: NOW + 1, value: 101 }]);
          return update(hz, base(), grown, 101, NOW + 1);
        },
      },
      {
        name: 'last value',
        run: (hz) => {
          const changed = data.slice(0, -1);
          changed.push({ time: data[data.length - 1]!.time, value: 42 });
          return update(hz, base(), changed, 42, NOW);
        },
      },
    ];

    for (const c of cases) {
      const hz = makeHarness();
      update(hz, base(), data, smooth, NOW);
      const prefix = hz.slot.prefix as FakePath;
      expect(prefix.rewinds).toBe(1);
      expect(c.run(hz)).toBe(true);
      expect(prefix.rewinds).toBe(2); // key mismatch → prefix re-recorded
    }
  });

  it('does not rebuild for tail-only motion (smoothValue and now)', () => {
    const hz = makeHarness();
    const data = makeData(N, NOW - 30);
    update(hz, makeLayout(NOW, 90, 110), data, data[N - 1]!.value, NOW);
    const prefix = hz.slot.prefix as FakePath;

    // smoothValue mid-lerp, time advanced — the historical prefix stays
    update(hz, makeLayout(NOW + 0.5, 90, 110), data, 104.3, NOW + 0.5);
    expect(prefix.rewinds).toBe(1);
  });

  it('assembles the fill path with baseline closure', () => {
    const hz = makeHarness();
    const data = makeData(N, NOW - 30);
    const smooth = data[N - 1]!.value;
    const layout = makeLayout(NOW, 90, 110);
    const pts = buildPts(data, layout, smooth, NOW);
    update(hz, layout, data, smooth, NOW, true);

    const fill = (hz.slot.fillScratch as FakePath).verbs;
    const baseY = layout.h - layout.pad.bottom;
    const tip = pts[pts.length - 1]!;

    expect(fill[0]).toEqual({ op: 'M', c: [pts[0]![0], baseY] });
    expect(fill[1]).toEqual({ op: 'L', c: [pts[0]![0], pts[0]![1]] });
    // extend=true converts the stroke path's leading moveTo into a lineTo
    // landing on the same point (zero-length connector)
    expect(fill[2]).toEqual({ op: 'L', c: [pts[0]![0], pts[0]![1]] });
    expect(fill[fill.length - 2]).toEqual({ op: 'L', c: [tip[0], baseY] });
    expect(fill[fill.length - 1]!.op).toBe('Z');
    // Interior is all cubics
    for (let i = 3; i < fill.length - 2; i++) {
      expect(fill[i]!.op).toBe('C');
    }
  });
});

// lineCacheHits is the pure predicate factored out of updateLinePaths so
// drawLine's fast path (line.ts) can run the identical key check BEFORE
// building decimated/pts, instead of duplicating the comparison.
describe('lineCacheHits', () => {
  const NOW = 1000;
  const N = 20;

  it('is false on a fresh slot (no prefix built yet)', () => {
    const hz = makeHarness();
    const layout = makeLayout(NOW, 90, 110);
    expect(
      lineCacheHits(hz.slot, layout, 0, 0, N, NOW - 30, NOW - 1, 100)
    ).toBe(false);
  });

  it('is true right after a build, with the same key inputs', () => {
    const hz = makeHarness();
    const data = makeData(N, NOW - 30);
    const smooth = data[data.length - 1]!.value;
    const layout = makeLayout(NOW, 90, 110);
    expect(update(hz, layout, data, smooth, NOW)).toBe(true);

    expect(
      lineCacheHits(
        hz.slot,
        layout,
        0,
        0,
        data.length,
        data[0]!.time,
        data[data.length - 1]!.time,
        data[data.length - 1]!.value
      )
    ).toBe(true);
  });

  it('stays true at a later `now` with an unchanged layout/data (pure time advance)', () => {
    const hz = makeHarness();
    const data = makeData(N, NOW - 30);
    const smooth = data[data.length - 1]!.value;
    update(hz, makeLayout(NOW, 90, 110), data, smooth, NOW);

    const laterLayout = makeLayout(NOW + 4.2, 90, 110);
    expect(
      lineCacheHits(
        hz.slot,
        laterLayout,
        0,
        0,
        data.length,
        data[0]!.time,
        data[data.length - 1]!.time,
        data[data.length - 1]!.value
      )
    ).toBe(true);
  });

  it('is false when any key input changes (dataRev, dataSource, range, window, size, len)', () => {
    const hz = makeHarness();
    const data = makeData(N, NOW - 30);
    const smooth = data[data.length - 1]!.value;
    const layout = makeLayout(NOW, 90, 110);
    update(hz, layout, data, smooth, NOW);

    const firstT = data[0]!.time;
    const lastT = data[data.length - 1]!.time;
    const lastV = data[data.length - 1]!.value;

    expect(
      lineCacheHits(hz.slot, layout, 1, 0, data.length, firstT, lastT, lastV)
    ).toBe(false); // dataRev
    expect(
      lineCacheHits(hz.slot, layout, 0, 1, data.length, firstT, lastT, lastV)
    ).toBe(false); // dataSource
    expect(
      lineCacheHits(
        hz.slot,
        makeLayout(NOW, 89, 110),
        0,
        0,
        data.length,
        firstT,
        lastT,
        lastV
      )
    ).toBe(false); // range min
    expect(
      lineCacheHits(
        hz.slot,
        makeLayout(NOW, 90, 110, 120),
        0,
        0,
        data.length,
        firstT,
        lastT,
        lastV
      )
    ).toBe(false); // window
    expect(
      lineCacheHits(
        hz.slot,
        makeLayout(NOW, 90, 110, 60, 500),
        0,
        0,
        data.length,
        firstT,
        lastT,
        lastV
      )
    ).toBe(false); // canvas size
    expect(
      lineCacheHits(
        hz.slot,
        layout,
        0,
        0,
        data.length + 1,
        firstT,
        lastT,
        lastV
      )
    ).toBe(false); // len
  });

  it('is allocation-free and read-only (no new paths, slot untouched)', () => {
    const hz = makeHarness();
    const data = makeData(N, NOW - 30);
    const smooth = data[data.length - 1]!.value;
    const layout = makeLayout(NOW, 90, 110);
    update(hz, layout, data, smooth, NOW);
    const madeAfterBuild = hz.made.length;
    const prefixVerbsBefore = (hz.slot.prefix as FakePath).verbs.length;

    lineCacheHits(
      hz.slot,
      layout,
      0,
      0,
      data.length,
      data[0]!.time,
      data[data.length - 1]!.time,
      data[data.length - 1]!.value
    );

    expect(hz.made.length).toBe(madeAfterBuild);
    expect((hz.slot.prefix as FakePath).verbs.length).toBe(prefixVerbsBefore);
  });
});

// assembleLineTail is the lean fast-path assembly drawLine calls directly
// once it already knows (via lineCacheHits) that the prefix is valid —
// skipping decimateMinMax and the interior points loop entirely, needing
// only the two points that move frame to frame. These tests prove it's
// bit-for-bit equivalent to going through the full updateLinePaths hit path.
describe('assembleLineTail (fast path)', () => {
  const NOW = 1000;
  const N = 20;

  it('matches updateLinePaths’s hit-path output exactly (stroke + fill)', () => {
    const data = makeData(N, NOW - 30);
    const smooth = data[data.length - 1]!.value;
    const buildLayout = makeLayout(NOW, 90, 110);
    const later = NOW + 4.2;
    const laterLayout = makeLayout(later, 90, 110);

    // Reference: full path through updateLinePaths (build, then a hit frame).
    const full = makeHarness();
    update(full, buildLayout, data, smooth, NOW, true);
    expect(update(full, laterLayout, data, smooth, later, true)).toBe(true);
    const fullScratch = (full.slot.scratch as FakePath).verbs;
    const fullFill = (full.slot.fillScratch as FakePath).verbs;

    // Fast path: build once, then lineCacheHits + assembleLineTail directly
    // with just the two tail points — exactly what drawLine's early-hit
    // branch does, without ever constructing decimated/pts.
    const fast = makeHarness();
    update(fast, buildLayout, data, smooth, NOW, true);
    expect(
      lineCacheHits(
        fast.slot,
        laterLayout,
        0,
        0,
        data.length,
        data[0]!.time,
        data[data.length - 1]!.time,
        data[data.length - 1]!.value
      )
    ).toBe(true);

    const pts = buildPts(data, laterLayout, smooth, later);
    const madeBeforeAssemble = fast.made.length;
    assembleLineTail(
      fast.slot,
      fast.makePath,
      laterLayout,
      true, // wantFill
      pts[pts.length - 2]![0],
      pts[pts.length - 2]![1],
      pts[pts.length - 1]![0],
      pts[pts.length - 1]![1],
      pts[0]![1]
    );

    // No new native path objects made on the fast path — scratch/fillScratch
    // are reused in place, and the prefix isn't touched at all.
    expect(fast.made.length).toBe(madeBeforeAssemble);

    const fastScratch = (fast.slot.scratch as FakePath).verbs;
    const fastFill = (fast.slot.fillScratch as FakePath).verbs;

    expect(fastScratch.length).toBe(fullScratch.length);
    for (let i = 0; i < fastScratch.length; i++) {
      expect(fastScratch[i]!.op).toBe(fullScratch[i]!.op);
      for (let k = 0; k < fastScratch[i]!.c.length; k++) {
        expect(fastScratch[i]!.c[k]!).toBeCloseTo(fullScratch[i]!.c[k]!, 9);
      }
    }

    expect(fastFill.length).toBe(fullFill.length);
    for (let i = 0; i < fastFill.length; i++) {
      expect(fastFill[i]!.op).toBe(fullFill[i]!.op);
      for (let k = 0; k < fastFill[i]!.c.length; k++) {
        expect(fastFill[i]!.c[k]!).toBeCloseTo(fullFill[i]!.c[k]!, 9);
      }
    }
  });

  it('never touches slot.prefix — only reuses it', () => {
    const hz = makeHarness();
    const data = makeData(N, NOW - 30);
    const smooth = data[data.length - 1]!.value;
    update(hz, makeLayout(NOW, 90, 110), data, smooth, NOW);
    const prefix = hz.slot.prefix as FakePath;
    expect(prefix.rewinds).toBe(1);

    const laterLayout = makeLayout(NOW + 2, 90, 110);
    const pts = buildPts(data, laterLayout, smooth, NOW + 2);
    assembleLineTail(
      hz.slot,
      hz.makePath,
      laterLayout,
      false,
      pts[pts.length - 2]![0],
      pts[pts.length - 2]![1],
      pts[pts.length - 1]![0],
      pts[pts.length - 1]![1],
      0
    );

    expect(prefix.rewinds).toBe(1); // untouched — prefix was never rebuilt
  });

  it('is translation-invariant, same as the full hit path', () => {
    const data = makeData(N, NOW - 30);
    const smooth = data[data.length - 1]!.value;
    const buildLayout = makeLayout(NOW, 90, 110);
    const later = NOW + 4.2;
    const laterLayout = makeLayout(later, 90, 110);

    // Fresh build at `later` (no cache history) — this is the ground truth
    // for what the geometry at `later` should look like.
    const fresh = makeHarness();
    expect(update(fresh, laterLayout, data, smooth, later)).toBe(true);
    const rebuilt = (fresh.slot.scratch as FakePath).verbs;

    // Build at NOW, then reach `later` purely through assembleLineTail.
    const fast = makeHarness();
    update(fast, buildLayout, data, smooth, NOW);
    const pts = buildPts(data, laterLayout, smooth, later);
    assembleLineTail(
      fast.slot,
      fast.makePath,
      laterLayout,
      false,
      pts[pts.length - 2]![0],
      pts[pts.length - 2]![1],
      pts[pts.length - 1]![0],
      pts[pts.length - 1]![1],
      pts[0]![1]
    );
    const translated = (fast.slot.scratch as FakePath).verbs;

    expect(translated.length).toBe(rebuilt.length);
    for (let i = 0; i < translated.length; i++) {
      expect(translated[i]!.op).toBe(rebuilt[i]!.op);
      for (let k = 0; k < translated[i]!.c.length; k++) {
        expect(translated[i]!.c[k]!).toBeCloseTo(rebuilt[i]!.c[k]!, 6);
      }
    }
  });
});

// decimateMinMax's own correctness (including the bucketSecs absolute-grid
// path) is covered in math/__tests__/math.test.ts, next to its other tests —
// this file only tests what's specific to the cache built on top of it.
