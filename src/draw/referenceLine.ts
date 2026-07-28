import type { LivelinePalette, ChartLayout, ReferenceLine } from '../types';
import type { Ctx2D } from './canvas2d';

// Hoisted so setLineDash doesn't take a fresh array literal every frame —
// the shim stores this reference directly (see canvas2d.ts's setLineDash).
// Declared locally rather than imported from canvas2d.ts: that module pulls
// in the native Skia binding at import time, and some draw modules'
// dedicated unit tests (e.g. candlestick.test.ts) import their module
// directly without it loaded — kept local here too for consistency.
const DASH_4_4: number[] = [4, 4];
const EMPTY_DASH: number[] = [];

export function drawReferenceLine(
  ctx: Ctx2D,
  layout: ChartLayout,
  palette: LivelinePalette,
  ref: ReferenceLine
) {
  'worklet';
  const { w, h, pad, toY, chartW } = layout;
  const y = toY(ref.value);

  if (y < pad.top - 10 || y > h - pad.bottom + 10) return;

  const label = ref.label ?? '';

  if (label) {
    ctx.font = ctx.fonts.refLabel;
    const textW = ctx.measureText(label).width;
    const centerX = pad.left + chartW / 2;
    const gapPad = 8;

    // Line left of text
    ctx.strokeStyle = palette.refLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(centerX - textW / 2 - gapPad, y);
    ctx.stroke();

    // Line right of text
    ctx.beginPath();
    ctx.moveTo(centerX + textW / 2 + gapPad, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();

    // Label
    ctx.fillStyle = palette.refLabel;
    ctx.textAlign = 'center';
    ctx.fillText(label, centerX, y + 4);
  } else {
    // Full line, no label
    ctx.strokeStyle = palette.refLine;
    ctx.lineWidth = 1;
    ctx.setLineDash(DASH_4_4);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    ctx.setLineDash(EMPTY_DASH);
  }
}
