import {
  computeCandleRange,
  candleAtX,
  updateCandleRange,
  updateCandleWindowTransition,
} from '../candleHelpers';
import {
  RANGE_LERP_SPEED,
  RANGE_ADAPTIVE_BOOST,
  WINDOW_TRANSITION_MS,
} from '../constants';
import type { CandlePoint, ChartLayout, Padding } from '../../types';

// ── Fixtures ───────────────────────────────────────────────────────────────

const PAD: Required<Padding> = { top: 0, right: 0, bottom: 0, left: 0 };

const candle = (
  time: number,
  low: number,
  high: number,
  open = low,
  close = high
): CandlePoint => ({ time, open, high, low, close });

type CandleWt = {
  from: number;
  to: number;
  startMs: number;
  rangeFromMin: number;
  rangeFromMax: number;
  rangeToMin: number;
  rangeToMax: number;
};

const wtState = (over: Partial<CandleWt> = {}): CandleWt => ({
  from: 0,
  to: 60,
  startMs: 0,
  rangeFromMin: 0,
  rangeFromMax: 0,
  rangeToMin: 0,
  rangeToMax: 0,
  ...over,
});

/** Linear time↔pixel mapping: x = time / 60 over [0, 60000] → [0, 1000]. */
function makeLayout(
  leftEdge: number,
  rightEdge: number,
  chartW: number
): ChartLayout {
  return {
    w: chartW,
    h: 200,
    pad: PAD,
    chartW,
    chartH: 200,
    leftEdge,
    rightEdge,
    minVal: 0,
    maxVal: 100,
    valRange: 100,
    toX: (t: number) => ((t - leftEdge) / (rightEdge - leftEdge)) * chartW,
    toY: (v: number) => 200 - v,
  };
}

function naiveLerp(current: number, target: number, speed: number): number {
  return current + (target - current) * speed;
}

// ── computeCandleRange ─────────────────────────────────────────────────────

describe('computeCandleRange', () => {
  it('returns the fixed placeholder range for an empty series', () => {
    // Infinity would propagate into valRange and NaN out every toY.
    expect(computeCandleRange([])).toEqual({ min: 99, max: 101 });
  });

  it('scans lows and highs, not opens and closes', () => {
    // The wick at 200 and the wick at 10 must both be inside the range even
    // though no body reaches them.
    const r = computeCandleRange([candle(0, 10, 200, 100, 110)]);
    expect(r.min).toBeLessThan(10);
    expect(r.max).toBeGreaterThan(200);
  });

  it('applies a 12% margin on both sides', () => {
    const r = computeCandleRange([candle(0, 100, 200), candle(60, 120, 180)]);
    // range 100 → margin 12
    expect(r.min).toBeCloseTo(88, 10);
    expect(r.max).toBeCloseTo(212, 10);
  });

  it('never returns an inverted or empty range for real data', () => {
    const r = computeCandleRange([candle(0, 100, 200)]);
    expect(r.max).toBeGreaterThan(r.min);
  });

  it('widens a perfectly flat series to the 0.4 absolute floor, centred on the price', () => {
    // range 0 → minRange falls back to 0.4 → price ± 0.2.
    const r = computeCandleRange([candle(0, 100, 100), candle(60, 100, 100)]);
    expect(r.min).toBe(99.8);
    expect(r.max).toBe(100.2);
  });

  it('does NOT apply the 0.4 floor to a tiny-but-nonzero range', () => {
    // minRange is relative (range * 0.1), so it can never exceed a nonzero
    // range — a hardcoded absolute floor here would visibly flatten a
    // low-volatility chart.
    const r = computeCandleRange([candle(0, 100, 100.001)]);
    expect(r.max - r.min).toBeLessThan(0.4);
    expect(r.min).toBeCloseTo(100 - 0.001 * 0.12, 12);
  });

  it('ignores candle ordering', () => {
    const a = computeCandleRange([candle(0, 10, 20), candle(60, 5, 30)]);
    const b = computeCandleRange([candle(60, 5, 30), candle(0, 10, 20)]);
    expect(a).toEqual(b);
  });
});

