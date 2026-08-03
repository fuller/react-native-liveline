/**
 * Behavioural tests for `engineStep`.
 *
 * The whole drawing layer is mocked out (`jest.mock` on the modules
 * `step.ts` calls into), so these exercise the engine's *decisions* — which
 * draw calls happen, what lands in `StepOutput`, and how `EngineState`
 * evolves — without needing a Skia binding. Anything that actually needs
 * Skia geometry stays covered by the per-module tests in `src/draw`.
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
} from '../../types';
import type { Ctx2D } from '../../draw/canvas2d';
import type { EngineConfigStep } from '../types';
import { createEngineState, type EngineState } from '../state';
import { engineStep } from '../step';
import {
  drawFrame,
  drawMultiFrame,
  drawCandleFrame,
  drawEdgeFade,
} from '../../draw';
import { drawEmpty } from '../../draw/empty';
import { drawLoading } from '../../draw/loading';

const W = 400;
const H = 200;
const PAD = { top: 10, right: 20, bottom: 20, left: 10 };

const PALETTE: LivelinePalette = {
  line: '#3b82f6',
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

const FONTS = {} as unknown as LivelineFonts;

/** Minimal stand-in for the Skia-backed drawing context. `engineStep`
 * itself only ever touches `ctx.font` / `ctx.fonts` / `ctx.measureText`
 * (the multi-series label-reserve measurement); everything else goes
 * through the mocked draw functions. */
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
    windowSecs: 60,
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
    noMotion: true,
    mode: 'line',
    dataRev: 1,
    candlesRev: 1,
    ...over,
  } as EngineConfigStep;
}

function makeState(over: Partial<EngineState> = {}): EngineState {
  const s = createEngineState(100, 60, false, 60);
  // Skip the reveal ramp — every test here is about steady state.
  s.chartReveal = 1;
  Object.assign(s, over);
  return s;
}

function run(
  s: EngineState,
  cfg: EngineConfigStep,
  data: LivelinePoint[] = [],
  candles: CandlePoint[] = [],
  multiData: Record<string, LivelinePoint[]> = {}
) {
  const frame = s.frameInputs;
  frame.w = W;
  frame.h = H;
  frame.hoverPixelX = null;
  frame.dt = 16;
  frame.now_ms = 1000;
  frame.fonts = FONTS;
  frame.data = data;
  frame.candles = candles;
  frame.multiData = multiData;
  return engineStep(makeCtx(), cfg, s, frame);
}

/** Points spanning `[now - ageSecs - span, now - ageSecs]`. */
function pointsEnding(ageSecs: number, span = 10, n = 20): LivelinePoint[] {
  const now = Date.now() / 1000;
  const out: LivelinePoint[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      time: now - ageSecs - span + (i / (n - 1)) * span,
      value: 100 + i,
    });
  }
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('single-series: no points inside the window', () => {
  it('draws the empty state + edge fade instead of nothing at all', () => {
    // Every point is far older than leftEdge (a stalled feed / return from
    // background), so `visible` comes back empty even though hasData is true.
    const s = makeState();
    const out = run(s, makeCfg(), pointsEnding(10_000));

    expect(drawFrame).not.toHaveBeenCalled();
    expect(drawEmpty).toHaveBeenCalledTimes(1);
    expect(drawEdgeFade).toHaveBeenCalledTimes(1);
    expect(out.scrollPicture).toBeNull();
  });

  it('draws the loading state instead when loadingAlpha is high', () => {
    const s = makeState({ loadingAlpha: 1 });
    run(s, makeCfg({ loading: true }), pointsEnding(10_000));

    expect(drawLoading).toHaveBeenCalledTimes(1);
    expect(drawEmpty).not.toHaveBeenCalled();
    expect(drawEdgeFade).toHaveBeenCalledTimes(1);
  });

  it('still draws the chart normally when points are inside the window', () => {
    const s = makeState();
    run(s, makeCfg(), pointsEnding(1));

    expect(drawFrame).toHaveBeenCalledTimes(1);
    expect(drawEmpty).not.toHaveBeenCalled();
  });
});

