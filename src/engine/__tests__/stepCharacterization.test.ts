/**
 * Characterization tests for `engineStep` — the safety net for PLAN_MAINT #1
 * (extracting the three inline pipelines out of the ~1,900-line function).
 *
 * These are deliberately NOT regression tests for known bugs (that is what
 * `step.test.ts` is). They pin the *surface*: what the engine's state looks
 * like after a fixed sequence of frames, which draw calls happen in which
 * order, and — the part nobody had covered — what survives a mode switch.
 * `engineStep`'s three pipelines share one `EngineState`, so "stale state
 * leaking between pipelines" is the highest-value bug class here and the
 * extraction is exactly the operation that could introduce or hide it.
 *
 * ## How these assert, and why
 *
 * Never on the argument tuple handed to a mocked draw function — those
 * signatures are being converted to options objects. Assertions are on:
 *   - `EngineState` field values after N deterministic frames (the richest
 *     and most refactor-stable signal),
 *   - which draw functions ran, how many times, and in what order,
 *   - `StepOutput` fields,
 *   - and, where one argument is genuinely load-bearing, that ONE argument.
 *
 * ## Determinism
 *
 * `engineStep` reads `Date.now()` (three sites, one per pipeline) and nothing
 * else non-deterministic — no `Math.random` (the only randomness in the render
 * path lives in `draw/orderbook` + `draw/particles`, both behind the mocked
 * draw layer). `Date.now` is stubbed to a fake clock that advances in lockstep
 * with `now_ms`, so every number below is reproducible.
 */

jest.mock('@shopify/react-native-skia', () => ({
  Skia: {
    PictureRecorder: jest.fn(),
    XYWHRect: jest.fn(),
  },
}));

jest.mock('../../draw', () => {
  const actual = jest.requireActual('../../draw');
  return {
    ...actual,
    drawFrame: jest.fn(),
    drawMultiFrame: jest.fn(),
    drawCandleFrame: jest.fn(),
    drawEdgeFade: jest.fn(),
  };
});
jest.mock('../../draw/loading', () => ({ drawLoading: jest.fn() }));
jest.mock('../../draw/empty', () => ({ drawEmpty: jest.fn() }));
jest.mock('../badge', () => ({ drawBadge: jest.fn() }));
jest.mock('../gridLayer', () => ({ updateGridLayer: jest.fn() }));
jest.mock('../lineScrollLayer', () => ({ updateLineScrollLayer: jest.fn() }));

import type {
  LivelinePoint,
  LivelinePalette,
  CandlePoint,
  LivelineFonts,
  DegenOptions,
} from '../../types';
import type { Ctx2D } from '../../draw/canvas2d';
import type { EngineConfigStep } from '../types';
import { createEngineState, type EngineState } from '../state';
import { engineStep, type StepOutput } from '../step';
import {
  drawFrame,
  drawMultiFrame,
  drawCandleFrame,
  drawEdgeFade,
} from '../../draw';
import { drawEmpty } from '../../draw/empty';
import { drawLoading } from '../../draw/loading';
import { drawBadge } from '../badge';
import { updateGridLayer } from '../gridLayer';
import { updateLineScrollLayer } from '../lineScrollLayer';
import { writeLayoutKey } from '../../draw/pathCache';
import type { ChartLayout } from '../../types';

// ── Fixed world ──────────────────────────────────────────────────────────

const W = 400;
const H = 200;
const PAD = { top: 10, right: 20, bottom: 20, left: 10 };
const DT = 16;
/** Wall clock origin. Chosen round so the derived timestamps below are exact
 * in float64 and the golden numbers stay stable. */
const START_MS = 1_700_000_000_000;
const NOW_S = START_MS / 1000;
/**
 * One window width for every config AND for the initial `EngineState`, so no
 * test here ever starts a window transition. That is deliberate: window
 * transitions are already covered by `helpers.test.ts`, and leaving one
 * running across a mode switch would smear its own lerp over the
 * cross-pipeline state these tests are actually about.
 */
const WINDOW = 600;

const PALETTE: LivelinePalette = {
  line: '#3b82f6',
  lineWidth: 2,
  fillTop: 'rgba(59,130,246,0.3)',
  fillBottom: 'rgba(59,130,246,0)',
  dot: '#3b82f6',
  dotRing: 'rgba(59,130,246,0.3)',
  gridLine: '#222',
  gridLabel: '#888',
  badgeBg: '#3b82f6',
  badgeText: '#fff',
  up: '#22c55e',
  down: '#ef4444',
} as unknown as LivelinePalette;

const PALETTE_B: LivelinePalette = {
  ...PALETTE,
  line: '#f59e0b',
} as unknown as LivelinePalette;

const FONTS = {} as unknown as LivelineFonts;

/** Fake clock backing the stubbed `Date.now`. Advanced by the driver. */
let clockMs = START_MS;

function makeCtx(): Ctx2D {
  return {
    font: '',
    fonts: { seriesLabel: 'label' },
    measureText: () => ({ width: 10 }),
  } as unknown as Ctx2D;
}

function makeCfg(over: Partial<EngineConfigStep> = {}): EngineConfigStep {
  return {
    value: 100,
    palette: PALETTE,
    windowSecs: WINDOW,
    lerpSpeed: 0.15,
    showGrid: false,
    showBadge: false,
    showMomentum: false,
    showFill: false,
    formatValue: (v: number) => v.toFixed(2),
    formatTime: (t: number) => String(t),
    padding: PAD,
    hasOnHover: false,
    showPulse: false,
    scrub: false,
    active: true,
    exaggerate: false,
    badgeTail: false,
    badgeVariant: 'default' as EngineConfigStep['badgeVariant'],
    tooltipY: 0,
    tooltipOutline: false,
    valueMomentumColor: false,
    showValue: false,
    noMotion: false,
    mode: 'line',
    dataRev: 1,
    candlesRev: 1,
    ...over,
  } as EngineConfigStep;
}

function makeState(over: Partial<EngineState> = {}): EngineState {
  const s = createEngineState(100, WINDOW, false, 60);
  // Skip the reveal ramp — the golden sequences are about steady state, and
  // chartReveal < 1 disables both the grid picture cache and the scroll layer.
  s.chartReveal = 1;
  Object.assign(s, over);
  return s;
}

interface FrameArgs {
  data?: LivelinePoint[];
  candles?: CandlePoint[];
  multiData?: Record<string, LivelinePoint[]>;
  hoverX?: number | null;
}

/** One frame. Advances the fake clock by `DT` afterwards, so `now_ms` and
 * `Date.now()` stay in lockstep exactly as they do in the real frame
 * callback. */