// ── candleAtX ──────────────────────────────────────────────────────────────

describe('candleAtX', () => {
  const WIDTH = 60;
  const layout = makeLayout(0, 60_000, 1000);
  // Contiguous candles at t = 0, 60, 120, ... ; x = t / 60, so candle i owns
  // pixels [i, i + 1).
  const candles: CandlePoint[] = Array.from({ length: 1000 }, (_, i) =>
    candle(i * WIDTH, i, i + 1)
  );

  it('finds the right candle for every bucket centre across a 1000-candle series', () => {
    // An off-by-one in the binary search survives a handful of spot checks
    // but not an exhaustive sweep.
    for (let i = 0; i < candles.length; i++) {
      expect(candleAtX(candles, i + 0.5, WIDTH, layout)).toBe(candles[i]);
    }
  });

  it('treats a bucket as [start, start + width): start inclusive, end exclusive', () => {
    // `time >= c.time + candleWidth` vs `>` decides which candle owns the
    // shared boundary; getting it wrong makes the crosshair jump a slot.
    expect(candleAtX(candles, 5, WIDTH, layout)).toBe(candles[5]);
    expect(candleAtX(candles, 6, WIDTH, layout)).toBe(candles[6]);
  });

  it('returns null before the first candle', () => {
    expect(candleAtX(candles, -0.5, WIDTH, layout)).toBeNull();
  });

  it('returns null past the end of the last candle', () => {
    expect(candleAtX(candles, 1000.5, WIDTH, layout)).toBeNull();
  });

  it('returns null inside a gap in the series rather than the nearest neighbour', () => {
    const gapped = [candle(0, 1, 2), candle(600, 3, 4)];
    // t = 300 sits in the hole between the two candles.
    expect(candleAtX(gapped, 5, WIDTH, makeLayout(0, 60_000, 1000))).toBeNull();
    expect(candleAtX(gapped, 0.5, WIDTH, makeLayout(0, 60_000, 1000))).toBe(
      gapped[0]
    );
  });

  it('returns null for an empty series', () => {
    expect(candleAtX([], 5, WIDTH, layout)).toBeNull();
  });

  it('honours left padding when converting pixels to time', () => {
    const padded: ChartLayout = {
      ...makeLayout(0, 60_000, 1000),
      pad: { ...PAD, left: 100 },
    };
    // x = 100 must map to leftEdge (t = 0), i.e. the first candle.
    expect(candleAtX(candles, 100, WIDTH, padded)).toBe(candles[0]);
    expect(candleAtX(candles, 99, WIDTH, padded)).toBeNull();
  });
});

// ── updateCandleRange ──────────────────────────────────────────────────────

describe('updateCandleRange — first frame', () => {
  it('adopts the computed range verbatim', () => {
    expect(
      updateCandleRange(
        { min: 3, max: 7 },
        false,
        -1,
        -1,
        false,
        0,
        wtState(),
        300,
        16.67
      )
    ).toEqual({
      minVal: 3,
      maxVal: 7,
      valRange: 4,
      displayMin: 3,
      displayMax: 7,
      rangeInited: true,
    });
  });

  it('never reports a zero valRange', () => {
    const r = updateCandleRange(
      { min: 5, max: 5 },
      false,
      0,
      0,
      false,
      0,
      wtState(),
      300,
      16.67
    );
    expect(r.valRange).toBe(0.001);
  });
});

describe('updateCandleRange — during a window transition', () => {
  const wt = wtState({
    rangeFromMin: 0,
    rangeFromMax: 100,
    rangeToMin: 50,
    rangeToMax: 150,
  });

  it('blends the captured ranges by progress and ignores the incoming display values', () => {
    const r = updateCandleRange(
      { min: 999, max: 999 },
      true,
      1234,
      5678,
      true,
      0.25,
      wt,
      300,
      16.67
    );
    expect(r.displayMin).toBe(12.5);
    expect(r.displayMax).toBe(112.5);
  });

  it('lands exactly on the captured target range at full progress', () => {
    const r = updateCandleRange(
      { min: 0, max: 0 },
      true,
      0,
      0,
      true,
      1,
      wt,
      300,
      16.67
    );
    expect(r.displayMin).toBe(50);
    expect(r.displayMax).toBe(150);
  });
});

