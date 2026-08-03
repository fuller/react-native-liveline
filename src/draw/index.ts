import type {
  LivelinePalette,
  ChartLayout,
  LivelinePoint,
  Momentum,
  ReferenceLine,
  OrderbookData,
  DegenOptions,
  CandlePoint,
} from '../types';
import { Skia, type SkPicture } from '@shopify/react-native-skia';
import type { Ctx2D } from './canvas2d';
import { drawGrid, type GridState } from './grid';
import type { GridLayerSlot } from './gridLayer';
import { drawLine, type LineDrawArgs } from './line';
import { lineOverlayPresence, LINE_OVERLAY_MIN_PRESENCE } from './lineOverlay';
import {
  createLineCacheSlot,
  type LineCacheRef,
  type LineCacheSlot,
} from './lineCache';
import type { CandleCacheRef, CachePath } from './candleCache';
import { drawDot, drawArrows, drawSimpleDot, drawMultiDot } from './dot';
import { drawCrosshair, drawMultiCrosshair } from './crosshair';
import type { MultiSeriesHoverEntry } from './crosshair';
import { drawReferenceLine } from './referenceLine';
import { drawTimeAxis, type TimeAxisState } from './timeAxis';
import { drawOrderbook, type OrderbookState } from './orderbook';
import { drawParticles, spawnOnSwing, type ParticleState } from './particles';
import {
  drawCandlesticks,
  type CandleDrawArgs,
  drawClosePrice,
  drawCandleCrosshair,
  drawLineModeCrosshair,
} from './candlestick';
import { drawEmpty } from './empty';
import { smoothstepRamp } from '../math/ramp';

/** Real SkPath factory for the candle cache — SkPath satisfies CachePath
 * structurally (mirrors line.ts's own makeSkPath). Lives here rather than in
 * candlestick.ts because candlestick.ts is exercised directly by
 * candlestick.test.ts under jest, which can't parse the Skia package's ESM
 * build; this module is never imported by a test, same as line.ts. */
function makeCandlePath(): CachePath {
  'worklet';
  return Skia.Path.Make();
}

// Constants
const SHAKE_DECAY_RATE = 0.002;
const SHAKE_MIN_AMPLITUDE = 0.2;
export const FADE_EDGE_WIDTH = 40;
const CROSSHAIR_FADE_MIN_PX = 5;
// Fade zone caps out at 80px, or 30% of chart width for narrow charts —
// whichever is smaller.
const SCRUB_FADE_MAX_PX = 80;
const SCRUB_FADE_WIDTH_FRACTION = 0.3;
// Hoisted so setLineDash doesn't take a fresh array literal every frame —
// the shim stores this reference directly (see canvas2d.ts's setLineDash).
// Declared locally rather than imported from canvas2d.ts: that module pulls
// in the native Skia binding at import time, and some draw modules'
// dedicated unit tests (e.g. candlestick.test.ts) import their module
// directly without it loaded — kept local here too for consistency.
const DASH_4_4: number[] = [4, 4];
const EMPTY_DASH: number[] = [];

/**
 * Shared scrub-fade opacity curve: 0 right next to the live dot/edge, ramps
 * linearly up to `scrubAmount` over the fade zone, and holds at
 * `scrubAmount` beyond it. Used by every element that fades out as the
 * scrub crosshair approaches the live point — the dot, the single-series
 * crosshair, and the multi-series crosshair — so a future tweak to the fade
 * zone (the 80px cap or the 30%-of-width fraction) can't desync one of them
 * from the others.
 */
function scrubFadeOpacity(
  distToLive: number,
  scrubAmount: number,
  chartW: number
): number {
  'worklet';
  const fadeStart = Math.min(
    SCRUB_FADE_MAX_PX,
    chartW * SCRUB_FADE_WIDTH_FRACTION
  );
  return distToLive < CROSSHAIR_FADE_MIN_PX
    ? 0
    : distToLive >= fadeStart
      ? scrubAmount
      : ((distToLive - CROSSHAIR_FADE_MIN_PX) /
          (fadeStart - CROSSHAIR_FADE_MIN_PX)) *
        scrubAmount;
}

export interface ArrowState {
  up: number;
  down: number;
}

export interface ShakeState {
  amplitude: number; // current shake magnitude in px, decays each frame
}

export function createShakeState(): ShakeState {
  'worklet';
  return { amplitude: 0 };
}

/**
 * Left-edge fade — erases a gradient strip at the chart's left padding edge
 * via `destination-out`, so data scrolling in from offscreen fades in
 * rather than popping in with a hard vertical cut. Shared by `drawFrame`,
 * `drawMultiFrame`, `drawCandleFrame` (all three below), and by
 * `engine/step.ts`'s loading/empty early-return paths — a single
 * implementation so the gradient stops and fillRect bounds can't drift
 * between the four call sites.
 */
