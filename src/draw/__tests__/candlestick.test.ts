import { drawCandlesticks } from '../candlestick';
import type { Ctx2D, Style2D } from '../canvas2d';
import type { ChartLayout, CandlePoint, Padding } from '../../types';

// ── Fake Ctx2D recorder ──────────────────────────────────────────────────
// Covers exactly the methods drawCandlesticks calls. Records fill()/stroke()
// counts (not full path geometry) — the thing under test is the batching
// decision (how many native draw calls a set of candles produces), not
// pixel output, which is covered by the earlier session's Android
// verification for this exact code path.

interface Call {
  op: 'fill' | 'stroke';
  style: Style2D;
  alpha: number;
}

class FakeCtx implements Ctx2D {
  fillStyle: Style2D = '#000000';
  strokeStyle: Style2D = '#000000';
  lineWidth = 1;
  globalAlpha = 1;
  lineCap: Ctx2D['lineCap'] = 'butt';
  lineJoin: Ctx2D['lineJoin'] = 'miter';
  font = {} as Ctx2D['font'];
  textAlign: Ctx2D['textAlign'] = 'left';
  textBaseline: Ctx2D['textBaseline'] = 'alphabetic';
  globalCompositeOperation: Ctx2D['globalCompositeOperation'] = 'source-over';
  shadowColor: Ctx2D['shadowColor'] = 'rgba(0,0,0,0)';
  shadowBlur = 0;
  shadowOffsetY = 0;
  fonts = {} as Ctx2D['fonts'];

  calls: Call[] = [];
  private saved: number[] = [];

  save() {
    this.saved.push(this.globalAlpha);
  }
  restore() {
    const a = this.saved.pop();
    if (a !== undefined) this.globalAlpha = a;
  }
  beginPath() {}
  beginPathFrom() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  cubicTo() {}
  arc() {}
  arcTo() {}
  rect() {}
  fill() {
    this.calls.push({
      op: 'fill',
      style: this.fillStyle,
      alpha: this.globalAlpha,
    });
  }
  stroke() {
    this.calls.push({
      op: 'stroke',
      style: this.strokeStyle,
      alpha: this.globalAlpha,
    });
  }
  clip() {}
  fillRect() {}
  fillText() {}
  strokeText() {}
  measureText() {
    return { width: 0 };
  }
  setLineDash() {}
  createLinearGradient() {
    return {
      isGradient: true as const,
      x0: 0,
      y0: 0,
      x1: 0,
      y1: 0,
      offsets: [],
      colors: [],
      addColorStop() {},
    };
  }
  translate() {}
  drawPicture() {}
}

const PAD: Required<Padding> = { top: 10, right: 10, bottom: 10, left: 10 };

function makeLayout(w = 500, h = 200): ChartLayout {
  const chartW = w - PAD.left - PAD.right;
  const chartH = h - PAD.top - PAD.bottom;
  const leftEdge = 0;
  const rightEdge = 100; // 100s window
  const minVal = 0;
  const maxVal = 100;
  const valRange = 100;
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

/** Candle every 5s from t0, alternating bull/bear, well inside the layout's
 * visible window and wide enough (candleWidthSecs=4) to exercise the
 * rounded-corner path (bodyW > 6px). */
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

describe('drawCandlesticks batching', () => {
  it('batches a mixed bull/bear set into a handful of fill/stroke calls, not one per candle', () => {
    const ctx = new FakeCtx();
    const layout = makeLayout();
    const candles = makeCandles(12); // 6 bull, 6 bear, no live candle in the set
    drawCandlesticks(
      ctx,
      layout,
      candles,
      4,
      -1, // liveTime — no candle matches, so there's no "live" candle this frame
      0,
      0, // pauseProgress
      0,
      0 // scrubX=0, scrubDim=0 — no scrub, batching applies
    );

    const fills = ctx.calls.filter((c) => c.op === 'fill');
    const strokes = ctx.calls.filter((c) => c.op === 'stroke');
    // One fill + one stroke per color group (bull, bear) = at most 2 each.
    expect(fills.length).toBeLessThanOrEqual(2);
    expect(strokes.length).toBeLessThanOrEqual(2);
    // Far fewer than the up-to-3-per-candle the unbatched loop would emit.
    expect(fills.length + strokes.length).toBeLessThan(candles.length);
  });

  it('gives the live candle its own dedicated fill, separate from the batched groups', () => {
    const ctx = new FakeCtx();
    const layout = makeLayout();
    const candles = makeCandles(10);
    const liveTime = candles[candles.length - 1]!.time;
    // pauseProgress=1 suppresses the live-candle glow (tested separately
    // below) so the fill count here is exactly batched-groups + live-body.
    drawCandlesticks(ctx, layout, candles, 4, liveTime, 0, 1, 0, 0, 1, 0.5);

    const fills = ctx.calls.filter((c) => c.op === 'fill');
    // 9 non-live candles (5 bull, 4 bear) → 2 batched body fills, plus the
    // live candle's own body fill = 3. The live candle must not have been
    // swept into a batched group (that would undercount, not overcount).
    expect(fills.length).toBe(3);
  });

  it('the live candle glow adds one more fill when unpaused, none when paused', () => {
    const layout = makeLayout();
    const candles = makeCandles(4);
    const liveTime = candles[candles.length - 1]!.time;

    const active = new FakeCtx();
    drawCandlesticks(
      active,
      layout,
      candles,
      4,
      liveTime,
      0,
      0 /* pauseProgress */,
      0,
      0,
      1,
      0.5
    );

    const paused = new FakeCtx();
    drawCandlesticks(
      paused,
      layout,
      candles,
      4,
      liveTime,
      0,
      1 /* pauseProgress */,
      0,
      0,
      1,
      0.5
    );

    const activeFills = active.calls.filter((c) => c.op === 'fill').length;
    const pausedFills = paused.calls.filter((c) => c.op === 'fill').length;
    expect(activeFills).toBe(pausedFills + 1);
  });

  it('off-screen candles are excluded from every group', () => {
    const ctx = new FakeCtx();
    const layout = makeLayout();
    // Window is [0,100]; put every candle far outside it.
    const candles = makeCandles(5, 10000);
    drawCandlesticks(ctx, layout, candles, 4, -1, 0, 0, 0, 0);
    expect(ctx.calls.length).toBe(0);
  });

  it('falls back to one fill per candle when scrub-dimming is active', () => {
    const ctx = new FakeCtx();
    const layout = makeLayout();
    const candles = makeCandles(6);
    // scrubX > 0 and scrubDim > 0.01 activates the per-candle fallback path.
    drawCandlesticks(ctx, layout, candles, 4, -1, 0, 0, 50, 0.5);

    const fills = ctx.calls.filter((c) => c.op === 'fill');
    // One fill per (visible) non-live candle — not batched.
    expect(fills.length).toBe(candles.length);
  });

  it('scrub-dimmed candles vary in alpha (the reason batching is skipped)', () => {
    const ctx = new FakeCtx();
    const layout = makeLayout();
    const candles = makeCandles(6);
    drawCandlesticks(ctx, layout, candles, 4, -1, 0, 0, 50, 0.8);

    const fillAlphas = ctx.calls
      .filter((c) => c.op === 'fill')
      .map((c) => c.alpha);
    const distinct = new Set(fillAlphas.map((a) => a.toFixed(6)));
    expect(distinct.size).toBeGreaterThan(1);
  });
});
