import {
  computeAdaptiveSpeed,
  updateWindowTransition,
  updateRange,
  updateHoverState,
  type WindowTransState,
} from '../helpers';
import {
  ADAPTIVE_SPEED_BOOST,
  SCRUB_LERP_SPEED,
  WINDOW_TRANSITION_MS,
} from '../constants';
import type { EngineConfigStep } from '../types';
import type { ChartLayout, LivelinePoint, Padding } from '../../types';

// ── Fixtures ───────────────────────────────────────────────────────────────

const PAD: Required<Padding> = { top: 0, right: 20, bottom: 0, left: 10 };

const pts = (spec: Array<[number, number]>): LivelinePoint[] =>
  spec.map(([time, value]) => ({ time, value }));

const cfg = (over: Partial<EngineConfigStep> = {}): EngineConfigStep =>
  ({
    windowSecs: 60,
    noMotion: false,
    exaggerate: false,
    ...over,
  }) as EngineConfigStep;

const wtState = (over: Partial<WindowTransState> = {}): WindowTransState => ({
  from: 0,
  to: 60,
  startMs: 0,
  rangeFromMin: 0,
  rangeFromMax: 0,
  rangeToMin: 0,
  rangeToMax: 0,
  ...over,
});

/**
 * Linear time/value mapping over `[leftEdge, rightEdge] → [pad.left,
 * pad.left + chartW]`, matching what engine/step.ts builds each frame.
 */
function makeLayout(
  leftEdge: number,
  rightEdge: number,
  w: number,
  chartW: number
): ChartLayout {
  return {
    w,
    h: 200,
    pad: PAD,
    chartW,
    chartH: 200,
    leftEdge,
    rightEdge,
    minVal: 0,
    maxVal: 100,
    valRange: 100,
    toX: (t: number) =>
      PAD.left + ((t - leftEdge) / (rightEdge - leftEdge)) * chartW,
    toY: (v: number) => 200 - v * 2,
  };
}

/**
 * The naive, frame-rate-*dependent* lerp — `current + (target - current) *
 * speed`, applied once per frame regardless of dt. Several tests below assert
 * that the real implementation does NOT behave like this.
 */
function naiveLerp(current: number, target: number, speed: number): number {
  return current + (target - current) * speed;
}

// ── computeAdaptiveSpeed ───────────────────────────────────────────────────

describe('computeAdaptiveSpeed', () => {
  it('returns exactly 1 (instant snap) under noMotion, ignoring every other input', () => {
    expect(computeAdaptiveSpeed(500, 1, 0, 10, 0.08, true)).toBe(1);
    expect(computeAdaptiveSpeed(1, 1, 0, 10, 0.9, true)).toBe(1);
  });

  it('applies the full boost when the value has not moved at all', () => {
    // gapRatio 0 → speed = lerpSpeed + boost. Inverting the `1 - gapRatio`
    // term would give plain lerpSpeed here.
    expect(computeAdaptiveSpeed(100, 100, 90, 110, 0.08, false)).toBe(
      0.08 + ADAPTIVE_SPEED_BOOST
    );
  });

  it('applies no boost at all when the jump spans the whole visible range', () => {
    // gapRatio 1 → speed = lerpSpeed exactly: big jumps animate slowly.
    expect(computeAdaptiveSpeed(120, 100, 90, 110, 0.08, false)).toBe(0.08);
  });

  it('clamps gapRatio at 1 so an enormous jump never produces a speed below lerpSpeed', () => {
    // Without Math.min, a 10x-range jump yields a large negative boost and
    // the display value would run *away* from the target.
    const speed = computeAdaptiveSpeed(300, 100, 90, 110, 0.08, false);
    expect(speed).toBe(0.08);
    expect(speed).toBeGreaterThan(0);
  });

  it('interpolates linearly between the two extremes', () => {
    // gap 10, range 20 → gapRatio 0.5 → half the boost.
    expect(computeAdaptiveSpeed(110, 100, 90, 110, 0.08, false)).toBeCloseTo(
      0.08 + 0.5 * ADAPTIVE_SPEED_BOOST,
      12
    );
  });

  it('falls back to a range of 1 when the display range is degenerate', () => {
    // displayMax === displayMin → `|| 1`. Without it this is a divide by
    // zero: gapRatio becomes NaN and every downstream lerp poisons.
    const speed = computeAdaptiveSpeed(100.5, 100, 100, 100, 0.08, false);
    expect(Number.isNaN(speed)).toBe(false);
    expect(speed).toBeCloseTo(0.08 + 0.5 * ADAPTIVE_SPEED_BOOST, 12);
  });

  it('is symmetric: the gap is a magnitude, not a signed difference', () => {
    expect(computeAdaptiveSpeed(105, 100, 90, 110, 0.08, false)).toBe(
      computeAdaptiveSpeed(95, 100, 90, 110, 0.08, false)
    );
  });
});

