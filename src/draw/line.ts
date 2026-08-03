import { Skia } from '@shopify/react-native-skia';
import type { SkPath, SkColor } from '@shopify/react-native-skia';
import type { LivelinePalette, ChartLayout, LivelinePoint } from '../types';
import { drawSpline } from '../math/spline';
import { decimateMinMax } from '../math/decimate';
import { rgbColor } from '../math/color';
import {
  lineCacheHits,
  assembleLineTail,
  assembleLineTailStroke,
  updateLinePaths,
  type CachePath,
  type LineCacheRef,
} from './lineCache';
import type { Ctx2D, Style2D } from './canvas2d';
import {
  loadingY,
  loadingBreath,
  LOADING_AMPLITUDE_RATIO,
  LOADING_SCROLL_SPEED,
} from './loadingShape';

// Hoisted so setLineDash doesn't take a fresh array literal every frame —
// the shim stores this reference directly (see canvas2d.ts's setLineDash).
// Declared locally rather than imported from canvas2d.ts: that module pulls
// in the native Skia binding at import time, which some draw modules'
// dedicated unit tests (e.g. candlestick.test.ts) import without it loaded
// — a real (non-type) import from canvas2d.ts would drag Skia in and break
// those tests under Jest, which doesn't transform that package.
const DASH_4_4: number[] = [4, 4];
const EMPTY_DASH: number[] = [];

/**
 * Everything `drawLine` needs beyond the three long-lived objects every draw
 * module takes (`ctx`, `layout`, `palette`).
 *
 * **This is a pooled struct, not a per-call literal.** `drawLine` runs on the
 * UI thread 60–120×/sec and previously took these twelve values as positional
 * arguments — six of them consecutive numbers, silently transposable. Bundling
 * them fixes that, but only if the bundle itself isn't allocated per frame, so
 * exactly one instance lives on `EngineState` (`createLineDrawArgs`, mirroring
 * `multiSeriesEntryScratch`) and every call site overwrites the fields it
 * cares about in place. `drawLine` reads it synchronously and never retains
 * it, so a single instance is safe even across the multi-series loop, which
 * refills it once per series.
 *
 * New inputs go here as a field. That is the point: the previous shape made a
 * 16th positional parameter expensive enough that a pooled-scratch change was
 * reverted rather than pay for it.
 */
export interface LineDrawArgs {
  /** Visible points, oldest → newest. */
  visible: LivelinePoint[];
  /** Smoothed live value — drives the last point's Y and the live tip. */
  smoothValue: number;
  /** Engine's `Date.now()/1000` for this frame; the live tip's X. */
  now: number;
  /** Draw the gradient fill under the line. */
  showFill: boolean;
  /** Scrub cursor X in px, or null when not scrubbing. */
  scrubX: number | null;
  /** 0 = not scrubbing, 1 = fully scrubbing (lerped). */
  scrubAmount: number;
  /** 0 = loading squiggly, 1 = fully revealed data line. */
  chartReveal: number;
  /** `performance.now()` — drives the loading breath/scroll during reveal. */
  now_ms: number;
  /** Scales the accent-color mix; 0 forces the grey loading color. */
  colorBlend: number;
  /** Skip the dashed current-price line (candle mode draws its own). */
  skipDashLine: boolean;
  /** Extra multiplier on the fill's alpha (line↔candle morph). */
  fillScale: number;
  /** Cross-frame path cache; undefined disables caching for this call. */
  pathCache?: LineCacheRef;
}

/** Allocate one pooled `LineDrawArgs` (see the interface). Defaults match the
 * old positional-parameter defaults, so a caller only has to write the fields
 * it actually varies. */
export function createLineDrawArgs(): LineDrawArgs {
  'worklet';
  return {
    visible: [],
    smoothValue: 0,
    now: 0,
    showFill: false,
    scrubX: null,
    scrubAmount: 0,
    chartReveal: 1,
    now_ms: 0,
    colorBlend: 1,
    skipDashLine: false,
    fillScale: 1,
    pathCache: undefined,
  };
}

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

/**
 * Path factory for the line cache — SkPath satisfies CachePath structurally.
 * Exported so callers that assemble cache paths outside drawLine (the
 * declarative scroll layer, which records the prefix stroke into a picture
 * and strokes the tail live) allocate through the same factory.
 */