describe('updateCandleRange — steady-state lerp', () => {
  function run(frames: number, dt: number, chartH: number) {
    let displayMin = 0;
    let displayMax = 100;
    for (let i = 0; i < frames; i++) {
      const r = updateCandleRange(
        { min: 40, max: 160 },
        true,
        displayMin,
        displayMax,
        false,
        0,
        wtState(),
        chartH,
        dt
      );
      displayMin = r.displayMin;
      displayMax = r.displayMax;
    }
    return { displayMin, displayMax };
  }

  it('tracks the same trajectory at 60Hz and 120Hz over the same wall-clock time', () => {
    // Mid-flight on purpose — after a full second both rates have converged
    // and the comparison would prove nothing.
    //
    // Note this is a *bounded-drift* assertion, not an exact one, and that is
    // the real behaviour: the underlying lerp is dt-corrected, but the
    // adaptive `speed` is recomputed from the current gap on every frame, so
    // the 120Hz run re-evaluates the schedule twice as often and ends a hair
    // ahead. The residual is well under 1% of the 120-unit range travelled.
    // The line pipeline (engine/helpers.ts `updateRange`) does not have this
    // wrinkle because its adaptive speed is computed once and passed in.
    const at60 = run(6, 1000 / 60, 1e9);
    const at120 = run(12, 1000 / 120, 1e9);
    expect(at60.displayMin).toBeGreaterThan(5);
    expect(at60.displayMin).toBeLessThan(38);
    expect(Math.abs(at120.displayMin - at60.displayMin)).toBeLessThan(1);
    expect(Math.abs(at120.displayMax - at60.displayMax)).toBeLessThan(1);
  });

  it('a lerp with no dt correction WOULD blow that bound by an order of magnitude', () => {
    // Dropping the dt term from math/lerp keeps the same adaptive schedule but
    // makes 120Hz arrive roughly twice as fast — ~9 units apart, vs the <1
    // asserted above.
    const naive = (frames: number) => {
      let v = 0;
      for (let i = 0; i < frames; i++) v = naiveLerp(v, 40, RANGE_LERP_SPEED);
      return v;
    };
    expect(Math.abs(naive(12) - naive(6))).toBeGreaterThan(5);
  });

  it('snaps to a BIT-EXACT target once inside the sub-pixel threshold', () => {
    // Exactness is load-bearing: draw/candleCache keys its cached geometry on
    // displayMin/displayMax, so residual drift means a full rebuild every
    // frame — the documented main limiter on that cache's hit rate.
    const { displayMin, displayMax } = run(300, 1000 / 60, 300);
    expect(displayMin).toBe(40);
    expect(displayMax).toBe(160);
  });

  it('accelerates as the gap closes (adaptive speed), so the first frame is the slowest', () => {
    // gapMin + gapMax spans the whole range on the first frame → gapRatio
    // clamps to 1 → base speed only. Dropping the adaptive term would make
    // every frame move by the same fraction.
    const first = updateCandleRange(
      { min: 40, max: 160 },
      true,
      0,
      100,
      false,
      0,
      wtState(),
      1e9,
      16.67
    );
    expect(first.displayMin).toBeCloseTo(40 * RANGE_LERP_SPEED, 6);

    // A tiny gap → gapRatio ≈ 0 → base + full boost.
    const near = updateCandleRange(
      { min: 40.0001, max: 160 },
      true,
      40,
      160,
      false,
      0,
      wtState(),
      1e9,
      16.67
    );
    const movedFraction = (near.displayMin - 40) / 0.0001;
    expect(movedFraction).toBeCloseTo(
      RANGE_LERP_SPEED + RANGE_ADAPTIVE_BOOST,
      4
    );
  });

  it('guards the degenerate zero-range divisor', () => {
    // curRange `|| 1`: without it gapRatio is NaN and the whole range poisons.
    const r = updateCandleRange(
      { min: 4, max: 6 },
      true,
      5,
      5,
      false,
      0,
      wtState(),
      300,
      16.67
    );
    expect(Number.isNaN(r.displayMin)).toBe(false);
    expect(Number.isNaN(r.displayMax)).toBe(false);
    expect(r.displayMin).toBeLessThan(5);
    expect(r.displayMax).toBeGreaterThan(5);
  });
});

