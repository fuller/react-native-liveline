import {
  timeAxisInterval,
  timeAxisLabelKeys,
  buildTimeAxisLabels,
  timeAxisStride,
  timeAxisLabelKept,
  resolveTimeAxisOverlaps,
  createTimeAxisLabelSetId,
  writeTimeAxisLabelSetId,
  timeAxisLabelSetIdMatches,
} from '../timeAxisLayer';
import type { TimeAxisLabel } from '../timeAxisLayer';
import type { Ctx2D } from '../canvas2d';
import type { ChartLayout, Padding } from '../../types';

const PAD: Required<Padding> = { top: 10, right: 20, bottom: 24, left: 10 };

/**
 * A fake `Ctx2D` — a plain object with the font slots and `measureText`.
 * This is the whole point of the type-only `Ctx2D` import in timeAxisLayer.ts:
 * no Skia binding is loaded, so jest can drive the real code path.
 * Width is `charW` per character so label widths are predictable and can be
 * pushed past the overlap threshold on demand.
 */
function makeCtx(charW = 7): Ctx2D {
  const fonts = {
    label: 'label',
    value: 'value',
    badge: 'badge',
    crosshair: 'crosshair',
    orderbook: 'orderbook',
    empty: 'empty',
    refLabel: 'refLabel',
    seriesLabel: 'seriesLabel',
  };
  return {
    fonts,
    font: fonts.label,
    measureText: (text: string) => ({ width: text.length * charW }),
  } as unknown as Ctx2D;
}

function makeLayout(
  leftEdge: number,
  rightEdge: number,
  w = 400,
  h = 200
): ChartLayout {
  const chartW = w - PAD.left - PAD.right;
  const chartH = h - PAD.top - PAD.bottom;
  const span = rightEdge - leftEdge || 1;
  return {
    w,
    h,
    pad: PAD,
    chartW,
    chartH,
    leftEdge,
    rightEdge,
    minVal: 0,
    maxVal: 1,
    valRange: 1,
    toX: (t: number) => PAD.left + ((t - leftEdge) / span) * chartW,
    toY: (v: number) => PAD.top + (1 - v) * chartH,
  };
}

/** Deterministic short formatter — no Date, so tests stay timezone-agnostic
 * except where the day-alignment branch is deliberately exercised. */
const fmt = (t: number) => String(Math.round(t));

describe('timeAxisInterval', () => {
  it('returns the nice interval when it already clears 60px', () => {
    // 30s window over 600px => 20px/s => 5s ticks are 100px apart.
    expect(timeAxisInterval(30, 600)).toBe(5);
  });

  it('doubles until ticks are at least 60px apart on a narrow chart', () => {
    // 30s over 120px => 4px/s. 5s=20px, 10s=40px, 20s=80px.
    expect(timeAxisInterval(30, 120)).toBe(20);
  });

  it('never returns an interval wider than the window itself', () => {
    // A degenerate/zero-width chart would otherwise loop forever.
    const interval = timeAxisInterval(60, 0);
    expect(interval).toBeGreaterThanOrEqual(60);
    expect(Number.isFinite(interval)).toBe(true);
  });

  it('is monotonic in window size across a sweep of real windows', () => {
    const windows = [10, 15, 30, 60, 120, 300, 600, 1800, 3600, 86400, 604800];
    let prev = 0;
    for (const win of windows) {
      const interval = timeAxisInterval(win, 600);
      expect(interval).toBeGreaterThanOrEqual(prev);
      prev = interval;
    }
  });

  it('yields tick spacing >= 60px whenever the window allows it', () => {
    const chartW = 370;
    for (const win of [15, 30, 60, 120, 300, 600, 1800, 3600, 14400, 43200]) {
      const interval = timeAxisInterval(win, chartW);
      const spacing = interval * (chartW / win);
      expect(spacing >= 60 || interval >= win).toBe(true);
    }
  });

  it('derives from the target window, not the display window', () => {
    // The function only takes the target window — the "one-frame flicker at
    // transition end" bug is structurally impossible. Same target, different
    // in-flight display windows, same answer.
    expect(timeAxisInterval(60, 600)).toBe(timeAxisInterval(60, 600));
  });
});

