import { drawTimeAxis, type TimeAxisState } from '../timeAxis';
import type { ChartLayout, LivelinePalette } from '../../types';

/**
 * `timeAxis.ts` had no test coverage before this file. It is testable — unlike
 * `draw/index.ts` — because it imports `Ctx2D` as a *type* only and never pulls
 * in the native Skia binding, the same property that makes `lineCache.ts` and
 * `gridLayer.ts` testable.
 *
 * These tests exist primarily to pin the label-text memoization: the formatter
 * must run once per newly-visible key rather than once per key per frame, and
 * a formatter swap must re-text live labels WITHOUT restarting their fade-in.
 * Every assertion here is about behavior that is invisible on screen, which is
 * exactly why it needs a test — a regression would silently reintroduce
 * thousands of allocations per second with no visual symptom.
 */

const WINDOW = 30;
const NOW = 1_700_000_000;

function makeLayout(rightEdge = NOW): ChartLayout {
  const leftEdge = rightEdge - WINDOW;
  const pad = { top: 12, right: 80, bottom: 28, left: 12 };
  const w = 400;
  const chartW = w - pad.left - pad.right;
  return {
    w,
    h: 300,
    pad,
    chartW,
    chartH: 300 - pad.top - pad.bottom,
    leftEdge,
    rightEdge,
    minVal: 0,
    maxVal: 100,
    valRange: 100,
    toX: (t: number) => pad.left + ((t - leftEdge) / WINDOW) * chartW,
    toY: (v: number) => v,
  };
}

const palette = {
  gridLine: '#222222',
  timeLabel: '#888888',
} as unknown as LivelinePalette;

function makeState(): TimeAxisState {
  return {
    labels: new Map(),
    targetsScratch: new Set(),
    visibleLabelsScratch: [],
    drawnScratch: [],
    labelEntryPool: [],
    formatTimeRef: null,
  };
}

/** Minimal Ctx2D stand-in — only the members drawTimeAxis actually touches. */
function makeCtx() {
  const font = { __slot: 'label' };
  return {
    fonts: { label: font },
    font,
    globalAlpha: 1,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    textAlign: 'left' as const,
    drawnTexts: [] as string[],
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    measureText(text: string) {
      return { width: text.length * 6 };
    },
    fillText(text: string) {
      this.drawnTexts.push(text);
    },
  };
}

function run(
  ctx: ReturnType<typeof makeCtx>,
  state: TimeAxisState,
  formatTime: (t: number) => string,
  rightEdge = NOW,
  dt = 16.67
) {
  drawTimeAxis(
    ctx as any,
    makeLayout(rightEdge),
    palette,
    WINDOW,
    WINDOW,
    formatTime,
    state,
    dt
  );
}

function countingFormatter() {
  let calls = 0;
  const fn = (t: number) => {
    calls++;
    return `T${Math.round(t)}`;
  };
  return { fn, calls: () => calls };
}

describe('drawTimeAxis label-text memoization', () => {
  it('formats each key exactly once across many stationary frames', () => {
    const ctx = makeCtx();
    const state = makeState();
    const f = countingFormatter();

    run(ctx, state, f.fn);
    const afterFirst = f.calls();
    expect(afterFirst).toBeGreaterThan(0);

    // Same window, same keys — nothing new should ever need formatting.
    for (let i = 0; i < 60; i++) run(ctx, state, f.fn);

    expect(f.calls()).toBe(afterFirst);
  });

  it('formats only the newly-arrived keys as the window scrolls', () => {
    const ctx = makeCtx();
    const state = makeState();
    const f = countingFormatter();

    run(ctx, state, f.fn, NOW);
    const afterFirst = f.calls();

    // Scroll forward by a full window — every key is new, but each is still
    // formatted once, not once per frame.
    const frames = 60;
    for (let i = 1; i <= frames; i++) {
      run(ctx, state, f.fn, NOW + (WINDOW * i) / frames);
    }

    const added = f.calls() - afterFirst;
    // Bounded well below "one call per key per frame", which is what the
    // pre-memoization implementation did.
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThan(frames);
  });

  it('produces the same text a per-frame formatter would have', () => {
    const fmt = (t: number) => `T${Math.round(t)}`;
    const ctx = makeCtx();
    const state = makeState();

    for (let i = 0; i < 10; i++) run(ctx, state, fmt);

    for (const [key, label] of state.labels) {
      expect(label.text).toBe(fmt(key / 100));
    }
  });

  it('re-texts live labels when the formatter reference changes', () => {
    const ctx = makeCtx();
    const state = makeState();

    run(ctx, state, (t) => `A${Math.round(t)}`);
    expect(state.labels.size).toBeGreaterThan(0);
    for (const label of state.labels.values()) {
      expect(label.text.startsWith('A')).toBe(true);
    }

    run(ctx, state, (t) => `B${Math.round(t)}`);
    for (const label of state.labels.values()) {
      expect(label.text.startsWith('B')).toBe(true);
    }
  });

  it('does not restart fade-in when the formatter changes', () => {
    const ctx = makeCtx();
    const state = makeState();

    // Let alphas rise well above their initial 0.
    for (let i = 0; i < 30; i++) run(ctx, state, (t) => `A${Math.round(t)}`);
    const before = new Map(
      [...state.labels].map(([k, l]) => [k, l.alpha] as const)
    );
    expect([...before.values()].some((a) => a > 0.5)).toBe(true);

    // A formatter swap re-texts, but must not touch alpha. Pass dt = 0 so the
    // lerp cannot advance and any change would be the re-text's fault.
    run(ctx, state, (t) => `B${Math.round(t)}`, NOW, 0);

    for (const [key, label] of state.labels) {
      expect(label.alpha).toBe(before.get(key));
    }
  });

  it('tracks the formatter reference on the state', () => {
    const ctx = makeCtx();
    const state = makeState();
    expect(state.formatTimeRef).toBeNull();

    const fmt = (t: number) => `T${Math.round(t)}`;
    run(ctx, state, fmt);
    expect(state.formatTimeRef).toBe(fmt);
  });

  it('still draws label text every frame', () => {
    const ctx = makeCtx();
    const state = makeState();
    const fmt = (t: number) => `T${Math.round(t)}`;

    // Warm up so alphas clear the 0.02 visibility floor.
    for (let i = 0; i < 30; i++) run(ctx, state, fmt);
    ctx.drawnTexts.length = 0;
    run(ctx, state, fmt);

    // Memoizing the *text* must not stop it being *drawn* — the labels are
    // still painted live every frame, which is the whole point of keeping the
    // per-label alpha animation intact.
    expect(ctx.drawnTexts.length).toBeGreaterThan(0);
  });
});

describe('measured formatter-call counts (pins the win)', () => {
  it('stationary: one call per target on frame 1, zero thereafter', () => {
    const ctx = makeCtx();
    const state = makeState();
    const f = countingFormatter();

    run(ctx, state, f.fn);
    const firstFrame = f.calls();

    for (let i = 0; i < 59; i++) run(ctx, state, f.fn);

    // Pre-memoization this was firstFrame * 60. Now the remaining 59 frames
    // cost nothing at all.
    expect(f.calls()).toBe(firstFrame);
    expect(firstFrame).toBe(state.labels.size);
  });
});