// ── updateWindowTransition ─────────────────────────────────────────────────

describe('updateWindowTransition — retargeting', () => {
  const NOW = 1000;
  const NOW_MS = 50_000;
  const BUFFER = 0.05;

  it('captures the from-window, from-range and start time on a window change', () => {
    const wt = wtState({ to: 20, rangeToMin: -1, rangeToMax: -1 });
    updateWindowTransition(
      cfg({ windowSecs: 100 }),
      {
        windowTransition: wt,
        displayWindow: 20,
        displayMin: 90,
        displayMax: 110,
      },
      false,
      NOW_MS,
      NOW,
      pts([
        [990, 100],
        [1000, 105],
      ]),
      105,
      BUFFER
    );
    expect(wt.from).toBe(20);
    expect(wt.to).toBe(100);
    expect(wt.startMs).toBe(NOW_MS);
    expect(wt.rangeFromMin).toBe(90);
    expect(wt.rangeFromMax).toBe(110);
  });

  it('seeds the target range from the *target* window, not the current one', () => {
    // Current window is 20s (covers t >= 985); the new window is 100s (covers
    // t >= 905). The spike at t=910 is only inside the target window — if the
    // target range were scanned with the current edges, the Y range would jump
    // discontinuously the moment the transition finished.
    const wt = wtState({ to: 20, rangeToMin: -1, rangeToMax: -1 });
    updateWindowTransition(
      cfg({ windowSecs: 100 }),
      {
        windowTransition: wt,
        displayWindow: 20,
        displayMin: 90,
        displayMax: 110,
      },
      false,
      NOW_MS,
      NOW,
      pts([
        [910, 500],
        [990, 100],
        [1000, 105],
      ]),
      105,
      BUFFER
    );
    expect(wt.rangeToMax).toBeGreaterThan(500);
    expect(wt.rangeToMin).toBeLessThan(105);
  });

  it('excludes points that fall outside the target window entirely', () => {
    // t=800 is before the target left edge (1005 - 100 = 905) and must not
    // drag the target range with it.
    const wt = wtState({ to: 20, rangeToMin: -1, rangeToMax: -1 });
    updateWindowTransition(
      cfg({ windowSecs: 100 }),
      {
        windowTransition: wt,
        displayWindow: 20,
        displayMin: 90,
        displayMax: 110,
      },
      false,
      NOW_MS,
      NOW,
      pts([
        [800, 9999],
        [990, 100],
        [1000, 105],
      ]),
      105,
      BUFFER
    );
    expect(wt.rangeToMax).toBeLessThan(200);
  });

  it('leaves the previously-computed target range untouched when no points are visible', () => {
    // Documented invariant: rangeTo is only overwritten when the target window
    // actually contains data. An unconditional assignment would collapse the
    // Y range onto the current value for an empty window.
    const wt = wtState({ to: 20, rangeToMin: 42, rangeToMax: 84 });
    updateWindowTransition(
      cfg({ windowSecs: 100 }),
      {
        windowTransition: wt,
        displayWindow: 20,
        displayMin: 90,
        displayMax: 110,
      },
      false,
      NOW_MS,
      NOW,
      pts([[100, 5]]),
      105,
      BUFFER
    );
    expect(wt.rangeToMin).toBe(42);
    expect(wt.rangeToMax).toBe(84);
  });

  it('does not re-trigger while the same window stays selected', () => {
    const wt = wtState({ to: 20 });
    const points = pts([
      [990, 100],
      [1000, 105],
    ]);
    updateWindowTransition(
      cfg({ windowSecs: 100 }),
      {
        windowTransition: wt,
        displayWindow: 20,
        displayMin: 90,
        displayMax: 110,
      },
      false,
      NOW_MS,
      NOW,
      points,
      105,
      BUFFER
    );
    updateWindowTransition(
      cfg({ windowSecs: 100 }),
      { windowTransition: wt, displayWindow: 55, displayMin: 1, displayMax: 2 },
      false,
      NOW_MS + 300,
      NOW,
      points,
      105,
      BUFFER
    );
    // A restart would move startMs forward and clobber the captured `from`.
    expect(wt.startMs).toBe(NOW_MS);
    expect(wt.from).toBe(20);
    expect(wt.rangeFromMin).toBe(90);
  });
});