export function drawEdgeFade(ctx: Ctx2D, padLeft: number, h: number): void {
  'worklet';
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  const fadeGrad = ctx.createLinearGradient(
    padLeft,
    0,
    padLeft + FADE_EDGE_WIDTH,
    0
  );
  fadeGrad.addColorStop(0, 'rgba(0, 0, 0, 1)');
  fadeGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = fadeGrad;
  ctx.fillRect(0, 0, padLeft + FADE_EDGE_WIDTH, h);
  ctx.restore();
}

export interface DrawOptions {
  visible: LivelinePoint[];
  smoothValue: number;
  now: number; // engine's Date.now()/1000, single timestamp for the frame
  momentum: Momentum;
  arrowState: ArrowState;
  showGrid: boolean;
  showMomentum: boolean;
  showPulse: boolean;
  showFill: boolean;
  referenceLine?: ReferenceLine;
  hoverX: number | null;
  hoverValue: number | null;
  hoverTime: number | null;
  scrubAmount: number; // 0 = not scrubbing, 1 = fully scrubbing (lerped)
  windowSecs: number;
  formatValue: (v: number) => string;
  formatTime: (t: number) => string;
  gridState: GridState;
  timeAxisState: TimeAxisState;
  dt: number; // delta time in ms for frame-rate-independent lerps
  targetWindowSecs: number; // final target window (stable during transitions)
  tooltipY: number;
  tooltipOutline: boolean;
  orderbookData?: OrderbookData;
  orderbookState?: OrderbookState;
  particleState?: ParticleState;
  particleOptions?: DegenOptions;
  swingMagnitude: number;
  shakeState?: ShakeState;
  chartReveal: number; // 0 = loading/morphing from center, 1 = fully revealed
  pauseProgress: number; // 0 = playing, 1 = fully paused
  now_ms: number; // performance.now() for breathing animation timing
  /** Cross-frame line path cache (see draw/lineCache) */
  lineCache?: LineCacheRef;
  /** Cross-frame grid picture cache (see draw/gridLayer, engine/gridLayer) */
  gridLayer?: GridLayerSlot<SkPicture>;
  /** Pooled scratch struct this frame's `drawLine` call is filled into —
   * owned by `EngineState`, never allocated here. See `LineDrawArgs`. */
  lineArgs: LineDrawArgs;
}

/**
 * Master draw function — calls each draw module in order.
 * Mutates arrowState in place.
 */
