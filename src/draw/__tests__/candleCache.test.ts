import {
  createCandleCacheSlot,
  updateCandleCache,
  MIN_CACHE_CANDLES,
  type CachePath,
} from '../candleCache';
import type { ChartLayout, CandlePoint, Padding } from '../../types';

// ── Fakes ──────────────────────────────────────────────────────────────────
// Mirrors lineCache.test.ts's FakePath — a structural CachePath recorder,
// no real Skia needed.

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
      if (v.op === 'A') {
        // arcToTangent's c is [x1,y1,x2,y2,r] — 5 elements, the odd one out
        // (r is not a coordinate and must not be shifted).
        v.c[0]! += dx;
        v.c[1]! += dy;
        v.c[2]! += dx;
        v.c[3]! += dy;
      } else {
        for (let i = 0; i < v.c.length; i += 2) {
          v.c[i]! += dx;
          v.c[i + 1]! += dy;
        }
      }
    }
  }
  clone(): FakePath {
    const p = new FakePath();
    p.verbs = this.verbs.map((v) => ({ op: v.op, c: v.c.slice() }));
    return p;
  }
}

const PAD: Required<Padding> = { top: 10, right: 10, bottom: 10, left: 10 };

/** Layout matching engineStep's construction (candle-mode branch), scoped so
 * `rightEdge` (the scroll position) and the Y-range/canvas size can vary
 * independently per test. */