export function makeSkPath(): CachePath {
  'worklet';
  return Skia.Path.Make();
}

/**
 * Strokes an already-built cache path with the line's style. Factored out of
 * `renderCurvePaths` so the split prefix/tail strokes are painted with
 * byte-identical paint state to the combined path — there is exactly one
 * place the line's stroke style is written.
 *
 * Restores `ctx.globalAlpha` to what it was on entry, so it composes with a
 * caller that has already scaled alpha (e.g. the scrub dimming).
 */
export function strokeLinePath(
  ctx: Ctx2D,
  palette: LivelinePalette,
  stroke: CachePath,
  lineAlpha: number,
  strokeColor?: Style2D
) {
  'worklet';
  const baseAlpha = ctx.globalAlpha;
  ctx.globalAlpha = baseAlpha * lineAlpha;
  // Cache paths are always real SkPaths at runtime (built by makeSkPath);
  // CachePath is just the Skia-free structural type for testability.
  ctx.beginPathFrom(stroke as SkPath);
  ctx.strokeStyle = strokeColor ?? palette.line;
  ctx.lineWidth = palette.lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.globalAlpha = baseAlpha;
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
    ctx.globalAlpha = baseAlpha;
  }

  strokeLinePath(ctx, palette, stroke, lineAlpha, strokeColor);
}