export function drawFrame(
  ctx: Ctx2D,
  layout: ChartLayout,
  palette: LivelinePalette,
  opts: DrawOptions
): void {
  'worklet';
  // 0. Chart shake — apply offset, decay amplitude
  const shake = opts.shakeState;
  let shakeX = 0;
  let shakeY = 0;
  if (shake && shake.amplitude > SHAKE_MIN_AMPLITUDE) {
    shakeX = (Math.random() - 0.5) * 2 * shake.amplitude;
    shakeY = (Math.random() - 0.5) * 2 * shake.amplitude;
    ctx.save();
    ctx.translate(shakeX, shakeY);
  }
  if (shake) {
    // Exponential decay — ~200ms of visible shake
    const decayRate = Math.pow(SHAKE_DECAY_RATE, opts.dt / 1000);
    shake.amplitude *= decayRate;
    if (shake.amplitude < SHAKE_MIN_AMPLITUDE) shake.amplitude = 0;
  }

  const reveal = opts.chartReveal;
  const pause = opts.pauseProgress;

  // 1. Reference line (behind everything) — fades with reveal
  if (opts.referenceLine && reveal > 0.01) {
    ctx.save();
    if (reveal < 1) ctx.globalAlpha = reveal;
    drawReferenceLine(ctx, layout, palette, opts.referenceLine);
    ctx.restore();
  }

  // 2. Grid — fades in delayed (15%–70% of reveal)
  if (opts.showGrid) {
    const gridAlpha = reveal < 1 ? smoothstepRamp(reveal, 0.15, 0.7) : 1;
    if (gridAlpha > 0.01) {
      ctx.save();
      if (opts.gridLayer?.picture && reveal >= 1) {
        ctx.drawPicture(opts.gridLayer.picture);
      } else {
        if (gridAlpha < 1) ctx.globalAlpha = gridAlpha;
        drawGrid(
          ctx,
          layout,
          palette,
          opts.formatValue,
          opts.gridState,
          opts.dt
        );
      }
      ctx.restore();
    }
  }

  // 2b. Orderbook (behind line) — fades with reveal
  if (opts.orderbookData && opts.orderbookState && reveal > 0.01) {
    ctx.save();
    if (reveal < 1) ctx.globalAlpha = reveal;
    drawOrderbook(
      ctx,
      layout,
      palette,
      opts.orderbookData,
      opts.dt,
      opts.orderbookState,
      opts.swingMagnitude
    );
    ctx.restore();
  }

  // 3. Line + fill (with scrub dimming + reveal morphing)
  const scrubX = opts.scrubAmount > 0.05 ? opts.hoverX : null;
  const lineArgs = opts.lineArgs;
  lineArgs.visible = opts.visible;
  lineArgs.smoothValue = opts.smoothValue;
  lineArgs.now = opts.now;
  lineArgs.showFill = opts.showFill;
  lineArgs.scrubX = scrubX;
  lineArgs.scrubAmount = opts.scrubAmount;
  lineArgs.chartReveal = reveal;
  lineArgs.now_ms = opts.now_ms;
  lineArgs.colorBlend = 1;
  lineArgs.skipDashLine = false;
  lineArgs.fillScale = 1;
  lineArgs.pathCache = opts.lineCache;
  const pts = drawLine(ctx, layout, palette, lineArgs);

  // 4. Time axis — same timing as grid
  {
    const timeAlpha = reveal < 1 ? smoothstepRamp(reveal, 0.15, 0.7) : 1;
    if (timeAlpha > 0.01) {
      ctx.save();
      if (timeAlpha < 1) ctx.globalAlpha = timeAlpha;
      drawTimeAxis(
        ctx,
        layout,
        palette,
        opts.windowSecs,
        opts.targetWindowSecs,
        opts.formatTime,
        opts.timeAxisState,
        opts.dt
      );
      ctx.restore();
    }
  }

  if (pts && pts.length > 0) {
    const lastPt = pts[pts.length - 1]!;

    // 5. Dot — dims during scrub, fades in with reveal (0.3 → 1.0)
    let dotScrub = opts.scrubAmount;
    if (opts.hoverX !== null && dotScrub > 0) {
      const distToLive = lastPt[0] - opts.hoverX;
      dotScrub = scrubFadeOpacity(distToLive, opts.scrubAmount, layout.chartW);
    }

    // Dot appears once shape is recognizable (reveal > 0.3)
    const dotAlpha = reveal < 0.3 ? 0 : (reveal - 0.3) / 0.7;
    const showPulse = opts.showPulse && reveal > 0.6 && pause < 0.5;
    if (dotAlpha > 0.01) {
      ctx.save();
      if (dotAlpha < 1) ctx.globalAlpha = dotAlpha;
      drawDot(
        ctx,
        lastPt[0],
        lastPt[1],
        palette,
        showPulse,
        dotScrub,
        opts.now_ms
      );
      ctx.restore();
    }

    // 5b. Arrows — appear late in reveal (60%+), fade with pause
    if (opts.showMomentum) {
      const arrowReveal = reveal < 1 ? smoothstepRamp(reveal, 0.6, 1) : 1;
      const arrowAlpha = arrowReveal * (1 - pause);
      if (arrowAlpha > 0.01) {
        ctx.save();
        if (arrowAlpha < 1) ctx.globalAlpha = arrowAlpha;
        drawArrows(
          ctx,
          lastPt[0],
          lastPt[1],
          opts.momentum,
          palette,
          opts.arrowState,
          opts.dt,
          opts.now_ms
        );
        ctx.restore();
      }
    }

    // 6. Particles — only when fully revealed
    if (opts.particleState && reveal > 0.9) {
      const burstIntensity = spawnOnSwing(
        opts.particleState,
        opts.momentum,
        lastPt[0],
        lastPt[1],
        opts.swingMagnitude,
        palette.line,
        opts.dt,
        opts.particleOptions
      );
      if (burstIntensity > 0 && shake) {
        shake.amplitude = (3 + opts.swingMagnitude * 4) * burstIntensity;
      }
      drawParticles(ctx, opts.particleState, opts.dt);
    }
  }

  // 7. Left edge fade — gradient erase
  drawEdgeFade(ctx, layout.pad.left, layout.h);

  // 8. Crosshair — fade out well before reaching live dot
  if (
    opts.hoverX !== null &&
    opts.hoverValue !== null &&
    opts.hoverTime !== null &&
    pts &&
    pts.length > 0
  ) {
    const lastPt = pts[pts.length - 1]!;
    const distToLive = lastPt[0] - opts.hoverX;
    const scrubOpacity = scrubFadeOpacity(
      distToLive,
      opts.scrubAmount,
      layout.chartW
    );

    if (scrubOpacity > 0.01) {
      drawCrosshair(
        ctx,
        layout,
        palette,
        opts.hoverX,
        opts.hoverValue,
        opts.hoverTime,
        opts.formatValue,
        opts.formatTime,
        scrubOpacity,
        opts.tooltipY,
        lastPt[0], // liveDotX — tooltip right edge stops here
        opts.tooltipOutline
      );
    }
  }

  // Restore shake translate
  if (shake && (shakeX !== 0 || shakeY !== 0)) {
    ctx.restore();
  }
}

