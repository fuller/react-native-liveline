import type { ChartLayout, LivelinePalette, CandlePoint } from '../types';
import { rgbColor } from '../math/color';
import type { SkColor } from '@shopify/react-native-skia';
import type { Ctx2D } from './canvas2d';

export type { CandlePoint } from '../types';

const BULL = '#22c55e';
const BEAR = '#ef4444';

// Pre-parsed RGB for fast interpolation
const BULL_RGB = [34, 197, 94] as const;
const BEAR_RGB = [239, 68, 68] as const;

/** Blend bear→bull by t (0=bear, 1=bull), as an RGB tuple — lets a caller
 * (the live candle) combine this with a further accent blend without a
 * lossy SkColor→RGB round-trip. */
function blendRgb(t: number): [number, number, number] {
  'worklet';
  const r = Math.round(BEAR_RGB[0] + (BULL_RGB[0] - BEAR_RGB[0]) * t);
  const g = Math.round(BEAR_RGB[1] + (BULL_RGB[1] - BEAR_RGB[1]) * t);
  const b = Math.round(BEAR_RGB[2] + (BULL_RGB[2] - BEAR_RGB[2]) * t);
  return [r, g, b];
}

/** Blend bear→bull by t (0=bear, 1=bull). */
function blendColor(t: number): SkColor {
  'worklet';
  const [r, g, b] = blendRgb(t);
  return rgbColor(r, g, b);
}

/** Parse "#rrggbb" or "rgb(r,g,b)" to [r,g,b]. */
function parseRgb(color: string): [number, number, number] {
  'worklet';
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1]!;
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  const rgb = color.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return [+rgb[1]!, +rgb[2]!, +rgb[3]!];
  return [128, 128, 128];
}

/** Blend a candle's base RGB toward an accent color (a CSS string,
 * parsed once) by t. */
function blendToAccent(
  candleRgb: readonly [number, number, number],
  accentColor: string,
  t: number
): SkColor {
  'worklet';
  if (t <= 0) return rgbColor(candleRgb[0], candleRgb[1], candleRgb[2]);
  const [r2, g2, b2] = parseRgb(accentColor);
  if (t >= 1) return rgbColor(r2, g2, b2);
  const r = Math.round(candleRgb[0] + (r2 - candleRgb[0]) * t);
  const g = Math.round(candleRgb[1] + (g2 - candleRgb[1]) * t);
  const b = Math.round(candleRgb[2] + (b2 - candleRgb[2]) * t);
  return rgbColor(r, g, b);
}

/**
 * Compute pixel dimensions for candle rendering.
 */
function candleDims(layout: ChartLayout, candleWidthSecs: number) {
  'worklet';
  const pxPerSec = layout.chartW / (layout.rightEdge - layout.leftEdge);
  const candlePxW = candleWidthSecs * pxPerSec;
  const bodyW = Math.max(1, candlePxW * 0.7);
  const wickW = Math.max(0.8, Math.min(2, bodyW * 0.15));
  const radius = bodyW > 6 ? 1.5 : 0;
  return { bodyW, wickW, radius };
}

/**
 * Rounded rect helper — draws path only (caller fills/strokes).
 */