describe('live value readout', () => {
  it('single-series line mode publishes the formatted value', () => {
    const s = makeState();
    const out = run(s, makeCfg({ showValue: true }), pointsEnding(1));
    expect(out.valueText).toBe('100.00');
  });

  it('multi-series publishes an explicit blank, not a stale null', () => {
    const s = makeState();
    const out = run(
      s,
      makeCfg({
        showValue: true,
        isMultiSeries: true,
        multiSeries: [{ id: 'a', value: 100, palette: PALETTE }],
        multiRevs: { a: 1 },
      }),
      [],
      [],
      { a: pointsEnding(1) }
    );
    expect(drawMultiFrame).toHaveBeenCalledTimes(1);
    // null would mean "leave unchanged" to useLivelineEngine, freezing
    // whatever the line pipeline last wrote before the mode switch.
    expect(out.valueText).toBe('');
  });

  // The three early returns that draw the empty/loading state and bail used to
  // skip the readout publish entirely, so `null` reached the caller and it kept
  // showing whatever the PREVIOUS mode last wrote — the exact bug the candle and
  // multi publishes above were added to fix, still live on the paths where no
  // chart is drawn at all. Found by an independent review AFTER those two
  // landed, which is why each of the three gets its own test here.

  it('publishes a blank when single-series has no points in the window', () => {
    const s = makeState();
    const out = run(
      s,
      makeCfg({ showValue: true }),
      // Points far in the past: real data, but nothing inside the window.
      pointsEnding(1).map((p) => ({ ...p, time: p.time - 100000 })),
      []
    );
    expect(out.valueText).toBe('');
  });

  it('publishes a blank when multi-series has no visible series', () => {
    const s = makeState();
    const out = run(
      s,
      makeCfg({
        showValue: true,
        isMultiSeries: true,
        multiSeries: [{ id: 'a', value: 100, palette: PALETTE }],
        multiRevs: { a: 1 },
      }),
      [],
      [],
      { a: [] }
    );
    expect(out.valueText).toBe('');
  });

  it('leaves the readout alone when the consumer never asked for it', () => {
    // showValue false must publish NOTHING — null keeps the caller from
    // touching a shared value it does not own, and costs nothing per frame.
    const s = makeState();
    const out = run(s, makeCfg({ showValue: false }), [], []);
    expect(out.valueText).toBeNull();
  });

  it('candle mode publishes its own value rather than leaving it stale', () => {
    const now = Date.now() / 1000;
    const candles: CandlePoint[] = [
      { time: now - 120, open: 10, high: 12, low: 9, close: 11 },
      { time: now - 60, open: 11, high: 13, low: 10, close: 12 },
    ];
    const s = makeState();
    const out = run(
      s,
      makeCfg({
        mode: 'candle',
        showValue: true,
        candleWidth: 60,
        windowSecs: 600,
      }),
      [],
      candles
    );
    expect(drawCandleFrame).toHaveBeenCalledTimes(1);
    expect(out.valueText).not.toBeNull();
    expect(out.valueText).toBe('12.00');
  });
});