describe('updateWindowTransition — progress curve', () => {
  const points = pts([
    [990, 100],
    [1000, 105],
  ]);

  it('snaps straight to the target window under noMotion', () => {
    const wt = wtState({ to: 20 });
    const r = updateWindowTransition(
      cfg({ windowSecs: 100 }),
      {
        windowTransition: wt,
        displayWindow: 20,
        displayMin: 90,
        displayMax: 110,
      },
      true,
      50_000,
      1000,
      points,
      105,
      0.05
    );
    expect(r.windowSecs).toBe(100);
    expect(r.windowTransProgress).toBe(0);
  });

  it('reports the resting window with zero progress when no transition is running', () => {
    const wt = wtState({ to: 100, startMs: 0 });
    const r = updateWindowTransition(
      cfg({ windowSecs: 100 }),
      {
        windowTransition: wt,
        displayWindow: 100,
        displayMin: 90,
        displayMax: 110,
      },
      false,
      50_000,
      1000,
      points,
      105,
      0.05
    );
    expect(r.windowSecs).toBe(100);
    expect(r.windowTransProgress).toBe(0);
  });

  it('interpolates the window in LOG space — the halfway point is the geometric mean', () => {
    // 10s → 40s. easeInOutCos(0.5) === 0.5, so halfway through the duration
    // logLerp gives sqrt(10 * 40) = 20. A linear lerp would give 25 — this is
    // the single assertion that pins window morphing to log space.
    const wt = wtState({ to: 10, startMs: 0 });
    updateWindowTransition(
      cfg({ windowSecs: 40 }),
      {
        windowTransition: wt,
        displayWindow: 10,
        displayMin: 90,
        displayMax: 110,
      },
      false,
      1000,
      1000,
      points,
      105,
      0.05
    );
    const r = updateWindowTransition(
      cfg({ windowSecs: 40 }),
      {
        windowTransition: wt,
        displayWindow: 10,
        displayMin: 90,
        displayMax: 110,
      },
      false,
      1000 + WINDOW_TRANSITION_MS / 2,
      1000,
      points,
      105,
      0.05
    );
    expect(r.windowTransProgress).toBeCloseTo(0.5, 12);
    expect(r.windowSecs).toBeCloseTo(20, 10);
    expect(r.windowSecs).not.toBeCloseTo(25, 1);
  });

  it('eases in and out — quarter-way through is not a quarter of the way there', () => {
    const wt = wtState({ to: 10, startMs: 0 });
    updateWindowTransition(
      cfg({ windowSecs: 40 }),
      {
        windowTransition: wt,
        displayWindow: 10,
        displayMin: 90,
        displayMax: 110,
      },
      false,
      1000,
      1000,
      points,
      105,
      0.05
    );
    const r = updateWindowTransition(
      cfg({ windowSecs: 40 }),
      {
        windowTransition: wt,
        displayWindow: 10,
        displayMin: 90,
        displayMax: 110,
      },
      false,
      1000 + WINDOW_TRANSITION_MS / 4,
      1000,
      points,
      105,
      0.05
    );
    // easeInOutCos(0.25) = (1 - cos(pi/4)) / 2 ≈ 0.14645 — a linear ramp would
    // report 0.25 here.
    expect(r.windowTransProgress).toBeCloseTo(0.14644660940672627, 12);
  });

  it('lands exactly on the configured window and clears the transition when time runs out', () => {
    const wt = wtState({ to: 10, startMs: 0 });
    updateWindowTransition(
      cfg({ windowSecs: 40 }),
      {
        windowTransition: wt,
        displayWindow: 10,
        displayMin: 90,
        displayMax: 110,
      },
      false,
      1000,
      1000,
      points,
      105,
      0.05
    );
    const r = updateWindowTransition(
      cfg({ windowSecs: 40 }),
      {
        windowTransition: wt,
        displayWindow: 10,
        displayMin: 90,
        displayMax: 110,
      },
      false,
      1000 + WINDOW_TRANSITION_MS,
      1000,
      points,
      105,
      0.05
    );
    // Exactness matters: logLerp(from, to, 1) is only approximately `to`, and
    // a residual epsilon here keeps the range/grid caches invalidating forever.
    expect(r.windowSecs).toBe(40);
    expect(r.windowTransProgress).toBe(0);
    expect(wt.startMs).toBe(0);
  });

  it('is driven by wall clock, so 60Hz and 120Hz stepping agree at every instant', () => {
    // Sampled at shared instants, with the intervening frames actually
    // stepped through — so a rewrite that accumulated progress per frame
    // instead of reading the clock would come out ahead at 120Hz.
    const START = 1000;
    const INSTANTS = [1150, 1300, 1450, 1600, 1700];
    const call = (wt: WindowTransState, now_ms: number) =>
      updateWindowTransition(
        cfg({ windowSecs: 40 }),
        {
          windowTransition: wt,
          displayWindow: 10,
          displayMin: 90,
          displayMax: 110,
        },
        false,
        now_ms,
        1000,
        points,
        105,
        0.05
      ).windowSecs;

    const run = (frameMs: number): number[] => {
      const wt = wtState({ to: 10, startMs: 0 });
      call(wt, START);
      const out: number[] = [];
      let t = frameMs;
      for (const instant of INSTANTS) {
        for (; t < instant; t += frameMs) call(wt, t);
        out.push(call(wt, instant));
      }
      return out;
    };

    const at60 = run(1000 / 60);
    const at120 = run(1000 / 120);
    expect(at60).toEqual(at120);
    // sanity: the samples are actually mid-flight, not all pinned at 40
    expect(at60[0]).toBeLessThan(40);
    expect(at60[0]).toBeGreaterThan(10);
  });
});