function roundedRect(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  'worklet';
  if (r <= 0 || h < r * 2) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * Draw OHLC candlesticks with live candle glow + scrub dimming.
 * Respects incoming ctx.globalAlpha for cross-fade/reveal support.
 *
 * Every non-live candle is exactly one of two colors (bull/bear, uniformly
 * accent-blended if a mode-morph is in progress — the blend is the same
 * for every candle sharing a base color, so there are still only two
 * results). Outside of scrub dimming, every non-live candle also shares
 * the same alpha (1). Both are precomputed once and the non-live candles
 * are batched into two combined paths (one fill + one stroke call each)
 * instead of up to 3 native calls per candle — for a chart with M candles,
 * a handful of calls instead of up to 3M. Scrub dimming gives each candle
 * its own continuous alpha (a spatial fade from the cursor), which can't
 * be expressed as one paint-level alpha for a combined path, so batching
 * is skipped and candles are drawn individually in that case — the same
 * per-candle logic this function used before batching, unchanged.
 */
export function drawCandlesticks(
  ctx: Ctx2D,
  layout: ChartLayout,
  candles: CandlePoint[],
  candleWidthSecs: number,
  liveTime: number,
  now_ms: number,
  pauseProgress: number,
  scrubX: number,
  scrubDim: number,
  liveAlpha: number = 1,
  liveBullBlend: number = -1,
  accentColor?: string,
  accentBlend: number = 0
) {
  'worklet';
  if (candles.length === 0) return;

  const { toX, toY } = layout;
  const { bodyW, wickW, radius } = candleDims(layout, candleWidthSecs);
  const halfBody = bodyW / 2;
  const padL = layout.pad.left;
  const padR = layout.pad.left + layout.chartW;

  // Live pulse: subtle brightness cycle. Gated off past the same pause
  // threshold the dot's pulse ring uses (draw/index.ts) — without this,
  // this Math.sin(now_ms) term never settles, and candle mode could never
  // reach quiescence (see engine/quiescence.ts).
  const showLivePulse = pauseProgress < 0.5;
  const livePulse = showLivePulse ? 0.12 + Math.sin(now_ms * 0.004) * 0.08 : 0;
  const baseAlpha = ctx.globalAlpha;
  const hasAccent = !!accentColor && accentBlend > 0.01;
  const canBatch = !(scrubDim > 0.01 && scrubX > 0);

  const bullColor: SkColor = hasAccent
    ? blendToAccent(BULL_RGB, accentColor!, accentBlend)
    : rgbColor(BULL_RGB[0], BULL_RGB[1], BULL_RGB[2]);
  const bearColor: SkColor = hasAccent
    ? blendToAccent(BEAR_RGB, accentColor!, accentBlend)
    : rgbColor(BEAR_RGB[0], BEAR_RGB[1], BEAR_RGB[2]);

  const bodyRect = (cx: number, bodyTop: number, bodyH: number) => {
    roundedRect(ctx, cx - halfBody, bodyTop, bodyW, bodyH, radius);
  };
  const spatialDim = (cx: number): number => {
    const dist = cx - scrubX;
    if (dist <= 0) return 1;
    const dimT = Math.min(dist / (bodyW * 1.5), 1);
    return 1 - scrubDim * 0.5 * dimT;
  };

  let liveCandle: CandlePoint | null = null;

  if (canBatch) {
    ctx.globalAlpha = baseAlpha; // non-live candleAlpha is always 1 here
    ctx.lineCap = 'round';
    ctx.lineWidth = wickW;

    for (const isBull of [true, false] as const) {
      const groupColor = isBull ? bullColor : bearColor;

      let bodyCount = 0;
      ctx.beginPath();
      for (const c of candles) {
        if (c.time === liveTime) {
          liveCandle = c;
          continue;
        }
        if (c.close >= c.open !== isBull) continue;
        const cx = toX(c.time + candleWidthSecs / 2);
        if (cx + halfBody < padL || cx - halfBody > padR) continue;
        const bodyTop = toY(Math.max(c.open, c.close));
        const bodyBottom = toY(Math.min(c.open, c.close));
        bodyRect(cx, bodyTop, Math.max(1, bodyBottom - bodyTop));
        bodyCount++;
      }
      if (bodyCount > 0) {
        ctx.fillStyle = groupColor;
        ctx.fill();
      }

      let wickCount = 0;
      ctx.beginPath();
      for (const c of candles) {
        if (c.time === liveTime) continue;
        if (c.close >= c.open !== isBull) continue;
        const cx = toX(c.time + candleWidthSecs / 2);
        if (cx + halfBody < padL || cx - halfBody > padR) continue;
        const bodyTop = toY(Math.max(c.open, c.close));
        const bodyBottom = toY(Math.min(c.open, c.close));
        const wickTop = toY(c.high);
        const wickBottom = toY(c.low);
        if (bodyTop - wickTop > 0.5) {
          ctx.moveTo(cx, bodyTop);
          ctx.lineTo(cx, wickTop);
          wickCount++;
        }
        if (wickBottom - bodyBottom > 0.5) {
          ctx.moveTo(cx, bodyBottom);
          ctx.lineTo(cx, wickBottom);
          wickCount++;
        }
      }
      if (wickCount > 0) {
        ctx.strokeStyle = groupColor;
        ctx.stroke();
      }
    }
  } else {
    // Fallback: per-candle draw, exactly as before batching — needed
    // because scrub dimming gives each candle its own continuous alpha.
    for (const c of candles) {
      if (c.time === liveTime) {
        liveCandle = c;
        continue;
      }
      const cx = toX(c.time + candleWidthSecs / 2);
      if (cx + halfBody < padL || cx - halfBody > padR) continue;

      const isBull = c.close >= c.open;
      const color = isBull ? bullColor : bearColor;
      ctx.globalAlpha = baseAlpha * spatialDim(cx);

      const bodyTop = toY(Math.max(c.open, c.close));
      const bodyBottom = toY(Math.min(c.open, c.close));
      const wickTop = toY(c.high);
      const wickBottom = toY(c.low);
      ctx.lineCap = 'round';
      ctx.strokeStyle = color;

      if (bodyTop - wickTop > 0.5) {
        ctx.beginPath();
        ctx.moveTo(cx, bodyTop);
        ctx.lineTo(cx, wickTop);
        ctx.lineWidth = wickW;
        ctx.stroke();
      }
      if (wickBottom - bodyBottom > 0.5) {
        ctx.beginPath();
        ctx.moveTo(cx, bodyBottom);
        ctx.lineTo(cx, wickBottom);
        ctx.lineWidth = wickW;
        ctx.stroke();
      }

      ctx.fillStyle = color;
      ctx.beginPath();
      bodyRect(cx, bodyTop, Math.max(1, bodyBottom - bodyTop));
      ctx.fill();

      ctx.globalAlpha = baseAlpha;
    }
  }

  // Live candle — always drawn individually (own color/alpha/glow), after
  // the batched/fallback groups. Z-order among candles doesn't matter
  // visually (bodies never overlap horizontally), so drawing it last is
  // just the simplest place, matching where it fell in the original
  // chronological per-candle loop for a trailing live candle.
  if (liveCandle) {
    const cx = toX(liveCandle.time + candleWidthSecs / 2);
    if (cx + halfBody >= padL && cx - halfBody <= padR) {
      const liveIsBull = liveCandle.close >= liveCandle.open;
      const liveBaseRgb: [number, number, number] =
        liveBullBlend >= 0
          ? blendRgb(liveBullBlend)
          : liveIsBull
            ? [BULL_RGB[0], BULL_RGB[1], BULL_RGB[2]]
            : [BEAR_RGB[0], BEAR_RGB[1], BEAR_RGB[2]];
      const liveColor: SkColor = hasAccent
        ? blendToAccent(liveBaseRgb, accentColor!, accentBlend)
        : rgbColor(liveBaseRgb[0], liveBaseRgb[1], liveBaseRgb[2]);

      const bodyTop = toY(Math.max(liveCandle.open, liveCandle.close));
      const bodyBottom = toY(Math.min(liveCandle.open, liveCandle.close));
      const bodyH = Math.max(1, bodyBottom - bodyTop);
      const wickTop = toY(liveCandle.high);
      const wickBottom = toY(liveCandle.low);

      const candleAlpha = canBatch ? liveAlpha : liveAlpha * spatialDim(cx);
      ctx.globalAlpha = baseAlpha * candleAlpha;

      ctx.lineCap = 'round';
      ctx.strokeStyle = liveColor;
      if (bodyTop - wickTop > 0.5) {
        ctx.beginPath();
        ctx.moveTo(cx, bodyTop);
        ctx.lineTo(cx, wickTop);
        ctx.lineWidth = wickW;
        ctx.stroke();
      }
      if (wickBottom - bodyBottom > 0.5) {
        ctx.beginPath();
        ctx.moveTo(cx, bodyBottom);
        ctx.lineTo(cx, wickBottom);
        ctx.lineWidth = wickW;
        ctx.stroke();
      }

      ctx.fillStyle = liveColor;
      ctx.beginPath();
      bodyRect(cx, bodyTop, bodyH);
      ctx.fill();

      if (showLivePulse) {
        ctx.save();
        ctx.globalAlpha = baseAlpha * candleAlpha * livePulse;
        ctx.shadowColor = liveColor;
        ctx.shadowBlur = 8;
        ctx.fillStyle = liveColor;
        ctx.beginPath();
        bodyRect(cx, bodyTop, bodyH);
        ctx.fill();
        ctx.restore();
      }

      ctx.globalAlpha = baseAlpha;
    }
  }
}

/**
 * Draw a dashed horizontal line at the live close price.
 * Dims when scrubbing, uses candle direction color.
 */
export function drawClosePrice(
  ctx: Ctx2D,
  layout: ChartLayout,
  _palette: LivelinePalette,
  liveCandle: CandlePoint,
  scrubDim: number,
  bullBlend: number = -1
) {
  'worklet';
  const y = layout.toY(liveCandle.close);
  if (y < layout.pad.top || y > layout.h - layout.pad.bottom) return;

  const isBull = liveCandle.close >= liveCandle.open;
  const color = bullBlend >= 0 ? blendColor(bullBlend) : isBull ? BULL : BEAR;

  const baseAlpha = ctx.globalAlpha;
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = baseAlpha * (1 - scrubDim * 0.3) * 0.4;
  ctx.beginPath();
  ctx.moveTo(layout.pad.left, y);
  ctx.lineTo(layout.w - layout.pad.right, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Draw candlestick crosshair: vertical line + OHLC tooltip.
 * All elements respect `opacity` for smooth fade in/out.
 */
export function drawCandleCrosshair(
  ctx: Ctx2D,
  layout: ChartLayout,
  palette: LivelinePalette,
  hoverX: number,
  candle: CandlePoint,
  hoverTime: number,
  formatValue: (v: number) => string,
  formatTime: (t: number) => string,
  opacity: number
) {
  'worklet';
  if (opacity < 0.01) return;

  const { h, pad } = layout;

  // Vertical line
  ctx.save();
  ctx.globalAlpha = opacity * 0.5;
  ctx.strokeStyle = palette.crosshairLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(hoverX, pad.top);
  ctx.lineTo(hoverX, h - pad.bottom);
  ctx.stroke();
  ctx.restore();

  // Tooltip — OHLC + time (matches line chart crosshair patterns)
  if (opacity < 0.1 || layout.w < 200) return;

  const isBull = candle.close >= candle.open;
  const valueColor = isBull ? BULL : BEAR;

  const cl = formatValue(candle.close);
  const time = formatTime(hoverTime);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.font = ctx.fonts.crosshair;
  ctx.textAlign = 'left';

  // Full OHLC at ≥400px, condensed (close + time) at smaller sizes
  let parts: { text: string; color: string }[];
  if (layout.w >= 400) {
    const o = formatValue(candle.open);
    const hi = formatValue(candle.high);
    const lo = formatValue(candle.low);
    parts = [
      { text: 'O ', color: palette.gridLabel },
      { text: o, color: valueColor },
      { text: '   H ', color: palette.gridLabel },
      { text: hi, color: valueColor },
      { text: '   L ', color: palette.gridLabel },
      { text: lo, color: valueColor },
      { text: '   C ', color: palette.gridLabel },
      { text: cl, color: valueColor },
      { text: '  ·  ', color: palette.gridLabel },
      { text: time, color: palette.gridLabel },
    ];
  } else {
    parts = [
      { text: 'C ', color: palette.gridLabel },
      { text: cl, color: valueColor },
      { text: '  ·  ', color: palette.gridLabel },
      { text: time, color: palette.gridLabel },
    ];
  }

  // Measure
  let totalW = 0;
  const widths: number[] = [];
  for (const p of parts) {
    const w = ctx.measureText(p.text).width;
    widths.push(w);
    totalW += w;
  }

  // Position — center on hover, clamp to chart bounds
  let tx = hoverX - totalW / 2;
  const minX = pad.left + 4;
  const maxX = layout.w - pad.right - totalW;
  if (tx < minX) tx = minX;
  if (tx > maxX) tx = maxX;
  const ty = pad.top + 24;

  // Outline stroke for readability
  ctx.strokeStyle = palette.tooltipBg;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  let cx = tx;
  for (let i = 0; i < parts.length; i++) {
    ctx.strokeText(parts[i]!.text, cx, ty);
    cx += widths[i]!;
  }

  // Fill text
  cx = tx;
  for (let i = 0; i < parts.length; i++) {
    ctx.fillStyle = parts[i]!.color;
    ctx.fillText(parts[i]!.text, cx, ty);
    cx += widths[i]!;
  }

  ctx.restore();
}

/**
 * Simplified crosshair for line mode — single value + time (no OHLC).
 */
export function drawLineModeCrosshair(
  ctx: Ctx2D,
  layout: ChartLayout,
  palette: LivelinePalette,
  hoverX: number,
  value: number,
  hoverTime: number,
  formatValue: (v: number) => string,
  formatTime: (t: number) => string,
  opacity: number
) {
  'worklet';
  if (opacity < 0.01) return;

  const { h, pad } = layout;
  const y = layout.toY(value);

  ctx.save();
  ctx.globalAlpha = opacity * 0.5;
  ctx.strokeStyle = palette.crosshairLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(hoverX, pad.top);
  ctx.lineTo(hoverX, h - pad.bottom);
  ctx.stroke();

  ctx.globalAlpha = opacity * 0.3;
  ctx.beginPath();
  ctx.moveTo(pad.left, y);
  ctx.lineTo(layout.w - pad.right, y);
  ctx.stroke();
  ctx.restore();

  if (opacity < 0.1 || layout.w < 200) return;

  const val = formatValue(value);
  const time = formatTime(hoverTime);

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.font = ctx.fonts.crosshair;
  ctx.textAlign = 'left';

  const parts: { text: string; color: string }[] = [
    { text: val, color: palette.line },
    { text: '  ·  ', color: palette.gridLabel },
    { text: time, color: palette.gridLabel },
  ];

  let totalW = 0;
  const widths: number[] = [];
  for (const p of parts) {
    const w = ctx.measureText(p.text).width;
    widths.push(w);
    totalW += w;
  }

  let tx = hoverX - totalW / 2;
  const minX = pad.left + 4;
  const maxX = layout.w - pad.right - totalW;
  if (tx < minX) tx = minX;
  if (tx > maxX) tx = maxX;
  const ty = pad.top + 24;

  ctx.strokeStyle = palette.tooltipBg;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  let lx = tx;
  for (let i = 0; i < parts.length; i++) {
    ctx.strokeText(parts[i]!.text, lx, ty);
    lx += widths[i]!;
  }

  lx = tx;
  for (let i = 0; i < parts.length; i++) {
    ctx.fillStyle = parts[i]!.color;
    ctx.fillText(parts[i]!.text, lx, ty);
    lx += widths[i]!;
  }

  ctx.restore();
}