// ─── Multi-series draw orchestration ──────────────────────────────────────

export interface MultiSeriesEntry {
  id: string;
  visible: LivelinePoint[];
  smoothValue: number;
  palette: LivelinePalette;
  label?: string;
  alpha?: number; // series visibility alpha (0 = hidden, 1 = visible)
  /** Per-series data revision for this series' line cache key — see
   * EngineConfigStep.multiRevs. 0 when unavailable, which degrades to the
   * old value-heuristic-only behavior rather than breaking. */
  dataRev: number;
}

export interface MultiSeriesDrawOptions {
  series: MultiSeriesEntry[];
  now: number;
  showGrid: boolean;
  showPulse: boolean;
  referenceLine?: ReferenceLine;
  hoverX: number | null;
  hoverTime: number | null;
  hoverEntries: MultiSeriesHoverEntry[];
  scrubAmount: number;
  windowSecs: number;
  formatValue: (v: number) => string;
  formatTime: (t: number) => string;
  gridState: GridState;
  timeAxisState: TimeAxisState;
  dt: number;
  targetWindowSecs: number;
  tooltipY: number;
  tooltipOutline: boolean;
  chartReveal: number;
  pauseProgress: number;
  now_ms: number;
  /** Primary palette (from first series) for grid/axis/crosshair colors */
  primaryPalette: LivelinePalette;
  /** Per-series line path caches, keyed by series id (see draw/lineCache) */
  lineCaches?: Map<string, LineCacheSlot>;
  /** Which backing arrays series data came from: 0 live / 1 paused / 2 stash */
  multiDataSource?: number;
  /** Cross-frame grid picture cache (see draw/gridLayer, engine/gridLayer) */
  gridLayer?: GridLayerSlot<SkPicture>;
  /** Pooled scratch struct the per-series `drawLine` calls are filled into —
   * owned by `EngineState`, refilled once per series, never allocated here.
   * See `LineDrawArgs`. */
  lineArgs: LineDrawArgs;
  /** Pooled `LineCacheRef` for the per-series cache lookup, same deal — its
   * `slot` is repointed each iteration instead of allocating a ref per
   * series per frame. Omit to disable the per-series cache entirely. */
  lineCacheRef?: LineCacheRef;
}

/**
 * Multi-series draw function — draws multiple overlapping lines sharing the same axes.
 * No fill, no momentum arrows, no badge (those are per-chart concerns handled by the engine).
 */