describe('multi-series per-series bookkeeping', () => {
  const multiCfg = (ids: string[], hidden?: string[]) => {
    const revs: Record<string, number> = {};
    for (const id of ids) revs[id] = 1;
    return makeCfg({
      isMultiSeries: true,
      multiSeries: ids.map((id) => ({ id, value: 100, palette: PALETTE })),
      multiRevs: revs,
      hiddenSeriesIds: hidden,
      noMotion: false,
    });
  };

  const multiPoints = (ids: string[]) => {
    const out: Record<string, LivelinePoint[]> = {};
    for (const id of ids) out[id] = pointsEnding(1);
    return out;
  };

  it('seeds a series that is already hidden at alpha 0, not 1', () => {
    const s = makeState();
    run(s, multiCfg(['a', 'b'], ['b']), [], [], multiPoints(['a', 'b']));

    expect(s.seriesAlpha.get('a')).toBe(1);
    // Seeding at 1 made a newly-added hidden series flash in and briefly
    // widen the Y range before fading out.
    expect(s.seriesAlpha.get('b')).toBe(0);
  });

  it('still animates an existing series being hidden', () => {
    const s = makeState();
    run(s, multiCfg(['a']), [], [], multiPoints(['a']));
    expect(s.seriesAlpha.get('a')).toBe(1);

    run(s, multiCfg(['a'], ['a']), [], [], multiPoints(['a']));
    const mid = s.seriesAlpha.get('a')!;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('prunes every per-series map when the chart leaves multi mode', () => {
    const s = makeState();
    run(s, multiCfg(['a', 'b']), [], [], multiPoints(['a', 'b']));
    expect(s.displayValues.size).toBe(2);
    expect(s.seriesAlpha.size).toBe(2);
    expect(s.multiVisibleScratch.size).toBe(2);
    expect(s.multiSeriesEntryScratch.size).toBe(2);

    // Back to single-series: the multi pipeline stops running, so nothing
    // inside it can prune these ever again.
    run(s, makeCfg(), pointsEnding(1));

    expect(s.displayValues.size).toBe(0);
    expect(s.seriesAlpha.size).toBe(0);
    expect(s.multiVisibleScratch.size).toBe(0);
    expect(s.multiSeriesEntryScratch.size).toBe(0);
    expect(s.lineCaches.size).toBe(0);
  });

  it('prunes when the chart switches straight to candle mode', () => {
    const s = makeState();
    run(s, multiCfg(['a']), [], [], multiPoints(['a']));
    expect(s.displayValues.size).toBe(1);

    // isMultiSeries deliberately left set — mode alone took the chart out
    // of the multi pipeline.
    run(
      s,
      makeCfg({
        mode: 'candle',
        isMultiSeries: true,
        multiSeries: [{ id: 'a', value: 100, palette: PALETTE }],
      }),
      [],
      []
    );
    expect(s.displayValues.size).toBe(0);
    expect(s.seriesAlpha.size).toBe(0);
  });

  it('does not prune while still in multi mode', () => {
    const s = makeState();
    run(s, multiCfg(['a', 'b']), [], [], multiPoints(['a', 'b']));
    run(s, multiCfg(['a', 'b']), [], [], multiPoints(['a', 'b']));
    expect(s.displayValues.size).toBe(2);
  });
});

describe('candle mode', () => {
  const now = Date.now() / 1000;
  const closed: CandlePoint[] = [
    { time: now - 180, open: 10, high: 12, low: 9, close: 11 },
    { time: now - 120, open: 11, high: 13, low: 10, close: 12 },
  ];
  const candleCfg = (over: Partial<EngineConfigStep> = {}) =>
    makeCfg({
      mode: 'candle',
      candleWidth: 60,
      windowSecs: 600,
      noMotion: false,
      ...over,
    });

  it('only re-copies prevCandleData when candlesRev moves', () => {
    const s = makeState();
    run(s, candleCfg({ candlesRev: 1 }), [], closed);
    const first = s.prevCandleData.candles;
    expect(first).toHaveLength(2);

    run(s, candleCfg({ candlesRev: 1 }), [], closed);
    // Same revision — the (unread) copy must be skipped entirely.
    expect(s.prevCandleData.candles).toBe(first);

    run(s, candleCfg({ candlesRev: 2 }), [], closed);
    expect(s.prevCandleData.candles).not.toBe(first);
  });

  it('keeps prevCandleData.width tracking the previous frame width', () => {
    const s = makeState();
    run(s, candleCfg({ candlesRev: 1, candleWidth: 60 }), [], closed);
    expect(s.prevCandleData.width).toBe(60);

    // A width change with no data change must still see the *old* width as
    // `cwt.oldWidth` — that is what the morph interpolates away from.
    run(s, candleCfg({ candlesRev: 1, candleWidth: 30 }), [], closed);
    expect(s.candleWidthTrans.oldWidth).toBe(60);
    expect(s.prevCandleData.width).toBe(30);
  });

  it('freezes the live candle in the reverse-morph stash', () => {
    const s = makeState();
    const live = { time: now - 30, open: 12, high: 20, low: 5, close: 18 };
    // Two data frames: the first births the display candle at `open`, the
    // second lerps it partway toward `live` and stashes it.
    run(s, candleCfg({ liveCandle: live }), [], closed);
    run(s, candleCfg({ liveCandle: live }), [], closed);

    const stashed = s.lastLive!;
    expect(stashed).not.toBeNull();
    // The stash must own a copy, not the live (in-place lerped) candle.
    expect(stashed).not.toBe(s.displayCandle);
    expect(s.lastCandles[s.lastCandles.length - 1]).toBe(stashed);
    const snapshot = { ...stashed };
    expect(snapshot.close).not.toBe(live.close);

    // Data disappears → reverse morph. `s.displayCandle` keeps lerping
    // toward `live`; the stash the morph draws from must not move with it.
    run(s, candleCfg({ liveCandle: live }), [], []);
    run(s, candleCfg({ liveCandle: live }), [], []);
    expect(s.displayCandle!.close).not.toBe(snapshot.close);
    expect(s.lastLive!.close).toBe(snapshot.close);
    expect(s.lastLive!.high).toBe(snapshot.high);
    const lastStashed = s.lastCandles[s.lastCandles.length - 1]!;
    expect(lastStashed.close).toBe(snapshot.close);
  });
});
