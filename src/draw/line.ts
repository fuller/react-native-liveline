import { Skia } from '@shopify/react-native-skia';
import type { SkPath, SkColor } from '@shopify/react-native-skia';
import type { LivelinePalette, ChartLayout, LivelinePoint } from '../types';
import { drawSpline } from '../math/spline';
import { decimateMinMax } from '../math/decimate';
import { rgbColor } from '../math/color';
import {
  updateLinePaths,
  type CachePath,
  type LineCacheRef,
  type LineCacheSlot,
} from './lineCache';
import type { Ctx2D, Style2D } from './canvas2d';
import {
  loadingY,
  loadingBreath,
  LOADING_AMPLITUDE_RATIO,
  LOADING_SCROLL_SPEED,
} from './loadingShape';

/** Parse a CSS color to [r, g, b, a]. Handles hex, rgb(), rgba(). */
function parseRgba(color: string): [number, number, number, number] {
  'worklet';
  const hex = color.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
      1,
    ];
  }
  const rgba = color.match(
    /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)/
  );
  if (rgba) return [+rgba[1]!, +rgba[2]!, +rgba[3]!, +rgba[4]!];
  const rgb = color.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return [+rgb[1]!, +rgb[2]!, +rgb[3]!, 1];
  return [128, 128, 128, 1];
}

/** Lerp between two CSS colors including alpha. Handles hex, rgb(), rgba(). */
function blendColor(c1: string, c2: string, t: number): SkColor {
  'worklet';
  const [r1, g1, b1, a1] = parseRgba(c1);
  if (t <= 0) return rgbColor(r1, g1, b1, a1);
  const [r2, g2, b2, a2] = parseRgba(c2);
  if (t >= 1) return rgbColor(r2, g2, b2, a2);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  const a = a1 + (a2 - a1) * t;
  return rgbColor(r, g, b, a);
}

/** Path factory for the line cache — SkPath satisfies CachePath structurally. */
function makeSkPath(): CachePath {
  'worklet';
  return Skia.Path.Make();
}

/**
 * Draw the fill gradient + stroke line from pre-assembled cache paths.
 * Style handling mirrors renderCurve exactly; only the path source differs
 * (adopted via beginPathFrom instead of rebuilt through the shim).
 */