/** Draw the fill gradient + stroke line for a set of points. */
function renderCurve(
  ctx: Ctx2D,
  layout: ChartLayout,
  palette: LivelinePalette,
  pts: [number, number][],
  /** Already folded together with the alpha test by the caller — see
   * `drawLine`'s `wantFill`. */
  wantFill: boolean,
  lineAlpha: number = 1,
  fillAlpha: number = 1,
  strokeColor?: Style2D
) {
  'worklet';
  const { h, pad } = layout;
  const baseAlpha = ctx.globalAlpha;

  if (wantFill && fillAlpha > 0.01) {
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
  /** The cache path to stroke, or null to rebuild the spline from `pts`.
   * Resolving "cache hit? which of the slot's three paths?" once in `drawLine`
   * — instead of re-deriving it from `cacheReady`/`cacheSlot`/`splitStroke` at
   * each of the three call sites — is what lets this take two paths instead of
   * four booleans. */
  stroke: CachePath | null,
  /** The cache fill path, or null for no fill / no cache. */
  fill: CachePath | null,
  pts: [number, number][],
  wantFill: boolean,
  lineAlpha: number,
  fillAlpha: number,
  strokeColor?: Style2D
) {
  'worklet';
  if (stroke !== null) {
    renderCurvePaths(
      ctx,
      layout,
      palette,
      stroke,
      fill,
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
      wantFill,
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
  /** Pooled per-frame inputs — see `LineDrawArgs`. Read synchronously and
   * never retained, so the caller may reuse one instance across calls. */
  a: LineDrawArgs
): [number, number][] | undefined {
  'worklet';
  const visible = a.visible;
  const smoothValue = a.smoothValue;
  const now = a.now;
  const scrubX = a.scrubX;
  const scrubAmount = a.scrubAmount;
  const chartReveal = a.chartReveal;
  const now_ms = a.now_ms;
  const pathCache = a.pathCache;
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

  // Reveal alphas: at reveal=0, line matches loading/empty brightness (shared breath).
  // As reveal increases, line ramps to full. Fill fades in with reveal.
  // Computed before the cache check below — wantFill only needs these, not
  // the point arrays — so a cache hit never waits on the point-array work.
  let lineAlpha = 1;
  let fillAlpha = a.fillScale;
  if (chartReveal < 1) {
    const breath = loadingBreath(now_ms);
    lineAlpha = breath + (1 - breath) * chartReveal;
    fillAlpha = chartReveal * a.fillScale;
  }
  const wantFill = a.showFill && fillAlpha > 0.01;

  // Blend line color: grey at reveal=0, accent by reveal≈0.3.
  // colorBlend scales the accent mix — 0 forces grey (used during reverse morph
  // so the line fades to the loading squiggly color instead of flashing blue).
  const colorT = Math.min(1, chartReveal * 3) * a.colorBlend;
  const strokeColor =
    chartReveal < 1 || a.colorBlend < 1
      ? blendColor(palette.gridLabel, palette.line, colorT)
      : undefined;

  const isScrubbing = scrubX !== null;
  const visLen = visible.length;

  // The caller's request to stroke only the tail (the scroll layer has already
  // composited the prefix). Read up here, before the cache branches, purely so
  // the assembly below can skip building the combined `scratch` path when
  // nothing will read it — see `assembleLineTail`. Only *honored* on frames
  // where the cache is actually in use, which is what `splitStroke` below adds.
  const wantSplitStroke = pathCache?.splitPrefixStroke === true;

  // Cross-frame path cache: the key/identity check runs FIRST, before any
  // per-frame array is built. On a hit, decimateMinMax and the O(decimated)
  // interior-points loop (in the miss branch below) are skipped entirely —
  // the spline interior is already baked into slot.prefix, so only the two
  // points that actually move frame to frame (the last data point re-Y'd to
  // smoothValue, and the live tip) are needed to assemble this frame's
  // stroke/fill paths. Falls back to the legacy immediate-mode path (decimate
  // + rebuild via updateLinePaths) on a miss, while the reveal morph is
  // active (its geometry depends on now_ms and can't be keyed), or when no
  // cache slot was provided. `lineCacheHits` is the exact predicate
  // updateLinePaths uses internally on the miss/legacy path below, so the
  // two checks can never drift apart.
  let pts: [number, number][];
  let cacheReady = false;

  if (
    pathCache !== undefined &&
    chartReveal >= 1 &&
    visLen > 0 &&
    lineCacheHits(pathCache, layout, visible)
  ) {
    const visLast = visible[visLen - 1]!;
    const lastX = toX(visLast.time);
    // Last data point and live tip share the same Y here: chartReveal >= 1
    // means morphY is the identity, and both use smoothValue (see the
    // legacy loop below) — so one calc covers what would be pts[N-1] and
    // pts[N].
    const tailY = clampY(toY(smoothValue));
    const tipX = toX(now);
    const firstY = wantFill ? clampY(toY(visible[0]!.value)) : 0;
    assembleLineTail(
      pathCache.slot,
      makeSkPath,
      layout,
      wantFill,
      lastX,
      tailY,
      tipX,
      tailY,
      firstY,
      wantSplitStroke
    );
    cacheReady = true;
    pts = [
      [lastX, tailY],
      [tipX, tailY],
    ];
  } else {
    // Cap points fed to the O(n) spline pass at ~2 per pixel of chartW.
    // No-op (same array, zero allocation) for normal sparse real-time density.
    // The absolute bucket grid (one bucket per pixel of the time window) keeps
    // the decimated selection stable as the window scrolls, so the path cache
    // below stays valid between data changes even in dense mode.
    const bucketSecs =
      (layout.rightEdge - layout.leftEdge) / Math.max(chartW, 1);
    const decimated = decimateMinMax(visible, chartW, bucketSecs);

    const built: [number, number][] = [];
    for (let i = 0; i < decimated.length; i++) {
      const p = decimated[i]!;
      const x = toX(p.time);
      const y =
        i === decimated.length - 1
          ? morphY(clampY(toY(smoothValue)), x)
          : morphY(clampY(toY(p.value)), x);
      built.push([x, y]);
    }
    // Tip X: at reveal=0 extends to full chart width (matching loading/empty line),
    // at reveal=1 sits at the live dot position. Smooth morph between.
    const liveTipX = toX(now);
    const fullRightX = pad.left + chartW;
    const tipX =
      chartReveal < 1
        ? liveTipX + (fullRightX - liveTipX) * (1 - chartReveal)
        : liveTipX;
    built.push([tipX, morphY(clampY(toY(smoothValue)), tipX)]);

    if (built.length < 2) return undefined;
    pts = built;

    cacheReady =
      pathCache !== undefined &&
      chartReveal >= 1 &&
      updateLinePaths(
        pathCache,
        makeSkPath,
        layout,
        decimated,
        pts,
        wantFill,
        visible
      );
  }

  // Declarative scroll layer: the caller has already composited the prefix
  // stroke from a picture, so stroke only the tail here — drawing the prefix
  // again would double-stroke an antialiased line over itself. Honored only
  // when the cache is actually in use: the immediate-mode fallback rebuilds
  // the whole spline and has no separable prefix.
  //
  // The last two entries of `pts` are the tail's two moving points in both
  // branches above — [lastX, tailY], [tipX, tailY] on a hit, and
  // pts[N-1], pts[N] on a rebuild — which is exactly what
  // `assembleLineTail` was handed, so the tail-only path joins the
  // translated prefix at the identical point with the identical tangent.
  const splitStroke = cacheReady && wantSplitStroke;
  if (splitStroke) {
    const n = pts.length;
    assembleLineTailStroke(
      pathCache!.slot,
      makeSkPath,
      layout,
      pts[n - 2]![0],
      pts[n - 2]![1],
      pts[n - 1]![0],
      pts[n - 1]![1]
    );
  }

  // Which paths this frame's strokes read, resolved once. All three
  // paintLineCurve calls below are the same drawing with different clips and
  // alpha, so the source selection can't differ between them — hoisting it
  // makes that structural rather than a convention three argument lists have
  // to keep agreeing on.
  const slot = cacheReady ? pathCache?.slot : undefined;
  const strokePath =
    slot === undefined ? null : splitStroke ? slot.tailScratch! : slot.scratch!;
  const fillPath = slot === undefined || !wantFill ? null : slot.fillScratch;

  // Clip line + fill to chart area — during big value jumps the range
  // lerps smoothly so the line may extend beyond the chart bounds.
  // Clipping keeps it tidy while the range catches up.
  ctx.save();
  ctx.clipRect(pad.left - 1, pad.top, chartW + 2, chartH);

  if (isScrubbing) {
    // Full-opacity portion: clipped to LEFT of scrub point
    ctx.save();
    ctx.clipRect(0, 0, scrubX!, h);
    paintLineCurve(
      ctx,
      layout,
      palette,
      strokePath,
      fillPath,
      pts,
      wantFill,
      lineAlpha,
      fillAlpha,
      strokeColor
    );
    ctx.restore();

    // Dimmed portion: clipped to RIGHT of scrub point
    ctx.save();
    ctx.clipRect(scrubX!, 0, layout.w - scrubX!, h);
    ctx.globalAlpha = incomingAlpha * (1 - scrubAmount * 0.6);
    paintLineCurve(
      ctx,
      layout,
      palette,
      strokePath,
      fillPath,
      pts,
      wantFill,
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
      strokePath,
      fillPath,
      pts,
      wantFill,
      lineAlpha,
      fillAlpha,
      strokeColor
    );
  }

  // Restore from chart-area clip
  ctx.restore();

  // Dashed current-price line — morphs from center during reveal (fades in late,
  // so the center-vs-squiggly difference is imperceptible by the time it's visible)
  if (!a.skipDashLine) {
    const realCurrentY = Math.max(
      pad.top,
      Math.min(h - pad.bottom, toY(smoothValue))
    );
    const currentY =
      chartReveal < 1
        ? centerY + (realCurrentY - centerY) * chartReveal
        : realCurrentY;
    ctx.setLineDash(DASH_4_4);
    ctx.strokeStyle = palette.dashLine;
    ctx.lineWidth = 1;
    const dashBase = isScrubbing ? 1 - scrubAmount * 0.2 : 1;
    ctx.globalAlpha =
      incomingAlpha * (chartReveal < 1 ? dashBase * chartReveal : dashBase);
    ctx.beginPath();
    ctx.moveTo(pad.left, currentY);
    ctx.lineTo(layout.w - pad.right, currentY);
    ctx.stroke();
    ctx.setLineDash(EMPTY_DASH);
  }
  ctx.globalAlpha = incomingAlpha;

  // Clamp last point Y so dot stays within canvas (not chart area).
  // The dot outer circle is 6.5px + shadow — 10px margin keeps it visible.
  const last = pts[pts.length - 1]!;
  last[1] = Math.max(10, Math.min(h - 10, last[1]));

  return pts;
}