export function drawMultiFrame(
  ctx: Ctx2D,
  layout: ChartLayout,
  opts: MultiSeriesDrawOptions
): void {
  'worklet';
  const palette = opts.primaryPalette;
  const reveal = opts.chartReveal;

  // 1. Reference line
  if (opts.referenceLine && reveal > 0.01) {
    ctx.save();
    if (reveal < 1) ctx.globalAlpha = reveal;
    drawReferenceLine(ctx, layout, palette, opts.referenceLine);
    ctx.restore();
  }

  // 2. Grid
  if (opts.showGrid) {
    const gridAlpha = reveal < 1 ? smoothstepRamp(reveal, 0.15, 0.7) : 1;
    if (gridAlpha > 0.01) {
      ctx.save();
      if (opts.gridLayer?.picture && reveal >= 1) {
        ctx.drawPicture(opts.gridLayer.picture);
      } else {
        if (gridAlpha < 1) ctx.globalAlpha = gridAlpha;
        drawGrid(
          ctx,
          layout,
          palette,
          opts.formatValue,
          opts.gridState,
          opts.dt
        );
      }
      ctx.restore();
    }
  }

  // 3. Draw each series line (back to front, no fill, with scrub dimming)
  // During reverse morph, secondary lines fade out so only one remains at
  // chartReveal=0 — prevents alpha compounding from multiple overlapping strokes
  // looking brighter than the single standalone loading squiggly.
  const scrubX = opts.scrubAmount > 0.05 ? opts.hoverX : null;
  const allPts: {
    pts: [number, number][];
    palette: LivelinePalette;
    label?: string;
    alpha: number;
  }[] = [];
  for (let si = 0; si < opts.series.length; si++) {
    const s = opts.series[si]!;
    const seriesAlpha = s.alpha ?? 1;
    const secondaryFade = si > 0 && reveal < 1 ? Math.min(1, reveal * 2) : 1;
    const combinedAlpha = secondaryFade * seriesAlpha;
    if (combinedAlpha < 0.01) continue;
    // Per-series path cache slot, created on demand. `s.dataRev` is that
    // series' own revision counter (see EngineConfigStep.multiRevs), so an
    // interior revision invalidates just that series' cache — the key's
    // len/firstT/lastT/lastV heuristic can't see interior changes on its own.
    let cacheRef: LineCacheRef | undefined;
    if (opts.lineCaches !== undefined && opts.lineCacheRef !== undefined) {
      let slot = opts.lineCaches.get(s.id);
      if (slot === undefined) {
        slot = createLineCacheSlot();
        opts.lineCaches.set(s.id, slot);
      }
      // Pooled ref (see MultiSeriesDrawOptions.lineCacheRef) repointed at
      // this series' slot, rather than a fresh literal per series per frame.
      // Safe because `drawLine` reads it synchronously and retains nothing.
      cacheRef = opts.lineCacheRef;
      cacheRef.slot = slot;
      cacheRef.dataRev = s.dataRev;
      cacheRef.dataSource = opts.multiDataSource ?? 0;
      cacheRef.splitPrefixStroke = false;
    }
    ctx.save();
    if (combinedAlpha < 1) ctx.globalAlpha = combinedAlpha;
    const lineArgs = opts.lineArgs;
    lineArgs.visible = s.visible;
    lineArgs.smoothValue = s.smoothValue;
    lineArgs.now = opts.now;
    lineArgs.showFill = false; // no fill
    lineArgs.scrubX = scrubX;
    lineArgs.scrubAmount = opts.scrubAmount;
    lineArgs.chartReveal = reveal;
    lineArgs.now_ms = opts.now_ms;
    lineArgs.colorBlend = 1;
    lineArgs.skipDashLine = false;
    lineArgs.fillScale = 1;
    lineArgs.pathCache = cacheRef;
    const pts = drawLine(ctx, layout, s.palette, lineArgs);
    ctx.restore();
    if (pts && pts.length > 0) {
      allPts.push({
        pts,
        palette: s.palette,
        label: s.label,
        alpha: seriesAlpha,
      });
    }
  }

  // 4. Time axis
  {
    const timeAlpha = reveal < 1 ? smoothstepRamp(reveal, 0.15, 0.7) : 1;
    if (timeAlpha > 0.01) {
      ctx.save();
      if (timeAlpha < 1) ctx.globalAlpha = timeAlpha;
      drawTimeAxis(
        ctx,
        layout,
        palette,
        opts.windowSecs,
        opts.targetWindowSecs,
        opts.formatTime,
        opts.timeAxisState,
        opts.dt
      );
      ctx.restore();
    }
  }

  // 5. Endpoint dots + labels for each series
  // Dots stay at reveal-based alpha only (no scrub dimming) — matching
  // single-series where drawDot keeps inner dot at full baseAlpha
  if (reveal > 0.3 && allPts.length > 0) {
    const dotAlpha = (reveal - 0.3) / 0.7;
    const showPulse =
      opts.showPulse && reveal > 0.6 && opts.pauseProgress < 0.5;

    for (const entry of allPts) {
      if (entry.alpha < 0.01) continue;
      const lastPt = entry.pts[entry.pts.length - 1]!;
      const lineColor = entry.palette.line;

      ctx.save();
      ctx.globalAlpha = dotAlpha * entry.alpha;

      // Use pulsing dot when enabled and series is mostly visible
      if (showPulse && entry.alpha > 0.5) {
        drawMultiDot(
          ctx,
          lastPt[0],
          lastPt[1],
          lineColor,
          true,
          opts.now_ms,
          3
        );
      } else {
        drawSimpleDot(ctx, lastPt[0], lastPt[1], lineColor, 3);
      }

      // Label at endpoint (right of dot — layout reserves space via labelReserve)
      if (entry.label) {
        ctx.font = ctx.fonts.seriesLabel;
        ctx.textAlign = 'left';
        ctx.fillStyle = lineColor;
        ctx.fillText(entry.label, lastPt[0] + 6, lastPt[1] + 3.5);
      }
      ctx.restore();
    }
  }

  // 6. Left edge fade
  drawEdgeFade(ctx, layout.pad.left, layout.h);

  // 7. Multi-series crosshair — fade out near live dots (same logic as single-series)
  if (
    opts.hoverX !== null &&
    opts.hoverTime !== null &&
    opts.hoverEntries.length > 0 &&
    allPts.length > 0 &&
    opts.scrubAmount > 0.01
  ) {
    // Find rightmost live dot X (skip hidden series)
    let maxLiveDotX = 0;
    for (const entry of allPts) {
      if (entry.alpha < 0.01) continue;
      const lastX = entry.pts[entry.pts.length - 1]![0];
      if (lastX > maxLiveDotX) maxLiveDotX = lastX;
    }

    const distToLive = maxLiveDotX - opts.hoverX;
    const scrubOpacity = scrubFadeOpacity(
      distToLive,
      opts.scrubAmount,
      layout.chartW
    );

    if (scrubOpacity > 0.01) {
      drawMultiCrosshair(
        ctx,
        layout,
        palette,
        opts.hoverX,
        opts.hoverTime,
        opts.hoverEntries,
        opts.formatValue,
        opts.formatTime,
        scrubOpacity,
        opts.tooltipY,
        opts.tooltipOutline,
        maxLiveDotX
      );
    }
  }
}