// ── updateRange ────────────────────────────────────────────────────────────

const RANGE_WT = {
  from: 0,
  to: 0,
  startMs: 0,
  rangeFromMin: 0,
  rangeFromMax: 100,
  rangeToMin: 50,
  rangeToMax: 150,
};

describe('updateRange — first frame', () => {
  it('adopts the computed range verbatim and marks itself inited', () => {
    const r = updateRange(
      {
        windowTransition: wtState(),
        rangeInited: false,
        targetMin: -1,
        targetMax: -1,
        displayMin: -1,
        displayMax: -1,
      },
      { min: 3, max: 7 },
      false,
      0,
      0.08,
      300,
      16.67
    );
    expect(r).toEqual({
      minVal: 3,
      maxVal: 7,
      valRange: 4,
      targetMin: 3,
      targetMax: 7,
      displayMin: 3,
      displayMax: 7,
      rangeInited: true,
    });
  });

  it('never reports a zero valRange (it is a divisor for every toY)', () => {
    const r = updateRange(
      {
        windowTransition: wtState(),
        rangeInited: false,
        targetMin: 0,
        targetMax: 0,
        displayMin: 0,
        displayMax: 0,
      },
      { min: 5, max: 5 },
      false,
      0,
      0.08,
      300,
      16.67
    );
    expect(r.valRange).toBe(0.001);
  });
});