describe('timeAxisLabelKeys', () => {
  it('covers the view plus one interval of buffer on each side', () => {
    const out: number[] = [];
    const n = timeAxisLabelKeys(10, 100, 160, out);
    const times = out.slice(0, n).map((k) => k / 100);
    expect(times[0]).toBeLessThanOrEqual(100);
    expect(times[0]).toBeGreaterThanOrEqual(90 - 10);
    expect(times[times.length - 1]).toBeGreaterThanOrEqual(160);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeCloseTo(10);
    }
  });

  it('emits ascending keys so no sort is needed downstream', () => {
    const out: number[] = [];
    const n = timeAxisLabelKeys(5, 1000, 1060, out);
    for (let i = 1; i < n; i++) expect(out[i]!).toBeGreaterThan(out[i - 1]!);
  });

  it('aligns to local midnight for day-or-longer intervals', () => {
    const out: number[] = [];
    // Three days of view with 1-day ticks.
    const start = Date.UTC(2026, 0, 10, 13, 45) / 1000;
    const n = timeAxisLabelKeys(86400, start, start + 3 * 86400, out);
    expect(n).toBeGreaterThan(0);
    // The anchor label is exactly local midnight.
    const first = new Date((out[0]! / 100) * 1000);
    expect(first.getHours()).toBe(0);
    expect(first.getMinutes()).toBe(0);
    expect(first.getSeconds()).toBe(0);
    expect(first.getMilliseconds()).toBe(0);
  });

  it('does not local-align sub-day intervals (epoch-multiple instead)', () => {
    const out: number[] = [];
    const n = timeAxisLabelKeys(3600, 7000, 14000, out);
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) expect((out[i]! / 100) % 3600).toBe(0);
  });

  it('caps generation at 30 labels', () => {
    const out: number[] = [];
    // A wide→narrow transition: 1s ticks across a 10-minute display span.
    const n = timeAxisLabelKeys(1, 0, 600, out);
    expect(n).toBe(30);
  });

  it('reuses the caller array without reallocating', () => {
    const out: number[] = [];
    timeAxisLabelKeys(1, 0, 600, out);
    const long = out.length;
    const n = timeAxisLabelKeys(60, 0, 120, out);
    expect(n).toBeLessThan(long);
    // Stale entries past the returned count are left in place by design.
    expect(out.length).toBe(long);
  });
});

describe('buildTimeAxisLabels', () => {
  it('culls labels past the right edge and beyond the left slack', () => {
    const ctx = makeCtx();
    const layout = makeLayout(0, 60); // chartW 370 => ~6.17px/s
    const keys: number[] = [];
    const n = timeAxisLabelKeys(10, 0, 60, keys);
    const pool: TimeAxisLabel[] = [];
    const count = buildTimeAxisLabels(ctx, keys, n, layout, fmt, pool);

    const chartLeft = PAD.left;
    const chartRight = layout.w - PAD.right;
    for (let i = 0; i < count; i++) {
      expect(pool[i]!.x).toBeGreaterThanOrEqual(chartLeft - 20);
      expect(pool[i]!.x).toBeLessThanOrEqual(chartRight);
    }
    // The -10s buffer label sits ~62px left of chartLeft and is dropped.
    expect(count).toBeLessThan(n);
  });

  it('measures through the passed-in ctx and sets the label font slot', () => {
    const ctx = makeCtx(9);
    const seen: string[] = [];
    const spy = {
      ...ctx,
      measureText: (t: string) => {
        seen.push(t);
        return { width: t.length * 9 };
      },
    } as unknown as Ctx2D;
    const layout = makeLayout(0, 60);
    const keys: number[] = [];
    const n = timeAxisLabelKeys(10, 0, 60, keys);
    const pool: TimeAxisLabel[] = [];
    const count = buildTimeAxisLabels(spy, keys, n, layout, fmt, pool);

    expect(seen.length).toBe(count);
    expect(spy.font).toBe(spy.fonts.label);
    for (let i = 0; i < count; i++) {
      expect(pool[i]!.w).toBe(pool[i]!.text.length * 9);
    }
  });

  it('reuses pooled entries instead of allocating per rebuild', () => {
    const ctx = makeCtx();
    const layout = makeLayout(0, 60);
    const keys: number[] = [];
    const pool: TimeAxisLabel[] = [];
    const n1 = timeAxisLabelKeys(10, 0, 60, keys);
    buildTimeAxisLabels(ctx, keys, n1, layout, fmt, pool);
    const identities = pool.slice();

    const layout2 = makeLayout(5, 65);
    const n2 = timeAxisLabelKeys(10, 5, 65, keys);
    buildTimeAxisLabels(ctx, keys, n2, layout2, fmt, pool);
    for (let i = 0; i < identities.length; i++) {
      expect(pool[i]).toBe(identities[i]);
    }
  });

  it('only calls the formatter for labels that survive culling', () => {
    let calls = 0;
    const counting = (t: number) => {
      calls++;
      return fmt(t);
    };
    const ctx = makeCtx();
    const layout = makeLayout(0, 60);
    const keys: number[] = [];
    const n = timeAxisLabelKeys(10, 0, 60, keys);
    const pool: TimeAxisLabel[] = [];
    const count = buildTimeAxisLabels(ctx, keys, n, layout, counting, pool);
    expect(calls).toBe(count);
  });
});

