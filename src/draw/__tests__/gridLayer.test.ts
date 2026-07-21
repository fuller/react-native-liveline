import {
  createGridLayerSlot,
  gridLayerKeyMatches,
  writeGridLayerKey,
} from '../gridLayer';
import type { ChartLayout, LivelinePalette, Padding } from '../../types';

const PAD: Required<Padding> = { top: 10, right: 20, bottom: 20, left: 10 };

function makeLayout(
  overrides: Partial<Pick<ChartLayout, 'minVal' | 'maxVal' | 'w' | 'h'>> = {}
): ChartLayout {
  const w = overrides.w ?? 400;
  const h = overrides.h ?? 200;
  const minVal = overrides.minVal ?? 90;
  const maxVal = overrides.maxVal ?? 110;
  const chartW = w - PAD.left - PAD.right;
  const chartH = h - PAD.top - PAD.bottom;
  const valRange = maxVal - minVal || 1;
  return {
    w,
    h,
    pad: PAD,
    chartW,
    chartH,
    leftEdge: 0,
    rightEdge: 60,
    minVal,
    maxVal,
    valRange,
    toX: (t: number) => PAD.left + (t / 60) * chartW,
    toY: (v: number) => PAD.top + (1 - (v - minVal) / valRange) * chartH,
  };
}

function makePalette(
  overrides: Partial<Pick<LivelinePalette, 'gridLine' | 'gridLabel'>> = {}
): LivelinePalette {
  return {
    line: '#3b82f6',
    lineWidth: 2,
    fillTop: 'rgba(59,130,246,0.3)',
    fillBottom: 'rgba(59,130,246,0)',
    gridLine: overrides.gridLine ?? '#e5e7eb',
    gridLabel: overrides.gridLabel ?? '#6b7280',
    dotUp: '#22c55e',
    dotDown: '#ef4444',
    dotFlat: '#6b7280',
    glowUp: '#22c55e',
    glowDown: '#ef4444',
    glowFlat: '#6b7280',
    badgeOuterBg: '#ffffff',
    badgeOuterShadow: 'rgba(0,0,0,0.2)',
    badgeBg: '#3b82f6',
    badgeText: '#ffffff',
    dashLine: '#9ca3af',
    refLine: '#f59e0b',
    refLabel: '#f59e0b',
    timeLabel: '#6b7280',
    crosshairLine: '#9ca3af',
    tooltipBg: '#111827',
    tooltipText: '#ffffff',
    tooltipBorder: '#374151',
    bgRgb: [255, 255, 255],
  };
}

const formatValueA = (v: number) => `$${v}`;
const formatValueB = (v: number) => `${v}`;

describe('gridLayerKeyMatches / writeGridLayerKey', () => {
  it('a fresh slot never matches (picture is null)', () => {
    const slot = createGridLayerSlot<object>();
    expect(
      gridLayerKeyMatches(slot, makeLayout(), makePalette(), formatValueA)
    ).toBe(false);
  });

  it('matches after writing the key for these exact inputs', () => {
    const slot = createGridLayerSlot<object>();
    slot.picture = {};
    const layout = makeLayout();
    const palette = makePalette();
    writeGridLayerKey(slot, layout, palette, formatValueA);
    expect(gridLayerKeyMatches(slot, layout, palette, formatValueA)).toBe(true);
  });

  it('rebuilds when minVal changes', () => {
    const slot = createGridLayerSlot<object>();
    slot.picture = {};
    writeGridLayerKey(slot, makeLayout(), makePalette(), formatValueA);
    const changed = makeLayout({ minVal: 89 });
    expect(
      gridLayerKeyMatches(slot, changed, makePalette(), formatValueA)
    ).toBe(false);
  });

  it('rebuilds when maxVal changes', () => {
    const slot = createGridLayerSlot<object>();
    slot.picture = {};
    writeGridLayerKey(slot, makeLayout(), makePalette(), formatValueA);
    const changed = makeLayout({ maxVal: 111 });
    expect(
      gridLayerKeyMatches(slot, changed, makePalette(), formatValueA)
    ).toBe(false);
  });

  it('rebuilds when canvas width changes', () => {
    const slot = createGridLayerSlot<object>();
    slot.picture = {};
    writeGridLayerKey(slot, makeLayout(), makePalette(), formatValueA);
    const changed = makeLayout({ w: 500 });
    expect(
      gridLayerKeyMatches(slot, changed, makePalette(), formatValueA)
    ).toBe(false);
  });

  it('rebuilds when canvas height changes', () => {
    const slot = createGridLayerSlot<object>();
    slot.picture = {};
    writeGridLayerKey(slot, makeLayout(), makePalette(), formatValueA);
    const changed = makeLayout({ h: 250 });
    expect(
      gridLayerKeyMatches(slot, changed, makePalette(), formatValueA)
    ).toBe(false);
  });

  it('rebuilds when padding changes', () => {
    const slot = createGridLayerSlot<object>();
    slot.picture = {};
    const layout = makeLayout();
    writeGridLayerKey(slot, layout, makePalette(), formatValueA);
    const changedPad = { ...layout, pad: { ...layout.pad, left: 15 } };
    expect(
      gridLayerKeyMatches(slot, changedPad, makePalette(), formatValueA)
    ).toBe(false);
  });

  it('rebuilds when the gridLine color changes', () => {
    const slot = createGridLayerSlot<object>();
    slot.picture = {};
    const layout = makeLayout();
    writeGridLayerKey(slot, layout, makePalette(), formatValueA);
    const changed = makePalette({ gridLine: '#000000' });
    expect(gridLayerKeyMatches(slot, layout, changed, formatValueA)).toBe(
      false
    );
  });

  it('rebuilds when the gridLabel color changes', () => {
    const slot = createGridLayerSlot<object>();
    slot.picture = {};
    const layout = makeLayout();
    writeGridLayerKey(slot, layout, makePalette(), formatValueA);
    const changed = makePalette({ gridLabel: '#000000' });
    expect(gridLayerKeyMatches(slot, layout, changed, formatValueA)).toBe(
      false
    );
  });

  it('rebuilds when formatValue changes reference (even if behaviorally identical)', () => {
    const slot = createGridLayerSlot<object>();
    slot.picture = {};
    const layout = makeLayout();
    const palette = makePalette();
    writeGridLayerKey(slot, layout, palette, formatValueA);
    expect(gridLayerKeyMatches(slot, layout, palette, formatValueB)).toBe(
      false
    );
  });

  it('does not rebuild for an unrelated field left untouched (leftEdge/rightEdge/valRange are not keyed)', () => {
    // Grid has no horizontal scroll — unlike the line/time-axis caches,
    // nothing here should key on leftEdge/rightEdge.
    const slot = createGridLayerSlot<object>();
    slot.picture = {};
    const layout = makeLayout();
    const palette = makePalette();
    writeGridLayerKey(slot, layout, palette, formatValueA);
    const shifted: ChartLayout = { ...layout, leftEdge: 999, rightEdge: 1059 };
    expect(gridLayerKeyMatches(slot, shifted, palette, formatValueA)).toBe(
      true
    );
  });
});

describe('createGridLayerSlot', () => {
  it('starts with a null picture and zero settled frames', () => {
    const slot = createGridLayerSlot<object>();
    expect(slot.picture).toBeNull();
    expect(slot.settledFrames).toBe(0);
  });
});