function frame(
  s: EngineState,
  cfg: EngineConfigStep,
  args: FrameArgs = {}
): StepOutput {
  const out = engineStep(
    makeCtx(),
    cfg,
    s,
    W,
    H,
    args.hoverX ?? null,
    DT,
    clockMs,
    FONTS,
    args.data ?? [],
    args.candles ?? [],
    args.multiData ?? {}
  );
  clockMs += DT;
  return out;
}

// ── Deterministic fixtures ───────────────────────────────────────────────

/** `n` points ending exactly at `NOW_S - endAgo`, spanning `span` seconds,
 * values walking a fixed ramp. No dependence on the real wall clock. */
function linePoints(
  n = 20,
  span = 500,
  endAgo = 0,
  base = 100,
  slope = 0.5
): LivelinePoint[] {
  const out: LivelinePoint[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      time: NOW_S - endAgo - span + (i / (n - 1)) * span,
      value: base + i * slope,
    });
  }
  return out;
}

/** Five closed 60s candles ending one candle before `NOW_S`. */
function closedCandles(): CandlePoint[] {
  const out: CandlePoint[] = [];
  for (let i = 5; i >= 1; i--) {
    const o = 100 + i;
    out.push({
      time: NOW_S - i * 60,
      open: o,
      high: o + 2,
      low: o - 1,
      close: o + 1,
    });
  }
  return out;
}

const LIVE_CANDLE: CandlePoint = {
  time: NOW_S,
  open: 101,
  high: 108,
  low: 99,
  close: 106,
};

// ── Draw-mock call ordering ──────────────────────────────────────────────

/** Every mocked draw entry point, by name. Deliberately keyed by *identity*
 * of the call, never by arguments — the draw signatures are mid-conversion
 * to options objects and argument tuples must not be pinned here. */
function namedMocks(): [string, jest.Mock][] {
  return [
    ['drawFrame', drawFrame as unknown as jest.Mock],
    ['drawMultiFrame', drawMultiFrame as unknown as jest.Mock],
    ['drawCandleFrame', drawCandleFrame as unknown as jest.Mock],
    ['drawEdgeFade', drawEdgeFade as unknown as jest.Mock],
    ['drawLoading', drawLoading as unknown as jest.Mock],
    ['drawEmpty', drawEmpty as unknown as jest.Mock],
    ['drawBadge', drawBadge as unknown as jest.Mock],
    ['updateGridLayer', updateGridLayer as unknown as jest.Mock],
    ['updateLineScrollLayer', updateLineScrollLayer as unknown as jest.Mock],
  ];
}

/**
 * The flat sequence of draw-layer calls since the last `clearAllMocks`, in
 * true invocation order (jest stamps every mock call with a process-global
 * increasing id, so this is exact across different mocks).
 */
function callSequence(): string[] {
  const events: { order: number; name: string }[] = [];
  for (const [name, fn] of namedMocks()) {
    for (const order of fn.mock.invocationCallOrder)
      events.push({ order, name });
  }
  events.sort((a, b) => a.order - b.order);
  return events.map((e) => e.name);
}

// ── State snapshots ──────────────────────────────────────────────────────

/** Round to 6dp so the goldens are readable and not float-noise-sensitive. */
const r = (n: number) => Math.round(n * 1e6) / 1e6;

function commonSnapshot(s: EngineState) {
  return {
    displayMin: r(s.displayMin),
    displayMax: r(s.displayMax),
    displayWindow: r(s.displayWindow),
    rangeInited: s.rangeInited,
    chartReveal: r(s.chartReveal),
    pauseProgress: r(s.pauseProgress),
    timeDebt: r(s.timeDebt),
    loadingAlpha: r(s.loadingAlpha),
    scrubAmount: r(s.scrubAmount),
    /** Offset from the clock origin, so the golden is a small number. */
    frozenNowOffset: r(s.frozenNow - NOW_S),
  };
}

function lineSnapshot(s: EngineState) {
  return {
    ...commonSnapshot(s),
    displayValue: r(s.displayValue),
    targetMin: r(s.targetMin),
    targetMax: r(s.targetMax),
    visibleLen: s.visibleScratch.length,
    lastDataLen: s.lastData.length,
    lastDataStashRev: s.lastDataStashRev,
  };
}

function candleSnapshot(s: EngineState) {
  const dc = s.displayCandle;
  return {
    ...commonSnapshot(s),
    displayCandle: dc
      ? {
          open: r(dc.open),
          high: r(dc.high),
          low: r(dc.low),
          close: r(dc.close),
        }
      : null,
    liveBirthAlpha: r(s.liveBirthAlpha),
    liveBull: r(s.liveBull),
    lineSmoothClose: r(s.lineSmoothClose),
    lineSmoothInited: s.lineSmoothInited,
    closeLineSmooth: r(s.closeLineSmooth),
    closeLineSmoothInited: s.closeLineSmoothInited,
    lineModeProg: r(s.lineModeProg),
    lineDensityProg: r(s.lineDensityProg),
    prevCandleDataRev: s.prevCandleDataRev,
    prevCandleWidth: s.prevCandleData.width,
    cwtToWidth: s.candleWidthTrans.toWidth,
    cwtOldWidth: s.candleWidthTrans.oldWidth,
    visibleCandleLen: s.candleVisibleScratch.length,
    lastCandlesLen: s.lastCandles.length,
    hasLastLive: s.lastLive !== null,
  };
}

function multiSnapshot(s: EngineState) {
  return {
    ...commonSnapshot(s),
    targetMin: r(s.targetMin),
    targetMax: r(s.targetMax),
    displayValues: Object.fromEntries(
      [...s.displayValues].map(([k, v]) => [k, r(v)])
    ),
    seriesAlpha: Object.fromEntries(
      [...s.seriesAlpha].map(([k, v]) => [k, r(v)])
    ),
    multiVisibleIds: [...s.multiVisibleScratch.keys()].sort(),
    multiEntryIds: [...s.multiSeriesEntryScratch.keys()].sort(),
    seriesEntriesLen: s.seriesEntriesScratch.length,
    lastMultiSeriesLen: s.lastMultiSeries.length,
    stashDataIds: [...s.lastMultiStashData.keys()].sort(),
  };
}

/** Every per-series map `engineStep` keys by series id, by size. `pruneByIds`
 * (via `perSeriesMaps`) is supposed to empty all five together. */
function perSeriesSizes(s: EngineState) {
  return {
    displayValues: s.displayValues.size,
    seriesAlpha: s.seriesAlpha.size,
    multiVisibleScratch: s.multiVisibleScratch.size,
    multiSeriesEntryScratch: s.multiSeriesEntryScratch.size,
    lineCaches: s.lineCaches.size,
  };
}

// ── Config builders per pipeline ─────────────────────────────────────────