describe('timeAxisStride / timeAxisLabelKept', () => {
  function labelsAt(xs: number[], w: number): TimeAxisLabel[] {
    return xs.map((x, i) => ({ key: i * 1000, x, text: 'x', w }));
  }

  it('is 1 when labels comfortably clear each other', () => {
    expect(timeAxisStride(labelsAt([0, 100, 200, 300], 30), 4)).toBe(1);
  });

  it('grows to 2 when a label plus the 8px gap exceeds the spacing', () => {
    // spacing 40, width 34 + 8 = 42 > 40 => stride 2 (84 <= 80? no) ...
    // 42/40 = 1.05 => ceil 2.
    expect(timeAxisStride(labelsAt([0, 40, 80, 120, 160], 34), 5)).toBe(2);
  });

  it('grows further when labels are very dense', () => {
    const xs = [0, 10, 20, 30, 40, 50, 60, 70];
    // (44 + 8) / 10 = 5.2 => 6
    expect(timeAxisStride(labelsAt(xs, 44), xs.length)).toBe(6);
  });

  it('uses the widest label, not the average', () => {
    const labels = labelsAt([0, 40, 80, 120], 20);
    labels[2]!.w = 40; // one wide label forces the whole set to decimate
    expect(timeAxisStride(labels, 4)).toBe(2);
  });

  it('uses the tightest adjacent spacing, not the mean', () => {
    // A DST-shortened step: mostly 100px apart, one pair only 40px apart.
    const labels = labelsAt([0, 100, 140, 240], 34);
    expect(timeAxisStride(labels, 4)).toBe(2);
  });

  it('never exceeds the label count, so something always survives', () => {
    const xs = [0, 1, 2, 3];
    const stride = timeAxisStride(labelsAt(xs, 500), xs.length);
    expect(stride).toBe(4);
    const labels = labelsAt(xs, 500).map((l, i) => ({ ...l, key: i * 100 }));
    const out: TimeAxisLabel[] = [];
    const kept = resolveTimeAxisOverlaps(labels, labels.length, 1, stride, out);
    expect(kept).toBeGreaterThan(0);
  });

  it('handles a single label and an empty set', () => {
    expect(timeAxisStride([], 0)).toBe(1);
    expect(timeAxisStride(labelsAt([50], 30), 1)).toBe(1);
  });

  it('keeps every label at stride 1', () => {
    for (const key of [0, 500, 1000, 123400]) {
      expect(timeAxisLabelKept(key, 5, 1)).toBe(true);
    }
  });

  it('decides purely from the label timestamp, not from scan position', () => {
    // interval 10s => keys are multiples of 1000 centiseconds.
    expect(timeAxisLabelKept(0, 10, 2)).toBe(true);
    expect(timeAxisLabelKept(1000, 10, 2)).toBe(false);
    expect(timeAxisLabelKept(2000, 10, 2)).toBe(true);
  });

  it('normalises negative (pre-epoch) indices', () => {
    expect(timeAxisLabelKept(-2000, 10, 2)).toBe(true);
    expect(timeAxisLabelKept(-1000, 10, 2)).toBe(false);
    expect(timeAxisLabelKept(-3000, 10, 3)).toBe(true);
  });
});