describe('updateRange — during a window transition', () => {
  it('blends linearly between the captured from/to ranges by progress alone', () => {
    const r = updateRange(
      {
        windowTransition: { ...wtState(), ...RANGE_WT },
        rangeInited: true,
        targetMin: 0,
        targetMax: 0,
        displayMin: /* displayMin */ 1234,
        displayMax: /* displayMax */ 5678,
      },
      { min: 999, max: 999 },
      true,
      0.25,
      0.08,
      300,
      16.67
    );
    // 0 → 50 at 25% = 12.5; 100 → 150 at 25% = 112.5. The incoming
    // display values are ignored outright while transitioning.
    expect(r.displayMin).toBe(12.5);
    expect(r.displayMax).toBe(112.5);
    expect(r.minVal).toBe(12.5);
    expect(r.maxVal).toBe(112.5);
  });

  it('still tracks the computed range as the target for when the transition ends', () => {
    const r = updateRange(
      {
        windowTransition: { ...wtState(), ...RANGE_WT },
        rangeInited: true,
        targetMin: 0,
        targetMax: 0,
        displayMin: 1234,
        displayMax: 5678,
      },
      { min: 42, max: 84 },
      true,
      0.25,
      0.08,
      300,
      16.67
    );
    expect(r.targetMin).toBe(42);
    expect(r.targetMax).toBe(84);
  });

  it('reaches the captured target range exactly at full progress', () => {
    const r = updateRange(
      {
        windowTransition: { ...wtState(), ...RANGE_WT },
        rangeInited: true,
        targetMin: 0,
        targetMax: 0,
        displayMin: 0,
        displayMax: 0,
      },
      { min: 0, max: 0 },
      true,
      1,
      0.08,
      300,
      16.67
    );
    expect(r.displayMin).toBe(50);
    expect(r.displayMax).toBe(150);
  });
});

