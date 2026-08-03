import { drawTimeAxis, type TimeAxisState } from '../timeAxis';
import type { Ctx2D, Style2D } from '../canvas2d';
import type { ChartLayout, LivelinePalette, Padding } from '../../types';

// ── Fake Ctx2D recorder ──────────────────────────────────────────────────
// Covers exactly the methods drawTimeAxis calls. Records the style state at
// each stroke()/fillText() plus the save()/restore() counts — the thing under
// test is the per-frame call budget (drawTimeAxis used to save/restore around
// every single label) and the fact that dropping those pairs didn't change
// the per-label styling.

interface Call {
  op: 'stroke' | 'fillText';
  alpha: number;
  style: Style2D;
  lineWidth: number;
}

const LABEL_W = 30;

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
  fonts = { label: {} } as unknown as Ctx2D['fonts'];

  calls: Call[] = [];
  saveCount = 0;
  restoreCount = 0;
  private saved: Partial<FakeCtx>[] = [];

  save() {
    this.saveCount++;
    this.saved.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
    });
  }
  restore() {
    this.restoreCount++;
    const s = this.saved.pop();
    if (s) {
      this.fillStyle = s.fillStyle!;
      this.strokeStyle = s.strokeStyle!;
      this.lineWidth = s.lineWidth!;
      this.globalAlpha = s.globalAlpha!;
    }
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
  fill() {}
  stroke() {
    this.calls.push({
      op: 'stroke',
      alpha: this.globalAlpha,
      style: this.strokeStyle,
      lineWidth: this.lineWidth,
    });
  }
  clipRect() {}
  fillRect() {}
  fillText() {
    this.calls.push({
      op: 'fillText',
      alpha: this.globalAlpha,
      style: this.fillStyle,
      lineWidth: this.lineWidth,
    });
  }
  strokeText() {}
  measureText() {
    return { width: LABEL_W };
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

const PAD: Required<Padding> = { top: 10, right: 10, bottom: 24, left: 10 };

function makeLayout(w = 600, h = 240): ChartLayout {
  const chartW = w - PAD.left - PAD.right;
  const chartH = h - PAD.top - PAD.bottom;
  const leftEdge = 0;
  const rightEdge = 300; // 5-minute window
  return {
    w,
    h,
    pad: PAD,
    chartW,
    chartH,
    leftEdge,
    rightEdge,
    minVal: 0,
    maxVal: 100,
    valRange: 100,
    toX: (t: number) =>
      PAD.left + ((t - leftEdge) / (rightEdge - leftEdge)) * chartW,
    toY: (v: number) => PAD.top + (1 - v / 100) * chartH,
  };
}

const PALETTE = {
  gridLine: '#333333',
  timeLabel: '#999999',
} as unknown as LivelinePalette;

function makeState(): TimeAxisState {
  return {
    labels: new Map(),
    targetsScratch: new Set(),
    visibleLabelsScratch: [],
    drawnScratch: [],
    labelEntryPool: [],
    // Added by the label-text memoization (see timeAxis.test.ts); null means
    // "no formatter seen yet", so the first frame formats every label.
    formatTimeRef: null,
  };
}

const WINDOW = 300;
const formatTime = (t: number) => `t${Math.round(t)}`;

/** Runs `frames` frames against one persistent state so the label alphas
 * ramp up out of their initial 0, then returns the LAST frame's recorder. */
function run(frames: number, baseAlpha = 1): FakeCtx {
  const state = makeState();
  const layout = makeLayout();
  let ctx = new FakeCtx();
  for (let i = 0; i < frames; i++) {
    ctx = new FakeCtx();
    ctx.globalAlpha = baseAlpha;
    // dt is in milliseconds (see math/lerp) — one 60fps frame per iteration.
    drawTimeAxis(
      ctx,
      layout,
      PALETTE,
      WINDOW,
      WINDOW,
      formatTime,
      state,
      16.67
    );
  }
  return ctx;
}

describe('drawTimeAxis per-frame call budget', () => {
  it('issues no save()/restore() at all — not one pair per label', () => {
    const ctx = run(60);
    const labelCount = ctx.calls.filter((c) => c.op === 'fillText').length;

    expect(labelCount).toBeGreaterThan(2); // the loop actually ran
    expect(ctx.saveCount).toBe(0);
    expect(ctx.restoreCount).toBe(0);
  });

  it('strokes exactly one tick per label, plus the single axis line', () => {
    const ctx = run(60);
    const strokes = ctx.calls.filter((c) => c.op === 'stroke').length;
    const labels = ctx.calls.filter((c) => c.op === 'fillText').length;

    expect(strokes).toBe(labels + 1);
  });
});

describe('drawTimeAxis per-label state', () => {
  it('applies each label its own alpha and leaves globalAlpha at the caller value', () => {
    const baseAlpha = 0.5;
    const ctx = run(30, baseAlpha);
    const texts = ctx.calls.filter((c) => c.op === 'fillText');

    expect(texts.length).toBeGreaterThan(2);
    for (const c of texts) {
      expect(c.alpha).toBeGreaterThan(0);
      expect(c.alpha).toBeLessThanOrEqual(baseAlpha);
    }
    // Labels mid-fade differ from each other, so a leaked alpha from the
    // previous iteration would be visible as a wrong value here.
    expect(ctx.globalAlpha).toBe(baseAlpha);
  });

  it('draws every tick with the grid stroke and every label with the label fill', () => {
    const ctx = run(60);

    for (const c of ctx.calls) {
      if (c.op === 'stroke') {
        expect(c.style).toBe(PALETTE.gridLine);
        expect(c.lineWidth).toBe(1);
      } else {
        expect(c.style).toBe(PALETTE.timeLabel);
      }
    }
  });

  it('pairs each label fillText with a tick stroke at the same alpha', () => {
    const ctx = run(45, 0.8);
    // calls: [axis-line stroke, (tick stroke, fillText) x N]
    const rest = ctx.calls.slice(1);
    expect(rest.length).toBeGreaterThanOrEqual(6);
    expect(rest.length % 2).toBe(0);
    for (let i = 0; i < rest.length; i += 2) {
      expect(rest[i]!.op).toBe('stroke');
      expect(rest[i + 1]!.op).toBe('fillText');
      expect(rest[i + 1]!.alpha).toBe(rest[i]!.alpha);
    }
  });
});