// ── updateCandleWindowTransition ───────────────────────────────────────────

describe('updateCandleWindowTransition — retargeting', () => {
  const NOW = 1000;
  const NOW_MS = 50_000;
  const BUFFER = 0.05;
  const WIDTH = 60;

  it('captures the from-window, from-range and start time on a window change', () => {
    const wt = wtState({ to: 20 });
    updateCandleWindowTransition(
      100,
      wt,
      /* displayWindow */ 20,
      /* displayMin */ 90,
      /* displayMax */ 110,
      NOW_MS,
      NOW,
      [candle(940, 100, 110)],
      undefined,
      WIDTH,
      BUFFER
    );
    expect(wt.from).toBe(20);
    expect(wt.to).toBe(100);
    expect(wt.startMs).toBe(NOW_MS);
    expect(wt.rangeFromMin).toBe(90);
    expect(wt.rangeFromMax).toBe(110);
  });

  it('includes a candle that STARTS before the target left edge but extends past it', () => {
    // Target window is [905, 1005]. A candle at t=880 with width 60 ends at
    // 940, so it is partly on screen — candle visibility is width-adjusted,
    // unlike line-point visibility. Dropping the `+ candleWidth` term would
    // drop this candle and lose the 500 high from the target range.
    const wt = wtState({ to: 20, rangeToMin: -1, rangeToMax: -1 });
    updateCandleWindowTransition(
      100,
      wt,
      20,
      90,
      110,
      NOW_MS,
      NOW,
      [candle(880, 100, 500), candle(940, 100, 110)],
      undefined,
      WIDTH,
      BUFFER
    );
    expect(wt.rangeToMax).toBeGreaterThan(500);
  });

  it('excludes a candle that ends entirely before the target left edge', () => {
    const wt = wtState({ to: 20, rangeToMin: -1, rangeToMax: -1 });
    updateCandleWindowTransition(
      100,
      wt,
      20,
      90,
      110,
      NOW_MS,
      NOW,
      [candle(700, 100, 9999), candle(940, 100, 110)],
      undefined,
      WIDTH,
      BUFFER
    );
    expect(wt.rangeToMax).toBeLessThan(200);
  });

  it('includes the live candle in the target range', () => {
    // The live candle is not part of the `candles` array; omitting it from the
    // scan makes the Y range snap the instant the transition ends.
    const wt = wtState({ to: 20, rangeToMin: -1, rangeToMax: -1 });
    updateCandleWindowTransition(
      100,
      wt,
      20,
      90,
      110,
      NOW_MS,
      NOW,
      [candle(940, 100, 110)],
      candle(1000, 100, 400),
      WIDTH,
      BUFFER
    );
    expect(wt.rangeToMax).toBeGreaterThan(400);
  });

  it('ignores a live candle that falls outside the target window', () => {
    const wt = wtState({ to: 20, rangeToMin: -1, rangeToMax: -1 });
    updateCandleWindowTransition(
      100,
      wt,
      20,
      90,
      110,
      NOW_MS,
      NOW,
      [candle(940, 100, 110)],
      candle(100, 100, 9999),
      WIDTH,
      BUFFER
    );
    expect(wt.rangeToMax).toBeLessThan(200);
  });

  it('leaves the previous target range untouched when the target window is empty', () => {
    const wt = wtState({ to: 20, rangeToMin: 42, rangeToMax: 84 });
    updateCandleWindowTransition(
      100,
      wt,
      20,
      90,
      110,
      NOW_MS,
      NOW,
      [candle(100, 1, 2)],
      undefined,
      WIDTH,
      BUFFER
    );
    expect(wt.rangeToMin).toBe(42);
    expect(wt.rangeToMax).toBe(84);
  });

  it('does not re-trigger while the same window stays selected', () => {
    const wt = wtState({ to: 20 });
    const candles = [candle(940, 100, 110)];
    updateCandleWindowTransition(
      100,
      wt,
      20,
      90,
      110,
      NOW_MS,
      NOW,
      candles,
      undefined,
      WIDTH,
      BUFFER
    );
    updateCandleWindowTransition(
      100,
      wt,
      55,
      1,
      2,
      NOW_MS + 300,
      NOW,
      candles,
      undefined,
      WIDTH,
      BUFFER
    );
    expect(wt.startMs).toBe(NOW_MS);
    expect(wt.from).toBe(20);
    expect(wt.rangeFromMin).toBe(90);
  });
});