describe('updateRange — steady-state lerp', () => {
  /** Runs `frames` frames of `dt` ms each, returning the final display range. */
  function run(frames: number, dt: number, chartH: number) {
    let displayMin = 0;
    let displayMax = 100;
    for (let i = 0; i < frames; i++) {
      const r = updateRange(
        {
          windowTransition: wtState(),
          rangeInited: true,
          targetMin: 0,
          targetMax: 0,
          displayMin: displayMin,
          displayMax: displayMax,
        },
        { min: 40, max: 160 },
        false,
        0,
        0.08,
        chartH,
        dt
      );
      displayMin = r.displayMin;
      displayMax = r.displayMax;
    }
    return { displayMin, displayMax };
  }

  it('is frame-rate independent: 100ms at 60Hz and 100ms at 120Hz land on the same value', () => {
    // 100ms is deliberately mid-flight — long enough to diverge, short enough
    // that neither rate has converged (which would make the test vacuous).
    // chartH is huge so the pixel snap can never mask a difference.
    const at60 = run(6, 1000 / 60, 1e9);
    const at120 = run(12, 1000 / 120, 1e9);
    expect(at60.displayMin).toBeGreaterThan(5);
    expect(at60.displayMin).toBeLessThan(35);
    expect(at120.displayMin).toBeCloseTo(at60.displayMin, 8);
    expect(at120.displayMax).toBeCloseTo(at60.displayMax, 8);
  });

  it('a naive per-frame lerp WOULD fail that test — the two rates diverge visibly', () => {
    const naive = (frames: number) => {
      let v = 0;
      for (let i = 0; i < frames; i++) v = naiveLerp(v, 40, 0.08);
      return v;
    };
    // Same 100ms of wall clock, double the frames: the dt-blind version is
    // most of the way there at 120Hz and barely started at 60Hz.
    expect(Math.abs(naive(12) - naive(6))).toBeGreaterThan(5);
  });

  it('converges monotonically without overshoot', () => {
    let displayMin = 0;
    let prev = -Infinity;
    for (let i = 0; i < 200; i++) {
      const r = updateRange(
        {
          windowTransition: wtState(),
          rangeInited: true,
          targetMin: 0,
          targetMax: 0,
          displayMin: displayMin,
          displayMax: 100,
        },
        { min: 40, max: 160 },
        false,
        0,
        0.08,
        1e9,
        1000 / 60
      );
      expect(r.displayMin).toBeGreaterThanOrEqual(prev);
      expect(r.displayMin).toBeLessThanOrEqual(40);
      prev = r.displayMin;
      displayMin = r.displayMin;
    }
  });

  it('snaps to a BIT-EXACT target once inside the sub-pixel threshold', () => {
    // Exactness is the property under test: engine/step.ts's caches key off
    // displayMin/displayMax, so an epsilon of residual drift rebuilds chart
    // geometry every single frame forever. `toBeCloseTo` would not catch that.
    const { displayMin, displayMax } = run(300, 1000 / 60, 300);
    expect(displayMin).toBe(40);
    expect(displayMax).toBe(160);
  });

  it('an unsnapped exponential lerp would never reach the target exactly', () => {
    // Proves the previous test is testing the snap and not just the lerp.
    let v = 0;
    for (let i = 0; i < 300; i++) v = naiveLerp(v, 40, 0.08);
    expect(v).not.toBe(40);
    expect(v).toBeLessThan(40);
  });

  it('keeps a positive snap threshold when the display range is degenerate', () => {
    // curRange 0 → (0.5 * 0) / chartH === 0 → falls back to 0.001, so a
    // collapsed range can still converge instead of stalling on a zero
    // threshold.
    let displayMin = 5;
    let displayMax = 5;
    for (let i = 0; i < 400; i++) {
      const r = updateRange(
        {
          windowTransition: wtState(),
          rangeInited: true,
          targetMin: 0,
          targetMax: 0,
          displayMin: displayMin,
          displayMax: displayMax,
        },
        { min: 5, max: 5.0005 },
        false,
        0,
        0.08,
        300,
        1000 / 60
      );
      displayMin = r.displayMin;
      displayMax = r.displayMax;
    }
    expect(displayMax).toBe(5.0005);
  });
});

// ── updateHoverState ───────────────────────────────────────────────────────

describe('updateHoverState — hit testing', () => {
  const W = 210;
  const CHART_W = 180;
  const layout = makeLayout(0, 100, W, CHART_W);
  const visible = pts([
    [0, 0],
    [50, 50],
    [100, 100],
  ]);

  const call = (
    hoverPixelX: number | null,
    scrubAmount = 0,
    lastHover: { x: number; value: number; time: number } | null = null,
    now = 100
  ) =>
    updateHoverState(
      hoverPixelX,
      layout,
      now,
      visible,
      scrubAmount,
      lastHover,
      false
    );

  it('maps a pixel inside the plot area to an interpolated time and value', () => {
    const r = call(55);
    // (55 - 10) / 180 * 100 = 25
    expect(r.hoverTime).toBe(25);
    expect(r.hoverValue).toBe(25);
    expect(r.hoverX).toBe(55);
    expect(r.isActiveHover).toBe(true);
  });

  it('includes both padding edges (inclusive bounds)', () => {
    expect(call(PAD.left).isActiveHover).toBe(true);
    expect(call(W - PAD.right).isActiveHover).toBe(true);
  });

  it('rejects a pixel one unit outside either padding edge', () => {
    expect(call(PAD.left - 1).isActiveHover).toBe(false);
    expect(call(W - PAD.right + 1).isActiveHover).toBe(false);
  });

  it('clamps the hover to the live edge so you cannot scrub into the future', () => {
    // now = 50 → maxHoverX = toX(50) = 100. Dropping the clamp would report
    // t = 100 / value = 100, i.e. data that does not exist yet.
    const r = call(190, 0, null, 50);
    expect(r.hoverX).toBe(100);
    expect(r.hoverTime).toBe(50);
    expect(r.hoverValue).toBe(50);
  });

  it('reports no hover when there is no data to interpolate', () => {
    const r = updateHoverState(55, layout, 100, [], 0, null, false);
    expect(r.isActiveHover).toBe(false);
    expect(r.hoverValue).toBeNull();
    expect(r.emitPoint).toBeNull();
  });

  it('emits a point carrying the CLAMPED pixel position and its projected y', () => {
    const r = call(55);
    expect(r.emitPoint).toEqual({
      time: 25,
      value: 25,
      x: 55,
      y: layout.toY(25),
    });
  });

  it('emits nothing on a frame with no active hover', () => {
    expect(call(null, 1, { x: 55, value: 25, time: 25 }).emitPoint).toBeNull();
  });
});