function renderCurvePaths(
  ctx: Ctx2D,
  layout: ChartLayout,
  palette: LivelinePalette,
  stroke: CachePath,
  fill: CachePath | null,
  lineAlpha: number,
  fillAlpha: number,
  strokeColor?: Style2D
) {
  'worklet';
  const { h, pad } = layout;
  const baseAlpha = ctx.globalAlpha;

  if (fill !== null && fillAlpha > 0.01) {
    ctx.globalAlpha = baseAlpha * fillAlpha;
    const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
    grad.addColorStop(0, palette.fillTop);
    grad.addColorStop(1, palette.fillBottom);
    // Cache paths are always real SkPaths at runtime (built by makeSkPath);
    // CachePath is just the Skia-free structural type for testability.
    ctx.beginPathFrom(fill as SkPath);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  ctx.globalAlpha = baseAlpha * lineAlpha;
  ctx.beginPathFrom(stroke as SkPath);
  ctx.strokeStyle = strokeColor ?? palette.line;
  ctx.lineWidth = palette.lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.globalAlpha = baseAlpha;
}

/** Draw the fill gradient + stroke line for a set of points. */
function renderCurve(
  ctx: Ctx2D,
  layout: ChartLayout,
  palette: LivelinePalette,
  pts: [number, number][],
  showFill: boolean,
  lineAlpha: number = 1,
  fillAlpha: number = 1,
  strokeColor?: Style2D
) {
  'worklet';
  const { h, pad } = layout;
  const baseAlpha = ctx.globalAlpha;

  if (showFill && fillAlpha > 0.01) {
    ctx.globalAlpha = baseAlpha * fillAlpha;
    const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
    grad.addColorStop(0, palette.fillTop);
    grad.addColorStop(1, palette.fillBottom);
    ctx.beginPath();
    ctx.moveTo(pts[0]![0], h - pad.bottom);
    ctx.lineTo(pts[0]![0], pts[0]![1]);
    drawSpline(ctx, pts);
    ctx.lineTo(pts[pts.length - 1]![0], h - pad.bottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  ctx.globalAlpha = baseAlpha * lineAlpha;
  ctx.beginPath();
  ctx.moveTo(pts[0]![0], pts[0]![1]);
  drawSpline(ctx, pts);
  ctx.strokeStyle = strokeColor ?? palette.line;
  ctx.lineWidth = palette.lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.globalAlpha = baseAlpha;
}

/**
 * Draws either the cached paths (cache hit) or falls back to rebuilding the
 * spline immediate-mode (cache miss/disabled). A plain module-scope worklet
 * rather than a closure captured inside drawLine — this is called up to
 * twice per frame while scrubbing, and a closure would be a fresh function
 * allocation on every drawLine call even in the common non-scrubbing case.
 */
function paintLineCurve(
  ctx: Ctx2D,
  layout: ChartLayout,
  palette: LivelinePalette,
  cacheReady: boolean,
  cacheSlot: LineCacheSlot | undefined,
  wantFill: boolean,
  pts: [number, number][],
  showFill: boolean,
  lineAlpha: number,
  fillAlpha: number,
  strokeColor?: Style2D
) {
  'worklet';
  if (cacheReady && cacheSlot !== undefined) {
    renderCurvePaths(
      ctx,
      layout,
      palette,
      cacheSlot.scratch!,
      wantFill ? cacheSlot.fillScratch : null,
      lineAlpha,
      fillAlpha,
      strokeColor
    );
  } else {
    renderCurve(
      ctx,
      layout,
      palette,
      pts,
      showFill,
      lineAlpha,
      fillAlpha,
      strokeColor
    );
  }
}

export function drawLine(
  ctx: Ctx2D,
  layout: ChartLayout,
  palette: LivelinePalette,
  visible: LivelinePoint[],
  smoothValue: number,
  now: number,
  showFill: boolean,
  scrubX: number | null,
  scrubAmount: number = 0,
  chartReveal: number = 1,
  now_ms: number = 0,
  colorBlend: number = 1,
  skipDashLine: boolean = false,
  fillScale: number = 1,
  pathCache?: LineCacheRef
): [number, number][] | undefined {
  'worklet';
  const { h, pad, toX, toY, chartW, chartH } = layout;
  const incomingAlpha = ctx.globalAlpha;

  // Build screen-space points: all historical data stays stable,
  // but the LAST data point uses smoothValue for its Y (so big jumps
  // animate smoothly instead of snapping). Its X stays at the original
  // data time (stable, no per-frame drift — this is what killed jitter).
  // Then append the live tip at (now, smoothValue).
  // Y coordinates are clamped to chart bounds so the line hugs the edge
  // during range transitions instead of getting hard-clipped.
  const yMin = pad.top;
  const yMax = h - pad.bottom;
  const clampY = (y: number) => Math.max(yMin, Math.min(yMax, y));

  // During reveal, morph Y positions from the loading squiggly shape toward real data.
  // At chartReveal=0 the chart line traces the exact same squiggly as drawLoading/drawEmpty.
  // Center-out: the center of the chart resolves first, edges last, so the data
  // line appears to bloom outward from the middle.
  const centerY = pad.top + chartH / 2;
  const amplitude = chartH * LOADING_AMPLITUDE_RATIO;
  const scroll = now_ms * LOADING_SCROLL_SPEED;
  const morphY =
    chartReveal < 1
      ? (rawY: number, x: number) => {
          const t = Math.max(0, Math.min(1, (x - pad.left) / chartW));
          const centerDist = Math.abs(t - 0.5) * 2; // 0 at center, 1 at edges
          const localReveal = Math.max(
            0,
            Math.min(1, (chartReveal - centerDist * 0.4) / 0.6)
          );
          const baseY = loadingY(t, centerY, amplitude, scroll);
          return baseY + (rawY - baseY) * localReveal;
        }
      : (rawY: number, _x: number) => rawY;

  // Cap points fed to the O(n) spline pass at ~2 per pixel of chartW.
  // No-op (same array, zero allocation) for normal sparse real-time density.
  // The absolute bucket grid (one bucket per pixel of the time window) keeps
  // the decimated selection stable as the window scrolls, so the path cache
  // below stays valid between data changes even in dense mode.
  const bucketSecs = (layout.rightEdge - layout.leftEdge) / Math.max(chartW, 1);
  const decimated = decimateMinMax(visible, chartW, bucketSecs);

  const pts: [number, number][] = [];
  for (let i = 0; i < decimated.length; i++) {
    const p = decimated[i]!;
    const x = toX(p.time);
    const y =
      i === decimated.length - 1
        ? morphY(clampY(toY(smoothValue)), x)
        : morphY(clampY(toY(p.value)), x);
    pts.push([x, y]);
  }
  // Tip X: at reveal=0 extends to full chart width (matching loading/empty line),
  // at reveal=1 sits at the live dot position. Smooth morph between.
  const liveTipX = toX(now);
  const fullRightX = pad.left + chartW;
  const tipX =
    chartReveal < 1
      ? liveTipX + (fullRightX - liveTipX) * (1 - chartReveal)
      : liveTipX;
  pts.push([tipX, morphY(clampY(toY(smoothValue)), tipX)]);

  if (pts.length < 2) return undefined;

  // Reveal alphas: at reveal=0, line matches loading/empty brightness (shared breath).
  // As reveal increases, line ramps to full. Fill fades in with reveal.
  let lineAlpha = 1;
  let fillAlpha = fillScale;
  if (chartReveal < 1) {
    const breath = loadingBreath(now_ms);
    lineAlpha = breath + (1 - breath) * chartReveal;
    fillAlpha = chartReveal * fillScale;
  }

  // Blend line color: grey at reveal=0, accent by reveal≈0.3.
  // colorBlend scales the accent mix — 0 forces grey (used during reverse morph
  // so the line fades to the loading squiggly color instead of flashing blue).
  const colorT = Math.min(1, chartReveal * 3) * colorBlend;
  const strokeColor =
    chartReveal < 1 || colorBlend < 1
      ? blendColor(palette.gridLabel, palette.line, colorT)
      : undefined;

  const isScrubbing = scrubX !== null;

  // Cross-frame path cache: when the caller provided a slot and the reveal
  // morph is settled (morph geometry depends on now_ms and can't be keyed),
  // assemble this frame's stroke/fill paths from the cached prefix — a few
  // native calls on a hit instead of a full spline rebuild. Falls back to
  // the legacy immediate-mode renderCurve otherwise. Assembled once here,
  // then drawn under one or two clips below (scrub never reshapes geometry).
  const wantFill = showFill && fillAlpha > 0.01;
  const cacheReady =
    pathCache !== undefined &&
    chartReveal >= 1 &&
    updateLinePaths(
      pathCache.slot,
      makeSkPath,
      layout,
      decimated,
      pts,
      wantFill,
      pathCache.dataRev,
      pathCache.dataSource,
      visible.length,
      visible[0]!.time,
      visible[visible.length - 1]!.time,
      visible[visible.length - 1]!.value
    );

  // Clip line + fill to chart area — during big value jumps the range
  // lerps smoothly so the line may extend beyond the chart bounds.
  // Clipping keeps it tidy while the range catches up.
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.left - 1, pad.top, chartW + 2, chartH);
  ctx.clip();

  if (isScrubbing) {
    // Full-opacity portion: clipped to LEFT of scrub point
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, scrubX!, h);
    ctx.clip();
    paintLineCurve(
      ctx,
      layout,
      palette,
      cacheReady,
      pathCache?.slot,
      wantFill,
      pts,
      showFill,
      lineAlpha,
      fillAlpha,
      strokeColor
    );
    ctx.restore();

    // Dimmed portion: clipped to RIGHT of scrub point
    ctx.save();
    ctx.beginPath();
    ctx.rect(scrubX!, 0, layout.w - scrubX!, h);
    ctx.clip();
    ctx.globalAlpha = incomingAlpha * (1 - scrubAmount * 0.6);
    paintLineCurve(
      ctx,
      layout,
      palette,
      cacheReady,
      pathCache?.slot,
      wantFill,
      pts,
      showFill,
      lineAlpha,
      fillAlpha,
      strokeColor
    );
    ctx.restore();
  } else {
    paintLineCurve(
      ctx,
      layout,
      palette,
      cacheReady,
      pathCache?.slot,
      wantFill,
      pts,
      showFill,
      lineAlpha,
      fillAlpha,
      strokeColor
    );
  }

  // Restore from chart-area clip
  ctx.restore();

  // Dashed current-price line — morphs from center during reveal (fades in late,
  // so the center-vs-squiggly difference is imperceptible by the time it's visible)
  if (!skipDashLine) {
    const realCurrentY = Math.max(
      pad.top,
      Math.min(h - pad.bottom, toY(smoothValue))
    );
    const currentY =
      chartReveal < 1
        ? centerY + (realCurrentY - centerY) * chartReveal
        : realCurrentY;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = palette.dashLine;
    ctx.lineWidth = 1;
    const dashBase = isScrubbing ? 1 - scrubAmount * 0.2 : 1;
    ctx.globalAlpha =
      incomingAlpha * (chartReveal < 1 ? dashBase * chartReveal : dashBase);
    ctx.beginPath();
    ctx.moveTo(pad.left, currentY);
    ctx.lineTo(layout.w - pad.right, currentY);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = incomingAlpha;

  // Clamp last point Y so dot stays within canvas (not chart area).
  // The dot outer circle is 6.5px + shadow — 10px margin keeps it visible.
  const last = pts[pts.length - 1]!;
  last[1] = Math.max(10, Math.min(h - 10, last[1]));

  return pts;
}