// ─── Candlestick draw orchestration ───────────────────────────────────────

export interface CandleDrawOptions {
  candles: CandlePoint[];
  displayCandleWidth: number;
  oldCandles: CandlePoint[];
  oldWidth: number;
  morphT: number; // candle width transition progress (-1 = none)
  liveCandle?: CandlePoint;
  /** Pre-blend live candle for the dashed close-price line (unaffected by line mode morph) */
  closePriceCandle?: CandlePoint;
  liveTime: number;
  liveBirthAlpha: number;
  liveBullBlend: number;
  lineModeProg: number;
  chartReveal: number;
  now_ms: number;
  now: number;
  pauseProgress: number;
  showGrid: boolean;
  scrubAmount: number;
  hoverX: number | null;
  hoverValue: number | null;
  hoverTime: number | null;
  hoveredCandle: CandlePoint | null;
  formatValue: (v: number) => string;
  formatTime: (t: number) => string;
  gridState: GridState;
  timeAxisState: TimeAxisState;
  dt: number;
  targetWindowSecs: number;
  tooltipY: number;
  tooltipOutline: boolean;
  // Line data — drawLine handles morphY, alpha, color, dot position
  lineVisible: LivelinePoint[];
  lineSmoothValue: number;
  emptyText?: string;
  loadingAlpha: number;
  showEmptyOverlay: boolean; // true only when collapsing to empty (not loading, not forward morph)
  /** Cross-frame grid picture cache (see draw/gridLayer, engine/gridLayer) */
  gridLayer?: GridLayerSlot<SkPicture>;
  /** Cross-frame closed-candle body+wick path cache (see draw/candleCache).
   * Only actually used when the steady-state (non-width-morph) branch below
   * is drawing candles with no reveal OHLC-collapse and no active
   * line-mode morph in progress — see the gating right before the
   * drawCandlesticks call in the `else` branch. */
  candleCache?: CandleCacheRef;
  /** Pooled scratch struct this frame's `drawLine` call is filled into —
   * owned by `EngineState`, never allocated here. See `LineDrawArgs`. */
  lineArgs: LineDrawArgs;
  /** Pooled scratch struct the `drawCandlesticks` calls are filled into —
   * refilled between the two halves of the width-morph cross-fade. See
   * `CandleDrawArgs`. */
  candleArgs: CandleDrawArgs;
}

/**
 * Candlestick draw orchestrator — calls each draw module in the correct
 * order for candle mode. Pure drawing function, no state management.
 */