describe('updateHoverState — scrub fade', () => {
  const W = 210;
  const CHART_W = 180;
  const layout = makeLayout(0, 100, W, CHART_W);
  const visible = pts([
    [0, 0],
    [100, 100],
  ]);

  const step = (
    hoverPixelX: number | null,
    scrubAmount: number,
    lastHover: { x: number; value: number; time: number } | null,
    noMotion = false
  ) =>
    updateHoverState(
      hoverPixelX,
      layout,
      100,
      visible,
      scrubAmount,
      lastHover,
      noMotion
    );

  it('jumps the scrub amount to exactly 1 / 0 under noMotion', () => {
    expect(step(55, 0, null, true).scrubAmount).toBe(1);
    expect(step(null, 1, null, true).scrubAmount).toBe(0);
  });

  it('reaches exactly 1 after 37 frames of fade-in, and not before', () => {
    // The scrub lerp is deliberately frame-*count* based (no dt argument), so
    // the frame count is the behaviour. Lowering SCRUB_LERP_SPEED or adding a
    // dt term moves this number.
    let scrub = 0;
    let firstExact = -1;
    for (let i = 1; i <= 60; i++) {
      scrub = step(55, scrub, null).scrubAmount;
      if (scrub === 1 && firstExact === -1) firstExact = i;
    }
    expect(firstExact).toBe(37);
    // sanity: the raw geometric decay predicts the same frame
    expect(Math.ceil(Math.log(0.01) / Math.log(1 - SCRUB_LERP_SPEED))).toBe(37);
  });

  it('reaches exactly 0 on fade-out, so a settled chart can quiesce', () => {
    // isQuiescentCandidate requires scrubAmount === 0 exactly; without the
    // `< 0.01 → 0` snap the chart would re-record pictures forever after a
    // single hover.
    let scrub = 1;
    for (let i = 0; i < 60; i++) {
      scrub = step(null, scrub, { x: 55, value: 25, time: 25 }).scrubAmount;
    }
    expect(scrub).toBe(0);
  });

  it('holds the last hover position while fading out', () => {
    const last = { x: 55, value: 25, time: 25 };
    const r = step(null, 0.5, last);
    expect(r.hoverX).toBe(55);
    expect(r.hoverValue).toBe(25);
    expect(r.hoverTime).toBe(25);
    expect(r.isActiveHover).toBe(false);
  });

  it('drops the held position once the fade completes', () => {
    const r = step(null, 0.005, { x: 55, value: 25, time: 25 });
    expect(r.scrubAmount).toBe(0);
    expect(r.hoverX).toBeNull();
    expect(r.hoverValue).toBeNull();
  });

  it('updates the remembered hover on every active frame', () => {
    const r = step(100, 1, { x: 55, value: 25, time: 25 });
    expect(r.lastHover).toEqual({ x: 100, value: 50, time: 50 });
  });

  it('preserves the incoming lastHover when the pointer leaves the plot area', () => {
    const last = { x: 55, value: 25, time: 25 };
    expect(step(PAD.left - 1, 1, last).lastHover).toBe(last);
  });
});