const lineCfg = (over: Partial<EngineConfigStep> = {}) => makeCfg(over);

const candleCfg = (over: Partial<EngineConfigStep> = {}) =>
  makeCfg({
    mode: 'candle',
    candleWidth: 60,
    liveCandle: LIVE_CANDLE,
    ...over,
  });

const multiCfg = (
  ids: string[],
  over: Partial<EngineConfigStep> = {},
  hidden?: string[]
) => {
  const revs: Record<string, number> = {};
  for (const id of ids) revs[id] = 1;
  return makeCfg({
    isMultiSeries: true,
    multiSeries: ids.map((id, i) => ({
      id,
      value: 100 + i * 10,
      palette: i === 0 ? PALETTE : PALETTE_B,
    })),
    multiRevs: revs,
    hiddenSeriesIds: hidden,
    ...over,
  });
};

const multiPoints = (ids: string[]): Record<string, LivelinePoint[]> => {
  const out: Record<string, LivelinePoint[]> = {};
  ids.forEach((id, i) => {
    out[id] = linePoints(20, 500, 0, 100 + i * 10, 0.5 + i * 0.25);
  });
  return out;
};

beforeEach(() => {
  clockMs = START_MS;
  jest.clearAllMocks();
  // clearAllMocks keeps implementations; the ordering tests install their own,
  // so reset them explicitly to no-ops here.
  (drawFrame as unknown as jest.Mock).mockImplementation(() => {});
  (updateLineScrollLayer as unknown as jest.Mock).mockImplementation(() => {});
  jest.spyOn(Date, 'now').mockImplementation(() => clockMs);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════
// 1. Golden frame sequences, one per pipeline
// ═════════════════════════════════════════════════════════════════════════

describe('golden frame sequence: single-series line', () => {
  it('reproduces the exact engine state after 5 frames', () => {
    const s = makeState();
    const cfg = lineCfg({ value: 120, showGrid: true, showBadge: true });
    const data = linePoints();
    for (let i = 0; i < 5; i++) frame(s, cfg, { data });

    // Mutation caught: any change to the value lerp, the range lerp, the
    // window buffer, the visible-point filter bounds or the stash revision
    // gate moves at least one of these numbers.
    expect(lineSnapshot(s)).toEqual({
      displayMin: 98.830506,
      displayMax: 110.915278,
      displayWindow: 600,
      rangeInited: true,
      chartReveal: 1,
      pauseProgress: 0,
      timeDebt: 0,
      loadingAlpha: 0,
      scrubAmount: 0,
      frozenNowOffset: 0.064,
      displayValue: 111.018301,
      targetMin: 98.677804,
      targetMax: 112.340497,
      visibleLen: 20,
      lastDataLen: 20,
      lastDataStashRev: 1,
    });
  });

  it('reproduces the exact draw-call sequence for 2 frames', () => {
    const s = makeState();
    const cfg = lineCfg({ showGrid: true, showBadge: true });
    const data = linePoints();
    frame(s, cfg, { data });
    frame(s, cfg, { data });

    // Order is load-bearing: the grid picture is refreshed before the frame
    // that composites it, and the badge is drawn into the same canvas after
    // the chart so it sits on top.
    expect(callSequence()).toEqual([
      'updateGridLayer',
      'drawFrame',
      'drawBadge',
      'updateGridLayer',
      'drawFrame',
      'drawBadge',
    ]);
    expect(drawEmpty).not.toHaveBeenCalled();
    expect(drawLoading).not.toHaveBeenCalled();
    expect(drawEdgeFade).not.toHaveBeenCalled();
  });

  it('publishes no scroll layer while the line cache is cold', () => {
    // drawFrame is mocked, so it never builds `s.lineCache.prefix`; the gate
    // must therefore never fire, and `scrollPicture` must stay null rather
    // than going stale.
    const s = makeState();
    const cfg = lineCfg();
    const data = linePoints();
    const out = frame(s, cfg, { data });
    expect(updateLineScrollLayer).not.toHaveBeenCalled();
    expect(out.scrollPicture).toBeNull();
    expect(out.scrollDx).toBe(0);
  });

  it('lerps the displayed value toward cfg.value across frames', () => {
    // Mutation caught: swapping `pausedDt` for `dt`, or dropping the
    // VALUE_SNAP_THRESHOLD snap, in the single-series value lerp.
    const s = makeState({ displayValue: 100 });
    const cfg = lineCfg({ value: 200 });
    const data = linePoints();
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      frame(s, cfg, { data });
      seen.push(r(s.displayValue));
    }
    expect(seen).toEqual([114.442967, 126.79994, 137.3722]);
  });
});

describe('golden frame sequence: candle', () => {
  it('reproduces the exact engine state after 5 frames', () => {
    const s = makeState();
    const cfg = candleCfg({ showGrid: true });
    const candles = closedCandles();
    for (let i = 0; i < 5; i++) frame(s, cfg, { candles });

    // Mutation caught: any change to the live-candle OHLC lerp, the
    // bull/bear blend, the close-line smoothing, the candle range lerp, the
    // width-transition bookkeeping or the reverse-morph stash.
    expect(candleSnapshot(s)).toEqual({
      displayMin: 99.003322,
      displayMax: 107.880468,
      displayWindow: 600,
      rangeInited: true,
      chartReveal: 1,
      pauseProgress: 0,
      timeDebt: 0,
      loadingAlpha: 0,
      scrubAmount: 0,
      frozenNowOffset: 0.064,
      displayCandle: {
        open: 101,
        high: 105.680314,
        low: 99.662767,
        close: 104.343081,
      },
      liveBirthAlpha: 0.657291,
      liveBull: 0.729268,
      lineSmoothClose: 106,
      lineSmoothInited: true,
      closeLineSmooth: 106,
      closeLineSmoothInited: true,
      lineModeProg: 0,
      lineDensityProg: 0,
      prevCandleDataRev: 1,
      prevCandleWidth: 60,
      cwtToWidth: 60,
      cwtOldWidth: 60,
      visibleCandleLen: 6,
      lastCandlesLen: 6,
      hasLastLive: true,
    });
  });

  it('reproduces the exact draw-call sequence for 2 frames', () => {
    const s = makeState();
    const cfg = candleCfg({ showGrid: true, showBadge: true });
    const candles = closedCandles();
    frame(s, cfg, { candles });
    frame(s, cfg, { candles });

    // No drawBadge: the candle pipeline gates the badge on
    // `lineModeProg > 0.5`, and this chart is not morphing to line mode.
    // No drawEdgeFade either — that is an early-return-only call.
    expect(callSequence()).toEqual([
      'updateGridLayer',
      'drawCandleFrame',
      'updateGridLayer',
      'drawCandleFrame',
    ]);
    expect(drawFrame).not.toHaveBeenCalled();
    expect(drawBadge).not.toHaveBeenCalled();
  });

  it('never publishes a scroll layer', () => {
    // The scroll layer is single-series-line-only. A refactor that hoists the
    // gate above the pipeline split would break this.
    const s = makeState();
    const out = frame(s, candleCfg(), { candles: closedCandles() });
    expect(out.scrollPicture).toBeNull();
    expect(out.scrollDx).toBe(0);
    expect(updateLineScrollLayer).not.toHaveBeenCalled();
  });

  it('drives the line-mode morph and draws the badge past the halfway point', () => {
    // lineModeProg is advanced from `now_ms` (LINE_MORPH_MS), independent of
    // dt, and the badge gate is `> 0.5`. Mutation caught: moving the
    // lineModeProg update inside the pipeline (it currently runs before the
    // loading/empty early return, on purpose) or changing the badge gate.
    const s = makeState();
    const candles = closedCandles();
    const cfg = candleCfg({ lineMode: true, showBadge: true });
    frame(s, cfg, { candles });
    expect(r(s.lineModeProg)).toBe(0);
    expect(drawBadge).not.toHaveBeenCalled();

    // LINE_MORPH_MS is 500ms at the time of writing; jump the clock past its
    // midpoint rather than hard-coding frame counts.
    clockMs += 400;
    frame(s, cfg, { candles });
    expect(s.lineModeProg).toBeGreaterThan(0.5);
    expect(drawBadge).toHaveBeenCalledTimes(1);
  });
});

describe('golden frame sequence: multi-series', () => {
  it('reproduces the exact engine state after 5 frames', () => {
    const s = makeState();
    const cfg = multiCfg(['a', 'b'], { showGrid: true });
    const md = multiPoints(['a', 'b']);
    for (let i = 0; i < 5; i++) frame(s, cfg, { multiData: md });

    // Mutation caught: any change to the per-series value lerp, the series
    // alpha ramp, the union range scan, the scratch-pool keying, or the
    // stash revision gate.
    expect(multiSnapshot(s)).toEqual({
      displayMin: 98.86,
      displayMax: 125.96,
      displayWindow: 600,
      rangeInited: true,
      chartReveal: 1,
      pauseProgress: 0,
      timeDebt: 0,
      loadingAlpha: 0,
      scrubAmount: 0,
      frozenNowOffset: 0.064,
      targetMin: 98.86,
      targetMax: 125.96,
      displayValues: { a: 100, b: 110 },
      seriesAlpha: { a: 1, b: 1 },
      multiVisibleIds: ['a', 'b'],
      multiEntryIds: ['a', 'b'],
      seriesEntriesLen: 2,
      lastMultiSeriesLen: 2,
      stashDataIds: ['a', 'b'],
    });
  });

  it('reproduces the exact draw-call sequence for 2 frames', () => {
    const s = makeState();
    const cfg = multiCfg(['a', 'b'], { showGrid: true, showBadge: true });
    const md = multiPoints(['a', 'b']);
    frame(s, cfg, { multiData: md });
    frame(s, cfg, { multiData: md });

    // No drawBadge at all: multi-series has no single value to badge. A
    // refactor that shares one badge call across pipelines would fail here.
    expect(callSequence()).toEqual([
      'updateGridLayer',
      'drawMultiFrame',
      'updateGridLayer',
      'drawMultiFrame',
    ]);
    expect(drawBadge).not.toHaveBeenCalled();
    expect(drawFrame).not.toHaveBeenCalled();
  });

  it('never publishes a scroll layer', () => {
    const s = makeState();
    const out = frame(s, multiCfg(['a']), { multiData: multiPoints(['a']) });
    expect(out.scrollPicture).toBeNull();
    expect(out.scrollDx).toBe(0);
    expect(updateLineScrollLayer).not.toHaveBeenCalled();
  });

  it('pools one visible array and one entry object per series, forever', () => {
    // The scratch pools are keyed by series id and reused in place. Identity,
    // not contents — a refactor that reallocates per frame would regress the
    // allocation win the pools exist for and this catches it.
    const s = makeState();
    const cfg = multiCfg(['a', 'b']);
    const md = multiPoints(['a', 'b']);
    frame(s, cfg, { multiData: md });
    const visA = s.multiVisibleScratch.get('a');
    const entryA = s.multiSeriesEntryScratch.get('a');
    frame(s, cfg, { multiData: md });
    expect(s.multiVisibleScratch.get('a')).toBe(visA);
    expect(s.multiSeriesEntryScratch.get('a')).toBe(entryA);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Mode-transition matrix
// ═════════════════════════════════════════════════════════════════════════

/**
 * The six transitions between the three pipelines. For each: run the outgoing
 * pipeline to a settled state, switch, and assert both that the incoming
 * pipeline produced correct output AND what the outgoing pipeline left behind.
 *
 * These deliberately pin the *current* behaviour including its leaks — the
 * point of a characterization test is that the refactor reproduces today's
 * engine exactly, whatever today's engine does. Where a leak is pinned it is
 * called out in a comment so the refactor can decide to fix it on purpose
 * rather than by accident.
 */
describe('mode transitions', () => {
  /** Enough frames for every lerp in the pipeline to hit its snap threshold,
   * so the "before" state of each transition is an exact, readable number
   * rather than a point on a curve. */
  const SETTLE = 200;
  const settleLine = (s: EngineState, frames = SETTLE) => {
    const cfg = lineCfg({ value: 120 });
    const data = linePoints();
    for (let i = 0; i < frames; i++) frame(s, cfg, { data });
  };
  const settleCandle = (s: EngineState, frames = SETTLE) => {
    const cfg = candleCfg();
    const candles = closedCandles();
    for (let i = 0; i < frames; i++) frame(s, cfg, { candles });
  };
  const settleMulti = (s: EngineState, frames = SETTLE) => {
    const cfg = multiCfg(['a', 'b']);
    const md = multiPoints(['a', 'b']);
    for (let i = 0; i < frames; i++) frame(s, cfg, { multiData: md });
  };

  it('line → candle: candle pipeline runs, line pipeline stops', () => {
    const s = makeState();
    settleLine(s);
    expect(s.displayMax).toBe(122.4);
    jest.clearAllMocks();

    frame(s, candleCfg(), { candles: closedCandles() });

    expect(callSequence()).toEqual(['drawCandleFrame']);
    expect(drawFrame).not.toHaveBeenCalled();
    // Candle state is now live.
    expect(s.displayCandle).not.toBeNull();
    expect(s.lastCandles.length).toBe(6);
    expect(s.prevCandleDataRev).toBe(1);
  });

  it('line → candle: the range is NOT re-snapped, it lerps from the line range', () => {
    // `rangeInited` is one shared flag across all three pipelines, so the
    // candle pipeline inherits the line's displayMin/displayMax and lerps
    // away from them instead of snapping to the candle range on frame 1.
    // This is the single clearest instance of the shared-state coupling the
    // refactor has to preserve (or deliberately change).
    const s = makeState();
    settleLine(s);
    expect(s.rangeInited).toBe(true);
    // The settled single-series range (padded by computeRange).
    expect(s.displayMin).toBe(97.6);
    expect(s.displayMax).toBe(122.4);

    frame(s, candleCfg(), { candles: closedCandles() });

    // The candle range settles at 97.92..109.08 (asserted directly in the
    // candle→multi test below). A fresh `rangeInited === false` would snap
    // straight there on this first frame; instead the range is still most of
    // the way back at the line's, one lerp step in.
    expect(s.displayMax).not.toBe(109.08);
    expect(s.displayMax).toBeLessThan(122.4);
    expect(s.displayMax).toBeGreaterThan(109.08);
  });

  it('line → candle: the line stash and displayValue survive the switch', () => {
    // Nothing prunes single-series state on the way out — pinning it so the
    // refactor cannot silently start (or stop) clearing it.
    const s = makeState();
    settleLine(s);
    expect(s.lastData.length).toBe(20);
    expect(s.displayValue).toBe(120);

    frame(s, candleCfg(), { candles: closedCandles() });

    expect(s.lastData.length).toBe(20);
    expect(s.lastDataStashRev).toBe(1);
    expect(s.displayValue).toBe(120);
  });

  it('candle → line: line pipeline runs, candle per-candle state persists', () => {
    const s = makeState();
    settleCandle(s);
    const displayCandle = s.displayCandle;
    expect(displayCandle).not.toBeNull();
    jest.clearAllMocks();

    frame(s, lineCfg({ value: 120 }), { data: linePoints() });

    expect(callSequence()).toEqual(['drawFrame', 'drawBadge']);
    expect(drawCandleFrame).not.toHaveBeenCalled();
    // Candle state is frozen, not cleared: the candle pipeline is the only
    // thing that writes it and it is no longer running.
    expect(s.displayCandle).toBe(displayCandle);
    expect(s.lastCandles.length).toBe(6);
    expect(s.lastLive).not.toBeNull();
    expect(s.lineSmoothInited).toBe(true);
    expect(s.closeLineSmoothInited).toBe(true);
    expect(s.prevCandleData.width).toBe(60);
  });

  it('candle → line: lineModeProg freezes rather than continuing to advance', () => {
    // The lineModeProg block is inside `if (isCandle)`, above the early
    // return. In line mode it does not run at all, so the morph freezes
    // wherever it was. A refactor that lifts that block out of the isCandle
    // guard would break this.
    const s = makeState();
    const candles = closedCandles();
    const cfg = candleCfg({ lineMode: true });
    frame(s, cfg, { candles });
    clockMs += 200;
    frame(s, cfg, { candles });
    const mid = s.lineModeProg;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);

    clockMs += 1000;
    frame(s, lineCfg({ value: 120 }), { data: linePoints() });
    expect(s.lineModeProg).toBe(mid);
  });

  it('line → multi: multi state is seeded fresh, line state persists', () => {
    const s = makeState();
    settleLine(s);
    expect(perSeriesSizes(s)).toEqual({
      displayValues: 0,
      seriesAlpha: 0,
      multiVisibleScratch: 0,
      multiSeriesEntryScratch: 0,
      lineCaches: 0,
    });
    jest.clearAllMocks();

    frame(s, multiCfg(['a', 'b']), { multiData: multiPoints(['a', 'b']) });

    expect(callSequence()).toEqual(['drawMultiFrame']);
    // Seeded from cfg on the first multi frame, not from the line pipeline.
    expect([...s.displayValues.keys()].sort()).toEqual(['a', 'b']);
    expect(s.seriesAlpha.get('a')).toBe(1);
    expect(s.seriesAlpha.get('b')).toBe(1);
    // The single-series stash is untouched by the multi pipeline.
    expect(s.lastData.length).toBe(20);
    expect(s.displayValue).toBe(120);
  });

  it('multi → line: every per-series map is emptied on the first line frame', () => {
    const s = makeState();
    settleMulti(s);
    expect(perSeriesSizes(s)).toEqual({
      displayValues: 2,
      seriesAlpha: 2,
      multiVisibleScratch: 2,
      multiSeriesEntryScratch: 2,
      lineCaches: 0,
    });
    jest.clearAllMocks();

    frame(s, lineCfg({ value: 120 }), { data: linePoints() });

    // Mutation caught: dropping any map from `perSeriesMaps`, or moving the
    // `!inMultiPipeline` prune below the loading/empty early return.
    expect(perSeriesSizes(s)).toEqual({
      displayValues: 0,
      seriesAlpha: 0,
      multiVisibleScratch: 0,
      multiSeriesEntryScratch: 0,
      lineCaches: 0,
    });
    expect(callSequence()).toEqual(['drawFrame', 'drawBadge']);
  });

  it('multi → line: the reverse-morph stash is cleared but its rev cache is not', () => {
    // `lastMultiSeries` is emptied by the `hasData && !isMultiSeries` clear;
    // `lastMultiStashData`/`lastMultiStashRevs` are deliberately excluded
    // from `perSeriesMaps` and nothing else touches them, so they survive.
    // Pinned because it is exactly the kind of asymmetry an extraction can
    // accidentally "tidy up".
    const s = makeState();
    settleMulti(s);
    expect(s.lastMultiSeries.length).toBe(2);
    expect([...s.lastMultiStashData.keys()].sort()).toEqual(['a', 'b']);

    frame(s, lineCfg({ value: 120 }), { data: linePoints() });

    expect(s.lastMultiSeries).toEqual([]);
    expect([...s.lastMultiStashData.keys()].sort()).toEqual(['a', 'b']);
    expect([...s.lastMultiStashRevs.keys()].sort()).toEqual(['a', 'b']);
  });

  it('candle → multi: multi runs, candle state persists, no candle draw', () => {
    const s = makeState();
    settleCandle(s);
    const lastCandles = s.lastCandles;
    jest.clearAllMocks();

    frame(s, multiCfg(['a', 'b']), { multiData: multiPoints(['a', 'b']) });

    expect(callSequence()).toEqual(['drawMultiFrame']);
    expect(s.displayValues.size).toBe(2);
    expect(s.lastCandles).toBe(lastCandles);
    expect(s.displayCandle).not.toBeNull();
  });

  it('candle → multi: the multi range lerps from the candle range, not a snap', () => {
    // Same shared `rangeInited` coupling as line → candle, in the other
    // direction and through the *other* range updater (`updateRange` rather
    // than `updateCandleRange`) — both read the one flag.
    const s = makeState();
    settleCandle(s);
    expect(s.displayMin).toBe(97.92);
    expect(s.displayMax).toBe(109.08);

    frame(s, multiCfg(['a', 'b']), { multiData: multiPoints(['a', 'b']) });

    // The multi range settles at 98.86..125.96 (asserted directly in the
    // multi golden above). A snap would land exactly there on this frame.
    expect(s.displayMax).not.toBe(125.96);
    expect(s.displayMax).toBeGreaterThan(109.08);
    expect(s.displayMax).toBeLessThan(125.96);
  });

  it('multi → candle: per-series maps are pruned even with isMultiSeries still set', () => {
    const s = makeState();
    settleMulti(s);
    expect(perSeriesSizes(s).displayValues).toBe(2);
    jest.clearAllMocks();

    // `isMultiSeries`/`multiSeries` deliberately left set — `mode: 'candle'`
    // alone takes the chart out of the multi pipeline, and the prune's
    // `!isCandle` term is what makes that work.
    frame(
      s,
      candleCfg({
        isMultiSeries: true,
        multiSeries: [{ id: 'a', value: 100, palette: PALETTE }],
      }),
      { candles: closedCandles() }
    );

    expect(perSeriesSizes(s)).toEqual({
      displayValues: 0,
      seriesAlpha: 0,
      multiVisibleScratch: 0,
      multiSeriesEntryScratch: 0,
      lineCaches: 0,
    });
    expect(callSequence()).toEqual(['drawCandleFrame']);
  });

  it('multi → candle: lastMultiSeries survives (only single-series data clears it)', () => {
    // The `hasData && !cfg.isMultiSeries` clear lives in the non-candle
    // branch of the stash block, so it never runs in candle mode.
    const s = makeState();
    settleMulti(s);
    expect(s.lastMultiSeries.length).toBe(2);

    frame(s, candleCfg(), { candles: closedCandles() });

    expect(s.lastMultiSeries.length).toBe(2);
  });

  it('round trip line → multi → line leaves no per-series residue', () => {
    // The accumulation case PLAN_MAINT #3 is about: a chart that oscillates
    // between modes must not grow its per-series maps.
    const s = makeState();
    settleLine(s);
    settleMulti(s);
    settleLine(s);
    expect(perSeriesSizes(s)).toEqual({
      displayValues: 0,
      seriesAlpha: 0,
      multiVisibleScratch: 0,
      multiSeriesEntryScratch: 0,
      lineCaches: 0,
    });

    // ...and a different series set on the way back in does not resurrect
    // the old ids.
    frame(s, multiCfg(['c']), { multiData: multiPoints(['c']) });
    expect([...s.displayValues.keys()]).toEqual(['c']);
    expect([...s.seriesAlpha.keys()]).toEqual(['c']);
  });

  it("every transition publishes the incoming pipeline's own readout", () => {
    // `valueText: null` means "leave unchanged" to the caller, so each
    // pipeline must write its own on a mode switch or the readout freezes on
    // the previous mode's number. One assertion per direction.
    const s = makeState();
    const data = linePoints();
    const md = multiPoints(['a', 'b']);
    const candles = closedCandles();
    const V = { showValue: true };

    let line = frame(s, lineCfg({ ...V, value: 120 }), { data });
    for (let i = 0; i < 40; i++) {
      line = frame(s, lineCfg({ ...V, value: 120 }), { data });
    }
    expect(line.valueText).toBe('120.00');

    const candle = frame(s, candleCfg(V), { candles });
    expect(candle.valueText).toBe('106.00');

    const multi = frame(s, multiCfg(['a', 'b'], V), { multiData: md });
    expect(multi.valueText).toBe('');

    const backToLine = frame(s, lineCfg({ ...V, value: 120 }), { data });
    expect(backToLine.valueText).toBe('120.00');

    const backToCandle = frame(s, candleCfg(V), { candles });
    expect(backToCandle.valueText).toBe('106.00');

    const multiFromCandle = frame(s, multiCfg(['a', 'b'], V), {
      multiData: md,
    });
    expect(multiFromCandle.valueText).toBe('');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. Ordering invariants
// ═════════════════════════════════════════════════════════════════════════

/**
 * Prime the single-series line-path cache the way the real `drawFrame` would,
 * so the scroll-layer gate can actually fire under the mocked draw layer.
 * Reads only `layout` (arg 1) and the two options-object fields the gate's
 * key is built from — no positional tuple is assumed beyond `ctx, layout`,
 * which is not being changed.
 */
const FAKE_PREFIX = { fake: 'prefix' };
const FAKE_PICTURE = { fake: 'picture' };

function primeLineCache(s: EngineState) {
  (drawFrame as unknown as jest.Mock).mockImplementation(
    (
      _ctx: unknown,
      layout: ChartLayout,
      _palette: unknown,
      opts: {
        visible: LivelinePoint[];
        lineCache: { dataRev: number; dataSource: number };
      }
    ) => {
      const slot = s.lineCache;
      const vis = opts.visible;
      slot.prefix = FAKE_PREFIX as never;
      slot.kDataRev = opts.lineCache.dataRev;
      slot.kDataSource = opts.lineCache.dataSource;
      slot.kLen = vis.length;
      slot.kFirstT = vis[0]!.time;
      slot.kLastT = vis[vis.length - 1]!.time;
      slot.kLastV = vis[vis.length - 1]!.value;
      writeLayoutKey(slot.layoutKey, layout);
    }
  );
  (updateLineScrollLayer as unknown as jest.Mock).mockImplementation(() => {
    s.lineScroll.picture = FAKE_PICTURE as never;
  });
}

describe('ordering invariants (single-series scroll-layer gate)', () => {
  const scrollCfg = (over: Partial<EngineConfigStep> = {}) =>
    lineCfg({ scrub: true, value: 120, noMotion: true, ...over });

  it('composites the scroll layer once the line cache is warm', () => {
    // Baseline for the two ordering tests below: without this passing, their
    // "not called" assertions would be vacuous.
    const s = makeState();
    primeLineCache(s);
    const data = linePoints();
    const cfg = scrollCfg();

    const first = frame(s, cfg, { data });
    expect(updateLineScrollLayer).not.toHaveBeenCalled();
    expect(first.scrollPicture).toBeNull();

    const second = frame(s, cfg, { data });
    expect(updateLineScrollLayer).toHaveBeenCalledTimes(1);
    expect(second.scrollPicture).toBe(FAKE_PICTURE);
    expect(typeof second.scrollDx).toBe('number');
  });

  it("runs the gate AFTER updateHoverState — it reads this frame's settled scrubAmount", () => {
    // Mutation caught: moving the `canCompositeLineScroll` block above the
    // `updateHoverState` call. It would then read the *previous* frame's
    // scrubAmount (0 here) and composite a layer on a frame where the scrub
    // draws the line twice under two clips — a visible tear.
    const s = makeState();
    primeLineCache(s);
    const data = linePoints();
    const cfg = scrollCfg();

    frame(s, cfg, { data });
    frame(s, cfg, { data });
    expect(updateLineScrollLayer).toHaveBeenCalledTimes(1);
    expect(s.scrubAmount).toBe(0);

    // Hover starts THIS frame. Pre-frame scrubAmount is 0; updateHoverState
    // settles it to 1 (noMotion). The gate must see the 1.
    const hovered = frame(s, cfg, { data, hoverX: 200 });
    expect(s.scrubAmount).toBe(1);
    expect(updateLineScrollLayer).toHaveBeenCalledTimes(1);
    expect(hovered.scrollPicture).toBeNull();
    expect(hovered.scrollDx).toBe(0);
  });

  it('runs the gate BEFORE drawFrame — it reads the pre-decay shake amplitude', () => {
    // `drawFrame` zeroes `shakeState.amplitude` below its own threshold, so
    // the gate reading it *after* the draw would see 0 on a frame that is in
    // fact translated, and composite a scroll layer that tears away from the
    // rest of the chart. The mocked drawFrame stands in for that decay.
    const s = makeState();
    primeLineCache(s);
    const decaying = (
      drawFrame as unknown as jest.Mock
    ).getMockImplementation()!;
    (drawFrame as unknown as jest.Mock).mockImplementation(
      (...args: never[]) => {
        decaying(...args);
        s.shakeState.amplitude = 0;
      }
    );

    const data = linePoints();
    const cfg = scrollCfg({
      degenOptions: { enabled: true } as unknown as DegenOptions,
    });

    frame(s, cfg, { data });
    const control = frame(s, cfg, { data });
    expect(control.scrollPicture).toBe(FAKE_PICTURE);
    expect(updateLineScrollLayer).toHaveBeenCalledTimes(1);

    // A shaking frame: amplitude is non-zero going in, zeroed by drawFrame.
    s.shakeState.amplitude = 5;
    const shaking = frame(s, cfg, { data });
    expect(s.shakeState.amplitude).toBe(0);
    expect(updateLineScrollLayer).toHaveBeenCalledTimes(1);
    expect(shaking.scrollPicture).toBeNull();
  });

  it('ignores the shake amplitude entirely when degenOptions is off', () => {
    // The gate passes `cfg.degenOptions ? amplitude : 0` — a stale amplitude
    // from a chart that used to have degen mode on must not permanently
    // disable the scroll layer.
    const s = makeState({ shakeState: { amplitude: 5, angle: 0 } as never });
    primeLineCache(s);
    const data = linePoints();
    const cfg = scrollCfg();

    frame(s, cfg, { data });
    const out = frame(s, cfg, { data });
    expect(out.scrollPicture).toBe(FAKE_PICTURE);
  });
});

describe('ordering invariants (grid layer)', () => {
  /** The `dt` argument index in `updateGridLayer(slot, state, layout,
   * palette, formatValue, dt, cache, fonts)`. Asserted by index rather than
   * by tuple so a signature change elsewhere in the call does not break it. */
  const DT_ARG = 5;

  const pausedState = () => makeState({ pauseProgress: 1, timeDebt: 0 });

  it('hands the grid layer pausedDt, not raw dt, in every pipeline', () => {
    // Mutation caught: replacing `pausedDt` with `dt` at any of the three
    // updateGridLayer call sites. `gridState`'s label crossfades must freeze
    // with the pause, and two of the three sites got this wrong historically.
    const cases: [string, () => void][] = [
      [
        'line',
        () => {
          const s = pausedState();
          frame(s, lineCfg({ showGrid: true, paused: true, value: 120 }), {
            data: linePoints(),
          });
        },
      ],
      [
        'candle',
        () => {
          const s = pausedState();
          frame(s, candleCfg({ showGrid: true, paused: true }), {
            candles: closedCandles(),
          });
        },
      ],
      [
        'multi',
        () => {
          const s = pausedState();
          frame(s, multiCfg(['a', 'b'], { showGrid: true, paused: true }), {
            multiData: multiPoints(['a', 'b']),
          });
        },
      ],
    ];

    for (const [name, run] of cases) {
      jest.clearAllMocks();
      run();
      const mock = updateGridLayer as unknown as jest.Mock;
      expect(mock).toHaveBeenCalledTimes(1);
      // pauseProgress is pinned at 1, so pausedDt === 0 while dt === 16.
      expect([name, mock.mock.calls[0]![DT_ARG]]).toEqual([name, 0]);
    }
  });

  it('skips the grid picture cache entirely while the reveal morph runs', () => {
    // `chartReveal >= 1` gates all three call sites — ctx.drawPicture ignores
    // globalAlpha, so a cached picture would snap to full opacity mid-fade.
    const s = makeState({ chartReveal: 0.5 });
    frame(s, lineCfg({ showGrid: true, value: 120 }), { data: linePoints() });
    expect(updateGridLayer).not.toHaveBeenCalled();
    expect(drawFrame).toHaveBeenCalledTimes(1);
  });

  it('runs the grid layer before the frame draw in all three pipelines', () => {
    // Note the line pipeline's trailing `drawBadge`: it is called
    // unconditionally there (the badge decides its own visibility inside),
    // unlike candle mode, which gates the call on `lineModeProg > 0.5`.
    const cases: [string, () => void, string[]][] = [
      [
        'line',
        () => {
          const s = makeState();
          frame(s, lineCfg({ showGrid: true, value: 120 }), {
            data: linePoints(),
          });
        },
        ['updateGridLayer', 'drawFrame', 'drawBadge'],
      ],
      [
        'candle',
        () => {
          const s = makeState();
          frame(s, candleCfg({ showGrid: true }), { candles: closedCandles() });
        },
        ['updateGridLayer', 'drawCandleFrame'],
      ],
      [
        'multi',
        () => {
          const s = makeState();
          frame(s, multiCfg(['a', 'b'], { showGrid: true }), {
            multiData: multiPoints(['a', 'b']),
          });
        },
        ['updateGridLayer', 'drawMultiFrame'],
      ],
    ];
    for (const [name, run, expected] of cases) {
      jest.clearAllMocks();
      run();
      expect([name, callSequence()]).toEqual([name, expected]);
    }
  });
});

describe('per-pipeline window buffer', () => {
  /**
   * The right-edge buffer (how much empty room the chart leaves past `now`,
   * as a fraction of the window) is chosen independently by each of the three
   * pipelines and lands nowhere on `EngineState` — the only observable is the
   * `layout` handed to the draw call. So this reads ONE thing off ONE
   * argument: `layout.rightEdge`, at the argument index the layout has always
   * occupied (`ctx, layout, …`). Nothing about the options object is touched.
   *
   * `s.frozenNow` is exactly the `now` the layout was built from on a
   * non-stash frame, so `rightEdge - frozenNow` recovers `windowSecs *
   * buffer` without the test needing its own clock arithmetic.
   */
  const bufferOf = (mock: unknown, s: EngineState) => {
    const calls = (mock as jest.Mock).mock.calls;
    const layout = calls[calls.length - 1]![1] as ChartLayout;
    return r((layout.rightEdge - s.frozenNow) / WINDOW);
  };

  it('single-series line: 0.05 with a badge, 0.015 without', () => {
    // Mutation caught: swapping WINDOW_BUFFER / WINDOW_BUFFER_NO_BADGE in the
    // line pipeline. Nothing in EngineState moves when that happens.
    const data = linePoints();
    const withBadge = makeState();
    frame(withBadge, lineCfg({ showBadge: true }), { data });
    expect(bufferOf(drawFrame, withBadge)).toBe(0.05);

    const without = makeState();
    frame(without, lineCfg({ showBadge: false }), { data });
    expect(bufferOf(drawFrame, without)).toBe(0.015);
  });

  it('single-series line: widens to fit momentum arrows next to the badge', () => {
    // `max(baseBuffer, 37 / chartW)` — chartW is 370 here, so 0.1 wins.
    const s = makeState();
    frame(s, lineCfg({ showBadge: true, showMomentum: true }), {
      data: linePoints(),
    });
    expect(bufferOf(drawFrame, s)).toBe(0.1);
  });

  it('multi-series: same badge-driven choice as single-series', () => {
    const md = multiPoints(['a', 'b']);
    const withBadge = makeState();
    frame(withBadge, multiCfg(['a', 'b'], { showBadge: true }), {
      multiData: md,
    });
    expect(bufferOf(drawMultiFrame, withBadge)).toBe(0.05);

    const without = makeState();
    frame(without, multiCfg(['a', 'b'], { showBadge: false }), {
      multiData: md,
    });
    expect(bufferOf(drawMultiFrame, without)).toBe(0.015);

    // ...but NOT the momentum-arrow widening, which is single-series only.
    const arrows = makeState();
    frame(
      arrows,
      multiCfg(['a', 'b'], { showBadge: true, showMomentum: true }),
      { multiData: md }
    );
    expect(bufferOf(drawMultiFrame, arrows)).toBe(0.05);
  });

  it('candle: always the no-badge buffer, even with showBadge on', () => {
    // The badge is only ever visible during the line morph, so the candle
    // pipeline hard-codes CANDLE_BUFFER_NO_BADGE rather than reading
    // cfg.showBadge at all.
    const candles = closedCandles();
    const withBadge = makeState();
    frame(withBadge, candleCfg({ showBadge: true }), { candles });
    expect(bufferOf(drawCandleFrame, withBadge)).toBe(0.015);

    const without = makeState();
    frame(without, candleCfg({ showBadge: false }), { candles });
    expect(bufferOf(drawCandleFrame, without)).toBe(0.015);
  });
});

describe('ordering invariants (per-pipeline dt contract)', () => {
  /** Read one property off the options object rather than the whole tuple —
   * the tuple is being reshaped, this property is not. */
  const optsDt = (mock: unknown) => {
    const calls = (mock as jest.Mock).mock.calls;
    const last = calls[calls.length - 1]!;
    return (last[last.length - 1] as { dt: number }).dt;
  };

  it('line and candle draw with pausedDt; multi draws with raw dt', () => {
    // A real asymmetry in today's engine, not an accident of these tests:
    // drawFrame and drawCandleFrame are handed `pausedDt` (their orderbook /
    // grid sub-drawers must freeze with the pause) while drawMultiFrame gets
    // raw `dt`. Pinned so an extraction that unifies the three call sites has
    // to change this test on purpose.
    const data = linePoints();
    const candles = closedCandles();
    const md = multiPoints(['a', 'b']);

    const sLine = makeState({ pauseProgress: 1 });
    frame(sLine, lineCfg({ paused: true, value: 120 }), { data });
    expect(optsDt(drawFrame)).toBe(0);

    const sCandle = makeState({ pauseProgress: 1 });
    frame(sCandle, candleCfg({ paused: true }), { candles });
    expect(optsDt(drawCandleFrame)).toBe(0);

    const sMulti = makeState({ pauseProgress: 1 });
    frame(sMulti, multiCfg(['a', 'b'], { paused: true }), { multiData: md });
    expect(optsDt(drawMultiFrame)).toBe(DT);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. Shared early-return surface
// ═════════════════════════════════════════════════════════════════════════

describe('early returns', () => {
  it('the no-data return draws empty + edge fade and nothing else, in order', () => {
    const s = makeState({ chartReveal: 0 });
    const out = frame(s, lineCfg({ showGrid: true, showBadge: true }));

    expect(callSequence()).toEqual(['drawEmpty', 'drawEdgeFade']);
    expect(out.scrollPicture).toBeNull();
    // The prune runs ABOVE this return on purpose (so "multiSeries went
    // empty" is covered); nothing else does.
    expect(updateGridLayer).not.toHaveBeenCalled();
  });

  it('the multi "no visible series" return draws empty + edge fade, in order', () => {
    const s = makeState();
    const out = frame(s, multiCfg(['a'], { showValue: true }), {
      multiData: { a: [] },
    });
    expect(callSequence()).toEqual(['drawEmpty', 'drawEdgeFade']);
    expect(out.valueText).toBe('');
    expect(drawMultiFrame).not.toHaveBeenCalled();
  });

  it('the single-series "no points in window" return draws empty + edge fade', () => {
    const s = makeState();
    const out = frame(s, lineCfg({ showValue: true, showGrid: true }), {
      data: linePoints(20, 10, 100_000),
    });
    expect(callSequence()).toEqual(['drawEmpty', 'drawEdgeFade']);
    expect(out.valueText).toBe('');
    expect(drawFrame).not.toHaveBeenCalled();
  });

  it('crossfades loading over empty rather than picking one', () => {
    // Both are drawn while loadingAlpha sits between the two thresholds, and
    // loading is drawn first (it composites under the empty text).
    const s = makeState({ loadingAlpha: 0.5, chartReveal: 0 });
    frame(s, lineCfg({ loading: true }));
    expect(callSequence()).toEqual([
      'drawLoading',
      'drawEmpty',
      'drawEdgeFade',
    ]);
  });
});