function makeLayout(
  rightEdge: number,
  minVal: number,
  maxVal: number,
  windowSecs = 100,
  w = 500,
  h = 200
): ChartLayout {
  const chartW = w - PAD.left - PAD.right;
  const chartH = h - PAD.top - PAD.bottom;
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

/** Same formula as candlestick.ts's candleDims (duplicated intentionally,
 * the way lineCache.test.ts duplicates drawLine's point-building rather than
 * importing the Skia-adjacent module under test's sibling). */
function candleDims(
  layout: ChartLayout,
  candleWidthSecs: number
): { bodyW: number; radius: number } {
  const pxPerSec = layout.chartW / (layout.rightEdge - layout.leftEdge);
  const candlePxW = candleWidthSecs * pxPerSec;
  const bodyW = Math.max(1, candlePxW * 0.7);
  const radius = bodyW > 6 ? 1.5 : 0;
  return { bodyW, radius };
}

/** Candle every 5s from t0, alternating bull/bear (even index = bull), with
 * OHLC margins comfortably clearing the 0.5px wick-render threshold at any
 * reasonable layout scale used below. */
function makeCandles(count: number, t0 = 10): CandlePoint[] {
  const out: CandlePoint[] = [];
  for (let i = 0; i < count; i++) {
    const bull = i % 2 === 0;
    out.push({
      time: t0 + i * 5,
      open: 50,
      close: bull ? 55 : 45,
      high: bull ? 58 : 52,
      low: bull ? 48 : 42,
    });
  }
  return out;
}

interface Harness {
  slot: ReturnType<typeof createCandleCacheSlot>;
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
  return { slot: createCandleCacheSlot(), made, makePath };
}

function update(
  hz: Harness,
  layout: ChartLayout,
  candles: CandlePoint[],
  candleWidthSecs: number,
  liveTime: number,
  dataSource = 0,
  candlesRev = 0
): boolean {
  const { bodyW, radius } = candleDims(layout, candleWidthSecs);
  return updateCandleCache(
    { slot: hz.slot, dataSource, candlesRev },
    hz.makePath,
    layout,
    candles,
    candleWidthSecs,
    liveTime,
    bodyW,
    radius
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('updateCandleCache', () => {
  const NOW = 1000;

  it('returns false below MIN_CACHE_CANDLES', () => {
    const hz = makeHarness();
    const candles = makeCandles(MIN_CACHE_CANDLES - 1);
    const layout = makeLayout(NOW, 0, 100);
    expect(update(hz, layout, candles, 4, -1)).toBe(false);
    expect(hz.made.length).toBe(0);
  });

  it('builds combined bull/bear body+wick paths, excluding the live candle', () => {
    const hz = makeHarness();
    // 9 candles, i=0..8, even=bull (5 bulls: 0,2,4,6,8), odd=bear (4 bears).
    const candles = makeCandles(9, NOW - 60);
    const liveTime = candles[8]!.time; // bull, excluded from the cache
    const layout = makeLayout(NOW, 0, 100);

    expect(update(hz, layout, candles, 4, liveTime)).toBe(true);
    // 4 paths allocated: bullBodies, bullWicks, bearBodies, bearWicks.
    expect(hz.made.length).toBe(4);

    const { radius } = candleDims(layout, 4);
    expect(radius).toBeGreaterThan(0); // wide candles here → rounded bodies

    const bullBodies = hz.slot.bullBodies as FakePath;
    const bearBodies = hz.slot.bearBodies as FakePath;
    const bullWicks = hz.slot.bullWicks as FakePath;
    const bearWicks = hz.slot.bearWicks as FakePath;

    // Closed bulls: i=0,2,4,6 (i=8 is live) → 4. Closed bears: i=1,3,5,7 → 4.
    const vertsPerRoundedBody = 10; // M + (L,A)*4 + Z
    expect(bullBodies.verbs.length).toBe(4 * vertsPerRoundedBody);
    expect(bearBodies.verbs.length).toBe(4 * vertsPerRoundedBody);

    // Every candle in makeCandles clears the 0.5px wick threshold on both
    // sides at this layout scale → 2 (moveTo,lineTo) pairs = 4 verbs each.
    expect(bullWicks.verbs.length).toBe(4 * 4);
    expect(bearWicks.verbs.length).toBe(4 * 4);

    expect(hz.slot.hasBullBodies).toBe(true);
    expect(hz.slot.hasBearBodies).toBe(true);
    expect(hz.slot.hasBullWicks).toBe(true);
    expect(hz.slot.hasBearWicks).toBe(true);

    // The live candle's time must not appear as a body/wick moveTo x.
    const liveX = layout.toX(liveTime + 4 / 2);
    for (const v of [...bullBodies.verbs, ...bullWicks.verbs]) {
      if (v.op === 'M') expect(v.c[0]).not.toBeCloseTo(liveX, 6);
    }
  });

  it('flags an absent color group as empty without allocating extra content', () => {
    const hz = makeHarness();
    // All-bull set (every other index would normally be bear, so force it).
    const candles: CandlePoint[] = [];
    for (let i = 0; i < 8; i++) {
      candles.push({
        time: NOW - 60 + i * 5,
        open: 50,
        close: 55,
        high: 58,
        low: 48,
      });
    }
    const layout = makeLayout(NOW, 0, 100);
    expect(update(hz, layout, candles, 4, -1)).toBe(true);

    expect(hz.slot.hasBullBodies).toBe(true);
    expect(hz.slot.hasBearBodies).toBe(false);
    expect(hz.slot.hasBearWicks).toBe(false);
    expect((hz.slot.bearBodies as FakePath).verbs.length).toBe(0);
    expect((hz.slot.bearWicks as FakePath).verbs.length).toBe(0);
  });

  it('is translation-invariant: a hit at a later scroll position matches a fresh build there', () => {
    const candles = makeCandles(10, NOW - 60);
    const liveTime = -1; // no live candle in this set
    const layout1 = makeLayout(NOW, 0, 100);

    const hz = makeHarness();
    expect(update(hz, layout1, candles, 4, liveTime)).toBe(true);
    const madeAfterBuild = hz.made.length;
    const bullBodiesAfterBuild = (hz.slot.bullBodies as FakePath).rewinds;

    const later = NOW + 12.5; // pure scroll — same candle set, later window
    const layout2 = makeLayout(later, 0, 100);
    expect(update(hz, layout2, candles, 4, liveTime)).toBe(true);

    // Hit: no new paths, no re-record.
    expect(hz.made.length).toBe(madeAfterBuild);
    expect((hz.slot.bullBodies as FakePath).rewinds).toBe(bullBodiesAfterBuild);

    const dx = layout2.toX(hz.slot.tRef) - hz.slot.xRefAtBuild;
    const translated = (hz.slot.bullBodies as FakePath).clone();
    translated.offset(dx, 0);

    const fresh = makeHarness();
    expect(update(fresh, layout2, candles, 4, liveTime)).toBe(true);
    const rebuilt = fresh.slot.bullBodies as FakePath;

    expect(translated.verbs.length).toBe(rebuilt.verbs.length);
    for (let i = 0; i < translated.verbs.length; i++) {
      expect(translated.verbs[i]!.op).toBe(rebuilt.verbs[i]!.op);
      for (let k = 0; k < translated.verbs[i]!.c.length; k++) {
        expect(translated.verbs[i]!.c[k]!).toBeCloseTo(
          rebuilt.verbs[i]!.c[k]!,
          6
        );
      }
    }
  });

  it('rebuilds when any key input changes', () => {
    const candles = makeCandles(10, NOW - 60);
    const liveTime = candles[9]!.time;
    const base = () => makeLayout(NOW, 0, 100);

    const cases: { name: string; run: (hz: Harness) => boolean }[] = [
      {
        name: 'candle width',
        run: (hz) => update(hz, base(), candles, 5, liveTime),
      },
      {
        name: 'dataSource',
        run: (hz) => update(hz, base(), candles, 4, liveTime, 1),
      },
      {
        // Catches a consumer revising an already-closed candle in place
        // (e.g. a late trade correcting the previous bar's close): none of
        // the other key fields (count/first/last time/min/max) necessarily
        // move when that happens, so candlesRev is the only thing that
        // reliably invalidates the cache in that case.
        name: 'candlesRev',
        run: (hz) => update(hz, base(), candles, 4, liveTime, 0, 1),
      },
      {
        name: 'range min',
        run: (hz) =>
          update(hz, makeLayout(NOW, -10, 100), candles, 4, liveTime),
      },
      {
        name: 'range max',
        run: (hz) => update(hz, makeLayout(NOW, 0, 110), candles, 4, liveTime),
      },
      {
        name: 'window size',
        run: (hz) =>
          update(hz, makeLayout(NOW, 0, 100, 150), candles, 4, liveTime),
      },
      {
        name: 'canvas width',
        run: (hz) =>
          update(hz, makeLayout(NOW, 0, 100, 100, 600), candles, 4, liveTime),
      },
      {
        name: 'canvas height',
        run: (hz) =>
          update(
            hz,
            makeLayout(NOW, 0, 100, 100, 500, 240),
            candles,
            4,
            liveTime
          ),
      },
      {
        name: 'a new candle closes (set grows, last-closed time changes)',
        run: (hz) => {
          const grown = candles.concat([
            { time: liveTime + 5, open: 45, close: 50, high: 53, low: 43 },
          ]);
          return update(hz, base(), grown, 4, liveTime + 5);
        },
      },
      {
        name: 'oldest candle scrolls out (set shrinks, first-closed time changes)',
        run: (hz) => update(hz, base(), candles.slice(1), 4, liveTime),
      },
    ];

    for (const c of cases) {
      const hz = makeHarness();
      update(hz, base(), candles, 4, liveTime);
      const before = (hz.slot.bullBodies as FakePath).rewinds;
      expect(before).toBe(1);
      expect(c.run(hz)).toBe(true);
      expect((hz.slot.bullBodies as FakePath).rewinds).toBe(before + 1);
    }
  });

  it('rebuilds when radius changes independent of candle width (defensive key)', () => {
    const candles = makeCandles(10, NOW - 60);
    const liveTime = candles[9]!.time;
    const layout = makeLayout(NOW, 0, 100);
    const { bodyW } = candleDims(layout, 4);

    const hz = makeHarness();
    expect(
      updateCandleCache(
        { slot: hz.slot, dataSource: 0, candlesRev: 0 },
        hz.makePath,
        layout,
        candles,
        4,
        liveTime,
        bodyW,
        1.5
      )
    ).toBe(true);
    expect((hz.slot.bullBodies as FakePath).rewinds).toBe(1);

    expect(
      updateCandleCache(
        { slot: hz.slot, dataSource: 0, candlesRev: 0 },
        hz.makePath,
        layout,
        candles,
        4,
        liveTime,
        bodyW,
        0
      )
    ).toBe(true);
    expect((hz.slot.bullBodies as FakePath).rewinds).toBe(2);
  });

  it('does not rebuild for pure scroll across many frames', () => {
    const candles = makeCandles(10, NOW - 60);
    const liveTime = -1;
    const hz = makeHarness();
    update(hz, makeLayout(NOW, 0, 100), candles, 4, liveTime);

    for (let i = 1; i <= 5; i++) {
      update(hz, makeLayout(NOW + i * 0.7, 0, 100), candles, 4, liveTime);
    }
    expect((hz.slot.bullBodies as FakePath).rewinds).toBe(1);
  });
});