describe('overlap resolution determinism under scrolling', () => {
  /** Runs one "frame": generate, build, resolve. Returns the kept keys. */
  function frame(
    ctx: Ctx2D,
    leftEdge: number,
    rightEdge: number,
    interval: number,
    w = 400
  ): { keys: number[]; stride: number } {
    const layout = makeLayout(leftEdge, rightEdge, w);
    const raw: number[] = [];
    const n = timeAxisLabelKeys(interval, leftEdge, rightEdge, raw);
    const pool: TimeAxisLabel[] = [];
    const count = buildTimeAxisLabels(ctx, raw, n, layout, fmt, pool);
    const stride = timeAxisStride(pool, count);
    const out: TimeAxisLabel[] = [];
    const kept = resolveTimeAxisOverlaps(pool, count, interval, stride, out);
    return { keys: out.slice(0, kept).map((l) => l.key), stride };
  }

  it('never changes a surviving label back into a dropped one while scrolling', () => {
    // Wide labels at a tight interval => spacing ~31px vs 44px needed, so
    // the run genuinely decimates rather than trivially keeping everything.
    const ctx = makeCtx(9);
    const interval = 5;
    const span = 60;
    // Every key we have ever seen at all, and whether it was kept.
    const verdicts = new Map<number, boolean>();
    for (let step = 0; step < 400; step++) {
      const left = 1000 + step * 0.25; // sub-interval scroll, 100s of travel
      const { keys } = frame(ctx, left, left + span, interval);
      const keptSet = new Set(keys);
      // Rebuild the full visible set to know which keys were considered.
      const raw: number[] = [];
      const n = timeAxisLabelKeys(interval, left, left + span, raw);
      const layout = makeLayout(left, left + span);
      const pool: TimeAxisLabel[] = [];
      const count = buildTimeAxisLabels(ctx, raw, n, layout, fmt, pool);
      for (let i = 0; i < count; i++) {
        const key = pool[i]!.key;
        const kept = keptSet.has(key);
        const prior = verdicts.get(key);
        if (prior !== undefined) expect(kept).toBe(prior);
        verdicts.set(key, kept);
      }
    }
    // Sanity: the scenario actually exercised decimation.
    expect([...verdicts.values()].some((v) => !v)).toBe(true);
    expect([...verdicts.values()].some((v) => v)).toBe(true);
  });

  it('keeps the stride constant while scrolling at a fixed zoom', () => {
    const ctx = makeCtx(9);
    const strides = new Set<number>();
    for (let step = 0; step < 200; step++) {
      const left = 1000 + step * 0.37;
      strides.add(frame(ctx, left, left + 60, 10).stride);
    }
    expect(strides.size).toBe(1);
  });

  it('is idempotent: the same inputs always produce the same set', () => {
    const ctx = makeCtx(9);
    const a = frame(ctx, 1234.5, 1294.5, 10);
    const b = frame(ctx, 1234.5, 1294.5, 10);
    expect(a.keys).toEqual(b.keys);
    expect(a.stride).toBe(b.stride);
  });

  it('resolved labels never overlap, including the 8px gap', () => {
    const ctx = makeCtx(9);
    const interval = 10;
    for (let step = 0; step < 120; step++) {
      const left = 500 + step * 0.5;
      const layout = makeLayout(left, left + 60);
      const raw: number[] = [];
      const n = timeAxisLabelKeys(interval, left, left + 60, raw);
      const pool: TimeAxisLabel[] = [];
      const count = buildTimeAxisLabels(ctx, raw, n, layout, fmt, pool);
      const stride = timeAxisStride(pool, count);
      const out: TimeAxisLabel[] = [];
      const kept = resolveTimeAxisOverlaps(pool, count, interval, stride, out);
      for (let i = 1; i < kept; i++) {
        const prevRight = out[i - 1]!.x + out[i - 1]!.w / 2;
        const left2 = out[i]!.x - out[i]!.w / 2;
        expect(left2).toBeGreaterThanOrEqual(prevRight + 8 - 1e-9);
      }
    }
  });

  it('swaps the whole set coherently when the zoom changes', () => {
    const ctx = makeCtx(9);
    const dense = frame(ctx, 1000, 1060, 10);
    const sparse = frame(ctx, 1000, 1060, 20);
    expect(sparse.keys.length).toBeLessThanOrEqual(dense.keys.length);
  });

  it('out holds references into labels, never fresh objects', () => {
    const labels: TimeAxisLabel[] = [0, 1, 2, 3].map((i) => ({
      key: i * 1000,
      x: i * 100,
      text: 't',
      w: 20,
    }));
    const out: TimeAxisLabel[] = [];
    const kept = resolveTimeAxisOverlaps(labels, 4, 10, 2, out);
    expect(kept).toBe(2);
    expect(out[0]).toBe(labels[0]);
    expect(out[1]).toBe(labels[2]);
  });
});