describe('updateCandleWindowTransition — progress curve', () => {
  const candles = [candle(940, 100, 110)];
  const start = (wt: CandleWt, target: number, now_ms: number) =>
    updateCandleWindowTransition(
      target,
      wt,
      10,
      90,
      110,
      now_ms,
      1000,
      candles,
      undefined,
      60,
      0.05
    );

  it('reports the resting window with zero progress when nothing is running', () => {
    const wt = wtState({ to: 100, startMs: 0 });
    const r = updateCandleWindowTransition(
      100,
      wt,
      100,
      90,
      110,
      50_000,
      1000,
      candles,
      undefined,
      60,
      0.05
    );
    expect(r.windowSecs).toBe(100);
    expect(r.windowTransProgress).toBe(0);
  });

  it('interpolates the window in LOG space — halfway is the geometric mean', () => {
    // 10 → 40 at t=0.5 gives 20, not the linear 25. Shares logLerp with the
    // line pipeline; this pins them to the same curve.
    const wt = wtState({ to: 10, startMs: 0 });
    start(wt, 40, 1000);
    const r = start(wt, 40, 1000 + WINDOW_TRANSITION_MS / 2);
    expect(r.windowTransProgress).toBeCloseTo(0.5, 12);
    expect(r.windowSecs).toBeCloseTo(20, 10);
    expect(r.windowSecs).not.toBeCloseTo(25, 1);
  });

  it('eases in and out rather than ramping linearly', () => {
    const wt = wtState({ to: 10, startMs: 0 });
    start(wt, 40, 1000);
    const r = start(wt, 40, 1000 + WINDOW_TRANSITION_MS / 4);
    expect(r.windowTransProgress).toBeCloseTo(0.14644660940672627, 12);
  });

  it('lands exactly on the target window and clears the transition when time runs out', () => {
    const wt = wtState({ to: 10, startMs: 0 });
    start(wt, 40, 1000);
    const r = start(wt, 40, 1000 + WINDOW_TRANSITION_MS);
    expect(r.windowSecs).toBe(40);
    expect(r.windowTransProgress).toBe(0);
    expect(wt.startMs).toBe(0);
  });

  it('is wall-clock driven, so 60Hz and 120Hz agree at every shared instant', () => {
    const START = 1000;
    const INSTANTS = [1150, 1300, 1450, 1600, 1700];
    const run = (frameMs: number): number[] => {
      const wt = wtState({ to: 10, startMs: 0 });
      start(wt, 40, START);
      const out: number[] = [];
      let t = frameMs;
      for (const instant of INSTANTS) {
        for (; t < instant; t += frameMs) start(wt, 40, t);
        out.push(start(wt, 40, instant).windowSecs);
      }
      return out;
    };
    const at60 = run(1000 / 60);
    const at120 = run(1000 / 120);
    expect(at60).toEqual(at120);
    expect(at60[0]).toBeLessThan(40);
    expect(at60[0]).toBeGreaterThan(10);
  });
});