export function drawCandleFrame(
  ctx: Ctx2D,
  layout: ChartLayout,
  palette: LivelinePalette,
  opts: CandleDrawOptions
): void {
  'worklet';
  const { w, h, pad, chartW, chartH } = layout;
  const reveal = opts.chartReveal;

  // When fully in line mode, delegate entirely to drawLine (same path as
  // drawFrame) so transitions are visually identical to line mode.
  const fullLineMode = opts.lineModeProg >= 0.99;

  // Line presence (lp): during the reveal, the morph line smoothly
  // transforms from the loading squiggly into data positions. See
  // draw/lineOverlay.ts — `engineStep` gates *building* the overlay's point
  // array on the companion predicate there, so the two must stay in step.
  const lp = lineOverlayPresence(opts.lineModeProg, reveal);

  // colorBlend: when reveal drives lp, force grey (loading squiggly color).
  // When the user's lineModeProg drives lp, use accent color.
  const colorBlend = lp > 0.001 ? opts.lineModeProg / lp : 1;

  // 1. Grid — fades in (25%–60% of reveal)
  const gridAlpha = smoothstepRamp(reveal, 0.25, 0.6);
  if (opts.showGrid && gridAlpha > 0.01) {
    ctx.save();
    if (opts.gridLayer?.picture && reveal >= 1) {
      ctx.drawPicture(opts.gridLayer.picture);
    } else {
      if (gridAlpha < 1) ctx.globalAlpha = gridAlpha;
      drawGrid(ctx, layout, palette, opts.formatValue, opts.gridState, opts.dt);
    }
    ctx.restore();
  }

  // 2. Line — morph line that transforms from loading squiggly into data.
  //    Returns pts for dot position.
  let linePts: [number, number][] | undefined;
  if (lp > LINE_OVERLAY_MIN_PRESENCE && opts.lineVisible.length >= 2) {
    const scrubX = opts.scrubAmount > 0.05 ? opts.hoverX : null;
    ctx.save();
    ctx.globalAlpha = lp;
    const lineArgs = opts.lineArgs;
    lineArgs.visible = opts.lineVisible;
    lineArgs.smoothValue = opts.lineSmoothValue;
    lineArgs.now = opts.now;
    lineArgs.showFill = opts.lineModeProg > 0.01;
    lineArgs.scrubX = scrubX;
    lineArgs.scrubAmount = opts.scrubAmount;
    lineArgs.chartReveal = opts.chartReveal;
    lineArgs.now_ms = opts.now_ms;
    lineArgs.colorBlend = colorBlend;
    lineArgs.skipDashLine = !fullLineMode;
    // fill fades smoothly with the line mode transition
    lineArgs.fillScale = opts.lineModeProg;
    lineArgs.pathCache = undefined;
    linePts = drawLine(ctx, layout, palette, lineArgs);
    ctx.restore();
  }

  // 3. Close price line — fades in (40%–80% of reveal)
  //    Uses closePriceCandle (pre-blend) so the dashed line isn't affected
  //    by line mode morph or OHLC collapse.
  const closeAlpha = smoothstepRamp(reveal, 0.4, 0.8);
  const closeSource = opts.closePriceCandle ?? opts.liveCandle;
  if (closeSource && closeAlpha > 0.01) {
    // Candle-colored close line (fades out with lineModeProg)
    if (lp < 0.99) {
      ctx.save();
      ctx.globalAlpha = closeAlpha * (1 - lp);
      drawClosePrice(
        ctx,
        layout,
        palette,
        closeSource,
        opts.scrubAmount,
        opts.liveBullBlend
      );
      ctx.restore();
    }
    // Accent-colored dash line (fades in with lineModeProg)
    // Skip when fully in line mode — drawLine draws its own morphing dash
    if (lp > LINE_OVERLAY_MIN_PRESENCE && !fullLineMode) {
      const dashY = layout.toY(closeSource.close);
      if (dashY >= pad.top && dashY <= h - pad.bottom) {
        ctx.save();
        ctx.setLineDash(DASH_4_4);
        ctx.strokeStyle = palette.dashLine;
        ctx.lineWidth = 1;
        ctx.globalAlpha = closeAlpha * lp * (1 - opts.scrubAmount * 0.2);
        ctx.beginPath();
        ctx.moveTo(pad.left, dashY);
        ctx.lineTo(w - pad.right, dashY);
        ctx.stroke();
        ctx.setLineDash(EMPTY_DASH);
        ctx.restore();
      }
    }
  }

  // 4. Candles — alpha = chartReveal * (1 - lp)
  //    During reveal, OHLC collapses toward close so candle bodies shrink
  //    into thin lines before fading out (or grow from thin lines on appear).
  const candleAlpha = opts.chartReveal * (1 - lp);
  if (candleAlpha > 0.01) {
    // OHLC expansion uses smoothstep on reveal — this keeps shape and alpha
    // in sync (at 50% visible, candles are ~50% expanded rather than flat).
    const ohlcScale = reveal * reveal * (3 - 2 * reveal);
    // collapseC is only ever invoked during the brief reveal-collapse window
    // (ohlcScale < 0.99); gate its allocation behind that same check instead
    // of building a fresh closure every candle frame regardless of whether
    // it's used.
    let revealCandles = opts.candles;
    let revealOld = opts.oldCandles;
    if (ohlcScale < 0.99) {
      const collapseC = (c: CandlePoint): CandlePoint => ({
        time: c.time,
        open: c.close + (c.open - c.close) * ohlcScale,
        high: c.close + (c.high - c.close) * ohlcScale,
        low: c.close + (c.low - c.close) * ohlcScale,
        close: c.close,
      });
      revealCandles = opts.candles.map(collapseC);
      if (opts.oldCandles.length > 0) {
        revealOld = opts.oldCandles.map(collapseC);
      }
    }

    ctx.save();
    ctx.clipRect(pad.left - 1, pad.top, chartW + 2, chartH);
    const accentCol = lp > LINE_OVERLAY_MIN_PRESENCE ? palette.line : undefined;
    // Fields shared by every drawCandlesticks call below; the per-call
    // differences are written immediately before each call.
    const ca = opts.candleArgs;
    ca.now_ms = opts.now_ms;
    ca.pauseProgress = opts.pauseProgress;
    ca.scrubX = opts.hoverX ?? 0;
    ca.scrubDim = opts.scrubAmount;
    ca.accentColor = accentCol;
    ca.accentBlend = lp;
    ca.cache = undefined;
    ca.makePath = undefined;
    if (opts.morphT >= 0 && revealOld.length > 0) {
      ctx.globalAlpha = (1 - opts.morphT) * candleAlpha;
      ca.candles = revealOld;
      ca.candleWidthSecs = opts.oldWidth;
      ca.liveTime = -1;
      ca.liveAlpha = 1;
      ca.liveBullBlend = -1;
      drawCandlesticks(ctx, layout, ca);
      ctx.globalAlpha = opts.morphT * candleAlpha;
      ca.candles = revealCandles;
      ca.candleWidthSecs = opts.displayCandleWidth;
      ca.liveTime = opts.liveCandle?.time ?? -1;
      ca.liveAlpha = opts.liveBirthAlpha;
      ca.liveBullBlend = opts.liveBullBlend;
      drawCandlesticks(ctx, layout, ca);
      ctx.globalAlpha = 1;
    } else {
      if (candleAlpha < 1) ctx.globalAlpha = candleAlpha;
      // Cache only applies in this steady-state branch, and only when this
      // frame isn't reshaping every candle's OHLC: `revealCandles !==
      // opts.candles` means the reveal collapse above remapped them, and
      // lineModeProg strictly between 0 and ~1 means engine/step.ts's own
      // OHLC collapse (for the line↔candle morph) remapped them upstream.
      // Both change geometry every frame in ways the cache's key doesn't
      // track, so it must sit out entirely — same as it already does during
      // the candle-width morph branch above (cache is simply never passed
      // there).
      const lineModeSettled =
        opts.lineModeProg <= 0.01 || opts.lineModeProg >= 0.99;
      const candleCache =
        opts.candleCache && revealCandles === opts.candles && lineModeSettled
          ? opts.candleCache
          : undefined;
      ca.candles = revealCandles;
      ca.candleWidthSecs = opts.displayCandleWidth;
      ca.liveTime = opts.liveCandle?.time ?? -1;
      ca.liveAlpha = opts.liveBirthAlpha;
      ca.liveBullBlend = opts.liveBullBlend;
      ca.cache = candleCache;
      ca.makePath = candleCache ? makeCandlePath : undefined;
      drawCandlesticks(ctx, layout, ca);
    }
    ctx.restore();
  }

  // 5. Live dot — position from drawLine's returned pts (same as drawFrame).
  if (lp > 0.5 && linePts && linePts.length > 0 && reveal > 0.3) {
    const lastPt = linePts[linePts.length - 1]!;
    const dotAlpha = (lp - 0.5) * 2 * ((reveal - 0.3) / 0.7);
    const showPulse = lp > 0.8 && reveal > 0.6 && opts.pauseProgress < 0.5;
    if (dotAlpha > 0.01) {
      ctx.save();
      ctx.globalAlpha = dotAlpha;
      drawDot(
        ctx,
        lastPt[0],
        lastPt[1],
        palette,
        showPulse,
        opts.scrubAmount,
        opts.now_ms
      );
      ctx.restore();
    }
  }

  // 6. Time axis — fades in (25%–60% of reveal)
  const timeAlpha = smoothstepRamp(reveal, 0.25, 0.6);
  if (timeAlpha > 0.01) {
    ctx.save();
    if (timeAlpha < 1) ctx.globalAlpha = timeAlpha;
    drawTimeAxis(
      ctx,
      layout,
      palette,
      opts.targetWindowSecs,
      opts.targetWindowSecs,
      opts.formatTime,
      opts.timeAxisState,
      opts.dt
    );
    ctx.restore();
  }

  // 7. Left edge fade — gradient erase
  drawEdgeFade(ctx, pad.left, h);

  // 8. Reverse morph empty overlay — only when collapsing to empty state
  //    (not during forward morph or loading), matching line mode's
  //    `revealTarget === 0 && !cfg.loading` guard.
  if (opts.showEmptyOverlay) {
    const bgAlpha = 1 - opts.chartReveal;
    if (bgAlpha > 0.01) {
      const bgEmptyAlpha = (1 - opts.loadingAlpha) * bgAlpha;
      if (bgEmptyAlpha > 0.01) {
        drawEmpty(
          ctx,
          w,
          h,
          pad,
          palette,
          bgEmptyAlpha,
          opts.now_ms,
          true,
          opts.emptyText
        );
      }
    }
  }

  // 9. Crosshair — only when mostly revealed (70%+)
  if (
    opts.chartReveal > 0.7 &&
    opts.hoveredCandle &&
    opts.hoverX !== null &&
    opts.scrubAmount > 0.01
  ) {
    if (opts.lineModeProg > 0.5) {
      drawLineModeCrosshair(
        ctx,
        layout,
        palette,
        opts.hoverX,
        opts.hoveredCandle.close,
        opts.hoverTime ?? 0,
        opts.formatValue,
        opts.formatTime,
        opts.scrubAmount
      );
    } else {
      drawCandleCrosshair(
        ctx,
        layout,
        palette,
        opts.hoverX,
        opts.hoveredCandle,
        opts.hoverTime ?? 0,
        opts.formatValue,
        opts.formatTime,
        opts.scrubAmount
      );
    }
  }
}