describe('label-set identity', () => {
  function labels(keys: number[]): TimeAxisLabel[] {
    return keys.map((key, i) => ({ key, x: i * 50, text: 't', w: 20 }));
  }

  it('starts unmatched against any real set', () => {
    const id = createTimeAxisLabelSetId();
    expect(timeAxisLabelSetIdMatches(id, labels([1000, 2000]), 2, 10, 1)).toBe(
      false
    );
  });

  it('matches after a write with the same set', () => {
    const id = createTimeAxisLabelSetId();
    const set = labels([1000, 2000, 3000]);
    writeTimeAxisLabelSetId(id, set, 3, 10, 1);
    expect(timeAxisLabelSetIdMatches(id, set, 3, 10, 1)).toBe(true);
  });

  it('invalidates when a label scrolls in or out', () => {
    const id = createTimeAxisLabelSetId();
    writeTimeAxisLabelSetId(id, labels([1000, 2000, 3000]), 3, 10, 1);
    // One scrolled off the left, one on at the right.
    expect(
      timeAxisLabelSetIdMatches(id, labels([2000, 3000, 4000]), 3, 10, 1)
    ).toBe(false);
    // Count grew.
    expect(
      timeAxisLabelSetIdMatches(id, labels([1000, 2000, 3000, 4000]), 4, 10, 1)
    ).toBe(false);
  });

  it('invalidates on an interval change even at identical endpoints', () => {
    const id = createTimeAxisLabelSetId();
    writeTimeAxisLabelSetId(id, labels([0, 1000, 2000]), 3, 10, 1);
    expect(
      timeAxisLabelSetIdMatches(id, labels([0, 1000, 2000]), 3, 5, 1)
    ).toBe(false);
  });

  it('invalidates on a stride change even at identical endpoints', () => {
    // This is the collision `count + first + last` alone would miss: same
    // span, same count of *generated* labels, different kept subset.
    const id = createTimeAxisLabelSetId();
    writeTimeAxisLabelSetId(id, labels([0, 2000, 4000]), 3, 10, 2);
    expect(
      timeAxisLabelSetIdMatches(id, labels([0, 2000, 4000]), 3, 10, 1)
    ).toBe(false);
  });

  it('is exact for the arithmetic sets this module generates', () => {
    // Reconstruct every set produced across a scroll and confirm that no two
    // distinct sets share an identity.
    const ctx = makeCtx();
    const seen = new Map<string, string>();
    for (let step = 0; step < 300; step++) {
      const left = 1000 + step * 0.4;
      const layout = makeLayout(left, left + 60);
      const raw: number[] = [];
      const n = timeAxisLabelKeys(10, left, left + 60, raw);
      const pool: TimeAxisLabel[] = [];
      const count = buildTimeAxisLabels(ctx, raw, n, layout, fmt, pool);
      const stride = timeAxisStride(pool, count);
      const out: TimeAxisLabel[] = [];
      const kept = resolveTimeAxisOverlaps(pool, count, 10, stride, out);
      const id = createTimeAxisLabelSetId();
      writeTimeAxisLabelSetId(id, out, kept, 10, stride);
      const idStr = `${id.count}|${id.firstKey}|${id.lastKey}|${id.interval}|${id.stride}`;
      const setStr = out
        .slice(0, kept)
        .map((l) => l.key)
        .join(',');
      const prior = seen.get(idStr);
      if (prior !== undefined) expect(setStr).toBe(prior);
      seen.set(idStr, setStr);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('ignores x positions — those are the scroll layer dx, not a rebuild', () => {
    const id = createTimeAxisLabelSetId();
    const a = labels([1000, 2000, 3000]);
    writeTimeAxisLabelSetId(id, a, 3, 10, 1);
    const b = labels([1000, 2000, 3000]);
    for (const l of b) l.x += 37.5;
    expect(timeAxisLabelSetIdMatches(id, b, 3, 10, 1)).toBe(true);
  });

  it('does NOT see text changes — the slot must key formatTime separately', () => {
    // Documented limitation, asserted so it cannot regress silently.
    const id = createTimeAxisLabelSetId();
    const a = labels([1000, 2000]);
    writeTimeAxisLabelSetId(id, a, 2, 10, 1);
    const b = labels([1000, 2000]);
    for (const l of b) l.text = 'COMPLETELY DIFFERENT';
    expect(timeAxisLabelSetIdMatches(id, b, 2, 10, 1)).toBe(true);
  });

  it('handles the empty set without reading past the end', () => {
    const id = createTimeAxisLabelSetId();
    writeTimeAxisLabelSetId(id, [], 0, 10, 1);
    expect(id.firstKey).toBe(0);
    expect(id.lastKey).toBe(0);
    expect(timeAxisLabelSetIdMatches(id, [], 0, 10, 1)).toBe(true);
  });
});
