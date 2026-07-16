import type {
  LivelinePoint,
  ChartLayout,
  Momentum,
  HoverPoint,
} from '../types';
import { lerp } from '../math/lerp';
import { computeRange } from '../math/range';
import { detectMomentum } from '../math/momentum';
import { interpolateAtTime } from '../math/interpolate';
import type { Ctx2D } from '../draw/canvas2d';
import {
  drawFrame,
  drawMultiFrame,
  FADE_EDGE_WIDTH,
  type MultiSeriesEntry,
} from '../draw';
import { drawLoading } from '../draw/loading';
import { drawEmpty } from '../draw/empty';
import type { EngineConfig } from './types';
import type { EngineState } from './state';
import { drawBadge } from './badge';
import {
  computeAdaptiveSpeed,
  updateWindowTransition,
  updateRange,
  updateHoverState,
} from './helpers';
import {
  SCRUB_LERP_SPEED,
  WINDOW_BUFFER,
  WINDOW_BUFFER_NO_BADGE,
  VALUE_SNAP_THRESHOLD,
  ADAPTIVE_SPEED_BOOST,
  CHART_REVEAL_SPEED,
  CHART_REVEAL_SPEED_FWD,
  PAUSE_PROGRESS_SPEED,
  PAUSE_CATCHUP_SPEED,
  PAUSE_CATCHUP_SPEED_FAST,
  LOADING_ALPHA_SPEED,
  SERIES_TOGGLE_SPEED,
  LINE_MORPH_MS,
} from './constants';

export interface StepOutput {
  /** Hover point to deliver through onHover this frame (undefined = none) */
  emitHover?: HoverPoint;
  /** Live value display text (line mode + showValue), null = leave unchanged */
  valueText: string | null;
  /** Live value display color ('' = default color) */
  valueColor: string | null;
}

/** Left-edge fade used by the loading/empty fallback branches. */
function drawEdgeFade(ctx: Ctx2D, padLeft: number, h: number): void {
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

/**
 * One frame of the liveline engine — a direct port of the web version's
 * rAF `draw` callback, minus the DOM (badge and live value are handled via
 * the canvas and returned StepOutput). Runs entirely on the UI thread.
 *
 * Candle mode is not yet ported; it renders the loading/empty fallback.
 */
export function engineStep(
  ctx: Ctx2D,
  cfg: EngineConfig,
  s: EngineState,
  w: number,
  h: number,
  hoverPixelXRaw: number | null,
  dt: number,
  now_ms: number
): StepOutput {
  'worklet';
  const out: StepOutput = { valueText: null, valueColor: null };

  const noMotion = cfg.noMotion;
  const hoverPixelX = cfg.scrub ? hoverPixelXRaw : null;

  // --- Mode-specific pause data snapshot ---
  const isCandle = cfg.mode === 'candle';

  if (isCandle) {
    if (
      cfg.paused &&
      s.pausedCandles === null &&
      (cfg.candles?.length ?? 0) > 0
    ) {
      s.pausedCandles = cfg.candles!.slice();
      s.pausedLive = cfg.liveCandle ?? null;
      s.pausedLineData = cfg.lineData?.slice() ?? null;
      s.pausedLineValue = cfg.lineValue ?? null;
    }
    if (!cfg.paused) {
      s.pausedCandles = null;
      s.pausedLive = null;
      s.pausedLineData = null;
      s.pausedLineValue = null;
    }
  } else if (cfg.isMultiSeries && cfg.multiSeries) {
    if (cfg.paused && s.pausedMultiData === null) {
      const snap = new Map<string, { data: LivelinePoint[]; value: number }>();
      for (const series of cfg.multiSeries) {
        if (series.data.length >= 2) {
          snap.set(series.id, {
            data: series.data.slice(),
            value: series.value,
          });
        }
      }
      if (snap.size > 0) s.pausedMultiData = snap;
    }
    if (!cfg.paused) {
      s.pausedMultiData = null;
    }
  } else {
    if (cfg.paused && s.pausedData === null && cfg.data.length >= 2) {
      s.pausedData = cfg.data.slice();
    }
    if (!cfg.paused) {
      s.pausedData = null;
    }
  }

  const points = isCandle
    ? ([] as LivelinePoint[])
    : (s.pausedData ?? cfg.data);
  const effectiveCandles = isCandle
    ? (s.pausedCandles ?? cfg.candles ?? [])
    : [];
  const hasMultiData =
    cfg.isMultiSeries && cfg.multiSeries
      ? cfg.multiSeries.some((series) => series.data.length >= 2)
      : false;
  const hasData = isCandle
    ? effectiveCandles.length >= 2
    : hasMultiData || points.length >= 2;
  const pad = cfg.padding;
  const chartH = h - pad.top - pad.bottom;

  // --- Pause time management ---
  const pauseTarget = cfg.paused ? 1 : 0;
  s.pauseProgress = noMotion
    ? pauseTarget
    : lerp(s.pauseProgress, pauseTarget, PAUSE_PROGRESS_SPEED, dt);
  if (s.pauseProgress < 0.005) s.pauseProgress = 0;
  if (s.pauseProgress > 0.995) s.pauseProgress = 1;
  const pauseProgress = s.pauseProgress;
  const pausedDt = dt * (1 - pauseProgress);

  const realDtSec = dt / 1000;
  s.timeDebt += realDtSec * pauseProgress;
  // Only drain time debt when unpausing — during pausing, let it
  // accumulate freely so the chart decelerates smoothly
  if (!cfg.paused && s.timeDebt > 0.001) {
    const catchUpSpeed =
      s.timeDebt > 10 ? PAUSE_CATCHUP_SPEED_FAST : PAUSE_CATCHUP_SPEED;
    s.timeDebt = lerp(s.timeDebt, 0, catchUpSpeed, dt);
    if (s.timeDebt < 0.01) s.timeDebt = 0;
  }

  // --- Loading alpha (loading ↔ empty crossfade) ---
  const loadingTarget = cfg.loading ? 1 : 0;
  s.loadingAlpha = noMotion
    ? loadingTarget
    : lerp(s.loadingAlpha, loadingTarget, LOADING_ALPHA_SPEED, dt);
  if (s.loadingAlpha < 0.01) s.loadingAlpha = 0;
  if (s.loadingAlpha > 0.99) s.loadingAlpha = 1;
  const loadingAlpha = s.loadingAlpha;

  // --- Chart reveal (loading/empty → data morph) ---
  const revealTarget = !cfg.loading && hasData ? 1 : 0;
  s.chartReveal = noMotion
    ? revealTarget
    : lerp(
        s.chartReveal,
        revealTarget,
        revealTarget === 1 ? CHART_REVEAL_SPEED_FWD : CHART_REVEAL_SPEED,
        dt
      );
  if (Math.abs(s.chartReveal - revealTarget) < 0.005) {
    s.chartReveal = revealTarget;
  }
  const chartReveal = s.chartReveal;

  // Reset range when reveal fully collapses — guarantees a fresh snap
  // (not a slow lerp from stale values) when data reappears.
  if (chartReveal < 0.01) {
    s.rangeInited = false;
  }

  // Data stash for reverse morph — keep drawing chart while it morphs back
  // to the squiggly shape (identical to loading/empty line at reveal=0)
  let useStash: boolean;
  let useMultiStash = false;
  if (isCandle) {
    useStash = !hasData && chartReveal > 0.005 && s.lastCandles.length > 0;
    // Candle stash updated inside candle pipeline after computing visible
  } else {
    // Multi-series stash
    useMultiStash =
      !hasData && chartReveal > 0.005 && s.lastMultiSeries.length > 0;
    if (hasMultiData && cfg.multiSeries) {
      s.lastMultiSeries = cfg.multiSeries.map((series) => ({
        id: series.id,
        data: series.data.slice(),
        value: series.value,
        palette: series.palette,
        label: series.label,
      }));
    }
    // Clear multi stash when single-series data arrives
    if (hasData && !cfg.isMultiSeries) s.lastMultiSeries = [];

    useStash =
      !useMultiStash &&
      !hasData &&
      chartReveal > 0.005 &&
      s.lastData.length >= 2;
    if (hasData && !cfg.isMultiSeries) s.lastData = points;
  }

  // Update lineModeProg even during early return — prevents the
  // transition from freezing when the user toggles lineMode while
  // in loading or empty state.
  if (isCandle) {
    const lmt = s.lineModeTrans;
    const lineModeTarget = cfg.lineMode ? 1 : 0;
    if (lmt.to !== lineModeTarget) {
      lmt.from = s.lineModeProg;
      lmt.to = lineModeTarget;
      lmt.startMs = now_ms;
    }
    if (lmt.startMs > 0) {
      const elapsed = now_ms - lmt.startMs;
      const t = Math.min(elapsed / LINE_MORPH_MS, 1);
      s.lineModeProg =
        lmt.from + (lmt.to - lmt.from) * ((1 - Math.cos(t * Math.PI)) / 2);
      if (t >= 1) {
        s.lineModeProg = lmt.to;
        lmt.startMs = 0;
      }
    } else {
      s.lineModeProg = lmt.to;
    }
  }

  if (!hasData && !useStash && !useMultiStash) {
    // No chart pipeline — draw loading or empty as the sole visual.
    // Grey loading line for candle mode and multi-series (no single accent color)
    const loadingColor =
      isCandle || cfg.isMultiSeries || s.lastMultiSeries.length > 0
        ? cfg.palette.gridLabel
        : undefined;
    if (loadingAlpha > 0.01) {
      drawLoading(
        ctx,
        w,
        h,
        pad,
        cfg.palette,
        now_ms,
        loadingAlpha,
        loadingColor
      );
    }
    if (1 - loadingAlpha > 0.01) {
      drawEmpty(
        ctx,
        w,
        h,
        pad,
        cfg.palette,
        1 - loadingAlpha,
        now_ms,
        false,
        cfg.emptyText
      );
    }
    drawEdgeFade(ctx, pad.left, h);
    return out;
  }

  if (isCandle) {
    // ═══════════════════════════════════════════════════════
    // CANDLE MODE PIPELINE — ported in the candlestick phase.
    // Until then, render the loading/empty fallback so the chart
    // degrades gracefully instead of crashing.
    // ═══════════════════════════════════════════════════════
    if (loadingAlpha > 0.01) {
      drawLoading(
        ctx,
        w,
        h,
        pad,
        cfg.palette,
        now_ms,
        loadingAlpha,
        cfg.palette.gridLabel
      );
    }
    drawEdgeFade(ctx, pad.left, h);
    return out;
  } else if (
    (cfg.isMultiSeries && cfg.multiSeries && cfg.multiSeries.length > 0) ||
    useMultiStash
  ) {
    // ═══════════════════════════════════════════════════════
    // MULTI-SERIES LINE MODE PIPELINE
    // ═══════════════════════════════════════════════════════

    const effectiveMultiSeries = useMultiStash
      ? s.lastMultiSeries
      : cfg.multiSeries!;

    // Reserve just enough right-side space so endpoint labels don't overlap
    // grid value text (which starts at w - pad.right + 8). Labels are drawn
    // at lineEnd + 6, so overlap = labelW + 6 - 8 = labelW - 2.
    // Scale with chartReveal so layout doesn't shift during loading collapse.
    let labelReserve = 0;
    if (effectiveMultiSeries.some((series) => series.label)) {
      ctx.font = ctx.fonts.seriesLabel;
      let maxLabelW = 0;
      for (const series of effectiveMultiSeries) {
        if (series.label) {
          const lw = ctx.measureText(series.label).width;
          if (lw > maxLabelW) maxLabelW = lw;
        }
      }
      labelReserve = Math.max(0, maxLabelW - 2) * chartReveal;
    }

    const chartW = w - pad.left - pad.right - labelReserve;
    const buffer = cfg.showBadge ? WINDOW_BUFFER : WINDOW_BUFFER_NO_BADGE;

    // Clean stale entries from displayValues (series that were removed)
    if (!useMultiStash) {
      const currentIds: string[] = [];
      for (const series of effectiveMultiSeries) currentIds.push(series.id);
      for (const key of s.displayValues.keys()) {
        if (currentIds.indexOf(key) < 0) s.displayValues.delete(key);
      }
    }

    // Use first series data for window transition seeding
    const firstSeries = effectiveMultiSeries[0]!;
    const transition = s.windowTransition;
    if (hasData) s.frozenNow = Date.now() / 1000 - s.timeDebt;
    const now = useMultiStash ? s.frozenNow : Date.now() / 1000 - s.timeDebt;

    // Per-series smooth values (freeze when using stash)
    const smoothValues = new Map<string, number>();
    for (const series of effectiveMultiSeries) {
      let dv = s.displayValues.get(series.id);
      if (dv === undefined) dv = series.value;
      if (!useMultiStash) {
        const adaptiveSpeed = computeAdaptiveSpeed(
          series.value,
          dv,
          s.displayMin,
          s.displayMax,
          cfg.lerpSpeed,
          noMotion
        );
        dv = lerp(dv, series.value, adaptiveSpeed, pausedDt);
        const prevRange = s.displayMax - s.displayMin || 1;
        if (Math.abs(dv - series.value) < prevRange * VALUE_SNAP_THRESHOLD) {
          dv = series.value;
        }
        s.displayValues.set(series.id, dv);
      }
      smoothValues.set(series.id, dv);
    }

    // Per-series visibility alpha (lerp toward 0 for hidden, 1 for visible)
    const hiddenIds = cfg.hiddenSeriesIds;
    const seriesAlphas = s.seriesAlpha;
    for (const series of effectiveMultiSeries) {
      let alpha = seriesAlphas.get(series.id) ?? 1;
      const target = hiddenIds && hiddenIds.indexOf(series.id) >= 0 ? 0 : 1;
      alpha = noMotion
        ? target
        : lerp(alpha, target, SERIES_TOGGLE_SPEED, pausedDt);
      if (alpha < 0.01) alpha = 0;
      if (alpha > 0.99) alpha = 1;
      seriesAlphas.set(series.id, alpha);
    }

    // Window transition — seed with all series data for accurate range
    const firstData =
      s.pausedMultiData?.get(firstSeries.id)?.data ?? firstSeries.data;
    const windowResult = updateWindowTransition(
      cfg,
      transition,
      s.displayWindow,
      s.displayMin,
      s.displayMax,
      noMotion,
      now_ms,
      now,
      firstData,
      smoothValues.get(firstSeries.id) ?? firstSeries.value,
      buffer
    );
    // Override range target with union of ALL series (not just first)
    if (transition.startMs > 0 && effectiveMultiSeries.length > 1) {
      const targetRightEdge = now + cfg.windowSecs * buffer;
      const targetLeftEdge = targetRightEdge - cfg.windowSecs;
      let unionMin = Infinity;
      let unionMax = -Infinity;
      for (const series of effectiveMultiSeries) {
        const sData = s.pausedMultiData?.get(series.id)?.data ?? series.data;
        const sv = smoothValues.get(series.id) ?? series.value;
        const targetVisible: LivelinePoint[] = [];
        for (const p of sData) {
          if (p.time >= targetLeftEdge - 2 && p.time <= targetRightEdge) {
            targetVisible.push(p);
          }
        }
        if (targetVisible.length > 0) {
          const range = computeRange(
            targetVisible,
            sv,
            cfg.referenceLine?.value,
            cfg.exaggerate
          );
          if (range.min < unionMin) unionMin = range.min;
          if (range.max > unionMax) unionMax = range.max;
        }
      }
      if (isFinite(unionMin) && isFinite(unionMax)) {
        transition.rangeToMin = unionMin;
        transition.rangeToMax = unionMax;
      }
    }
    s.displayWindow = windowResult.windowSecs;
    const windowSecs = windowResult.windowSecs;
    const windowTransProgress = windowResult.windowTransProgress;
    const isWindowTransitioning = transition.startMs > 0;

    const rightEdge = now + windowSecs * buffer;
    const leftEdge = rightEdge - windowSecs;
    const filterRight = rightEdge - (rightEdge - now) * pauseProgress;

    // Build per-series visible arrays and compute global range
    // Use paused snapshots when available to prevent left-edge erosion
    // Exclude hidden series (alpha < 0.01) from range so Y-axis adjusts
    const seriesEntries: MultiSeriesEntry[] = [];
    let globalMin = Infinity;
    let globalMax = -Infinity;
    for (const series of effectiveMultiSeries) {
      const snap = s.pausedMultiData?.get(series.id);
      const seriesData = snap?.data ?? series.data;
      const visible: LivelinePoint[] = [];
      for (const p of seriesData) {
        if (p.time >= leftEdge - 2 && p.time <= filterRight) visible.push(p);
      }
      const sv = smoothValues.get(series.id) ?? series.value;
      const alpha = seriesAlphas.get(series.id) ?? 1;
      if (visible.length >= 2) {
        // Only include in range if series is at least partially visible
        if (alpha > 0.01) {
          const range = computeRange(
            visible,
            sv,
            cfg.referenceLine?.value,
            cfg.exaggerate
          );
          if (range.min < globalMin) globalMin = range.min;
          if (range.max > globalMax) globalMax = range.max;
        }
        // Always push to entries (drawMultiFrame skips via alpha)
        seriesEntries.push({
          visible,
          smoothValue: sv,
          palette: series.palette,
          label: series.label,
          alpha,
        });
      }
    }

    if (seriesEntries.length === 0) {
      // No visible data — draw loading/empty fallback (matching single-series behavior)
      // Grey loading line for multi-series (no single accent color to use)
      if (loadingAlpha > 0.01) {
        drawLoading(
          ctx,
          w,
          h,
          pad,
          cfg.palette,
          now_ms,
          loadingAlpha,
          cfg.palette.gridLabel
        );
      }
      if (1 - loadingAlpha > 0.01) {
        drawEmpty(
          ctx,
          w,
          h,
          pad,
          cfg.palette,
          1 - loadingAlpha,
          now_ms,
          false,
          cfg.emptyText
        );
      }
      drawEdgeFade(ctx, pad.left, h);
      return out;
    }

    // Smooth global range
    const computedRange = {
      min: isFinite(globalMin) ? globalMin : 0,
      max: isFinite(globalMax) ? globalMax : 1,
    };
    const adaptiveSpeed = cfg.lerpSpeed + ADAPTIVE_SPEED_BOOST * 0.5;
    const rangeResult = updateRange(
      computedRange,
      s.rangeInited,
      s.targetMin,
      s.targetMax,
      s.displayMin,
      s.displayMax,
      isWindowTransitioning,
      windowTransProgress,
      transition,
      adaptiveSpeed,
      chartH,
      pausedDt
    );
    s.rangeInited = rangeResult.rangeInited;
    s.targetMin = rangeResult.targetMin;
    s.targetMax = rangeResult.targetMax;
    s.displayMin = rangeResult.displayMin;
    s.displayMax = rangeResult.displayMax;
    const { minVal, maxVal, valRange } = rangeResult;

    const layout: ChartLayout = {
      w,
      h,
      pad,
      chartW,
      chartH,
      leftEdge,
      rightEdge,
      minVal,
      maxVal,
      valRange,
      toX: (t: number) =>
        pad.left + ((t - leftEdge) / (rightEdge - leftEdge)) * chartW,
      toY: (v: number) => pad.top + (1 - (v - minVal) / valRange) * chartH,
    };

    // Hover — interpolate value at hover time for each series
    const hoverPx = hoverPixelX;
    let drawHoverX: number | null = null;
    let drawHoverTime: number | null = null;
    let isActiveHover = false;
    let hoverEntries: { color: string; label: string; value: number }[] = [];

    if (hoverPx !== null && hoverPx >= pad.left && hoverPx <= w - pad.right) {
      const maxHoverX = layout.toX(now);
      const clampedX = Math.min(hoverPx, maxHoverX);
      const t =
        leftEdge + ((clampedX - pad.left) / chartW) * (rightEdge - leftEdge);
      drawHoverX = clampedX;
      drawHoverTime = t;
      isActiveHover = true;

      for (const entry of seriesEntries) {
        // Skip hidden series from crosshair tooltip
        if ((entry.alpha ?? 1) < 0.5) continue;
        const v = interpolateAtTime(entry.visible, t);
        if (v !== null) {
          hoverEntries.push({
            color: entry.palette.line,
            label: entry.label ?? '',
            value: v,
          });
        }
      }
      s.lastHover = {
        x: clampedX,
        value: hoverEntries[0]?.value ?? 0,
        time: t,
      };
      s.lastHoverEntries = hoverEntries;
      if (cfg.hasOnHover) {
        out.emitHover = {
          time: t,
          value: hoverEntries[0]?.value ?? 0,
          x: clampedX,
          y: layout.toY(hoverEntries[0]?.value ?? 0),
        };
      }
    }

    // Scrub amount
    const scrubTarget = isActiveHover ? 1 : 0;
    if (noMotion) {
      s.scrubAmount = scrubTarget;
    } else {
      s.scrubAmount += (scrubTarget - s.scrubAmount) * SCRUB_LERP_SPEED;
      if (s.scrubAmount < 0.01) s.scrubAmount = 0;
      if (s.scrubAmount > 0.99) s.scrubAmount = 1;
    }

    // Fade-out: use last known hover position + cached entries
    if (!isActiveHover && s.scrubAmount > 0 && s.lastHover) {
      drawHoverX = s.lastHover.x;
      drawHoverTime = s.lastHover.time;
      hoverEntries = s.lastHoverEntries;
    }

    // Draw multi-series frame
    drawMultiFrame(ctx, layout, {
      series: seriesEntries,
      now,
      showGrid: cfg.showGrid,
      showPulse: cfg.showPulse,
      referenceLine: cfg.referenceLine,
      hoverX: drawHoverX,
      hoverTime: drawHoverTime,
      hoverEntries,
      scrubAmount: s.scrubAmount,
      windowSecs,
      formatValue: cfg.formatValue,
      formatTime: cfg.formatTime,
      gridState: s.gridState,
      timeAxisState: s.timeAxisState,
      dt,
      targetWindowSecs: cfg.windowSecs,
      tooltipY: cfg.tooltipY,
      tooltipOutline: cfg.tooltipOutline,
      chartReveal,
      pauseProgress,
      now_ms,
      primaryPalette: cfg.palette,
    });

    // During reverse morph (chart → loading/empty), overlay the empty text
    // as chartReveal drops — identical to single-series behavior
    const bgAlpha = 1 - chartReveal;
    if (bgAlpha > 0.01 && revealTarget === 0 && !cfg.loading) {
      const bgEmptyAlpha = (1 - loadingAlpha) * bgAlpha;
      if (bgEmptyAlpha > 0.01) {
        drawEmpty(
          ctx,
          w,
          h,
          pad,
          cfg.palette,
          bgEmptyAlpha,
          now_ms,
          true,
          cfg.emptyText
        );
      }
    }

    // No badge in multi-series mode
    return out;
  } else {
    // ═══════════════════════════════════════════════════════
    // LINE MODE PIPELINE
    // ═══════════════════════════════════════════════════════

    const effectivePoints = useStash ? s.lastData : points;

    // Adaptive speed + smooth value (freeze lerp when using stashed data)
    const adaptiveSpeed = computeAdaptiveSpeed(
      cfg.value,
      s.displayValue,
      s.displayMin,
      s.displayMax,
      cfg.lerpSpeed,
      noMotion
    );
    if (!useStash) {
      s.displayValue = lerp(s.displayValue, cfg.value, adaptiveSpeed, pausedDt);
      // Skip snap when pausing — cfg.value keeps changing from the consumer,
      // so the snap would cause visible jumps in a supposedly frozen chart
      if (pauseProgress < 0.5) {
        const prevRange = s.displayMax - s.displayMin || 1;
        if (
          Math.abs(s.displayValue - cfg.value) <
          prevRange * VALUE_SNAP_THRESHOLD
        ) {
          s.displayValue = cfg.value;
        }
      }
    }
    const smoothValue = s.displayValue;

    const chartW = w - pad.left - pad.right;

    // Dynamic buffer: when badge is off, use a smaller buffer so the dot
    // sits closer to the right edge. When momentum arrows + badge are both
    // on, ensure enough gap for the arrows to fit.
    const baseBuffer = cfg.showBadge ? WINDOW_BUFFER : WINDOW_BUFFER_NO_BADGE;
    const needsArrowRoom = cfg.showMomentum && cfg.showBadge;
    const buffer = needsArrowRoom
      ? Math.max(baseBuffer, 37 / Math.max(chartW, 1))
      : baseBuffer;

    // Window transition
    const transition = s.windowTransition;
    if (hasData) s.frozenNow = Date.now() / 1000 - s.timeDebt;
    const now = useStash ? s.frozenNow : Date.now() / 1000 - s.timeDebt;
    const windowResult = updateWindowTransition(
      cfg,
      transition,
      s.displayWindow,
      s.displayMin,
      s.displayMax,
      noMotion,
      now_ms,
      now,
      effectivePoints,
      smoothValue,
      buffer
    );
    s.displayWindow = windowResult.windowSecs;
    const windowSecs = windowResult.windowSecs;
    const windowTransProgress = windowResult.windowTransProgress;

    const rightEdge = now + windowSecs * buffer;
    const leftEdge = rightEdge - windowSecs;

    // Filter visible points — when pausing, contract right edge to `now`
    // so new data (with real-time timestamps) can't appear past the live dot
    const filterRight = rightEdge - (rightEdge - now) * pauseProgress;
    const visible: LivelinePoint[] = [];
    for (const p of effectivePoints) {
      if (p.time >= leftEdge - 2 && p.time <= filterRight) {
        visible.push(p);
      }
    }

    if (visible.length < 2) {
      return out;
    }

    // Compute + smooth Y range
    const computedRange = computeRange(
      visible,
      smoothValue,
      cfg.referenceLine?.value,
      cfg.exaggerate
    );
    const isWindowTransitioning = transition.startMs > 0;
    const rangeResult = updateRange(
      computedRange,
      s.rangeInited,
      s.targetMin,
      s.targetMax,
      s.displayMin,
      s.displayMax,
      isWindowTransitioning,
      windowTransProgress,
      transition,
      adaptiveSpeed,
      chartH,
      pausedDt
    );
    s.rangeInited = rangeResult.rangeInited;
    s.targetMin = rangeResult.targetMin;
    s.targetMax = rangeResult.targetMax;
    s.displayMin = rangeResult.displayMin;
    s.displayMax = rangeResult.displayMax;
    const { minVal, maxVal, valRange } = rangeResult;

    const layout: ChartLayout = {
      w,
      h,
      pad,
      chartW,
      chartH,
      leftEdge,
      rightEdge,
      minVal,
      maxVal,
      valRange,
      toX: (t: number) =>
        pad.left + ((t - leftEdge) / (rightEdge - leftEdge)) * chartW,
      toY: (v: number) => pad.top + (1 - (v - minVal) / valRange) * chartH,
    };

    // Momentum
    const momentum: Momentum = cfg.momentumOverride ?? detectMomentum(visible);

    // Hover + scrub
    const hoverResult = updateHoverState(
      hoverPixelX,
      pad,
      w,
      layout,
      now,
      visible,
      s.scrubAmount,
      s.lastHover,
      noMotion,
      leftEdge,
      rightEdge,
      chartW
    );
    s.scrubAmount = hoverResult.scrubAmount;
    s.lastHover = hoverResult.lastHover;
    if (cfg.hasOnHover && hoverResult.emitPoint) {
      out.emitHover = hoverResult.emitPoint;
    }
    const {
      hoverX: drawHoverX,
      hoverValue: drawHoverValue,
      hoverTime: drawHoverTime,
    } = hoverResult;

    // Compute swing magnitude for particles (recent velocity / visible range)
    const lookback = Math.min(5, visible.length - 1);
    const recentDelta =
      lookback > 0
        ? Math.abs(
            visible[visible.length - 1]!.value -
              visible[visible.length - 1 - lookback]!.value
          )
        : 0;
    const swingMagnitude =
      valRange > 0 ? Math.min(recentDelta / valRange, 1) : 0;

    // Draw canvas content (everything except badge)
    drawFrame(ctx, layout, cfg.palette, {
      visible,
      smoothValue,
      now,
      momentum,
      arrowState: s.arrowState,
      showGrid: cfg.showGrid,
      showMomentum: cfg.showMomentum,
      showPulse: cfg.showPulse,
      showFill: cfg.showFill,
      referenceLine: cfg.referenceLine,
      hoverX: drawHoverX,
      hoverValue: drawHoverValue,
      hoverTime: drawHoverTime,
      scrubAmount: s.scrubAmount,
      windowSecs,
      formatValue: cfg.formatValue,
      formatTime: cfg.formatTime,
      gridState: s.gridState,
      timeAxisState: s.timeAxisState,
      dt,
      targetWindowSecs: cfg.windowSecs,
      tooltipY: cfg.tooltipY,
      tooltipOutline: cfg.tooltipOutline,
      orderbookData: cfg.orderbookData,
      orderbookState: cfg.orderbookData ? s.orderbookState : undefined,
      particleState: cfg.degenOptions ? s.particleState : undefined,
      particleOptions: cfg.degenOptions,
      swingMagnitude,
      shakeState: cfg.degenOptions ? s.shakeState : undefined,
      chartReveal,
      pauseProgress,
      now_ms,
    });

    // During morph (chart ↔ empty), overlay the gradient gap + text on
    // top of the morphing chart line. skipLine=true avoids double-drawing
    // the squiggly. The gap fades in smoothly as chartReveal drops.
    const bgAlpha = 1 - chartReveal;
    if (bgAlpha > 0.01 && revealTarget === 0 && !cfg.loading) {
      const bgEmptyAlpha = (1 - loadingAlpha) * bgAlpha;
      if (bgEmptyAlpha > 0.01) {
        drawEmpty(
          ctx,
          w,
          h,
          pad,
          cfg.palette,
          bgEmptyAlpha,
          now_ms,
          true,
          cfg.emptyText
        );
      }
    }

    // Badge (drawn in-canvas; fades out fully as pauseProgress → 1)
    drawBadge(
      ctx,
      cfg,
      s.badge,
      smoothValue,
      layout,
      momentum,
      isWindowTransitioning,
      noMotion,
      pausedDt,
      chartReveal,
      1 - pauseProgress
    );

    // --- Live value display (delivered to an animated text, no re-renders) ---
    if (cfg.showValue) {
      // When momentum colour is on, strip sign — colour already communicates direction
      const displayVal = cfg.valueMomentumColor
        ? Math.abs(smoothValue)
        : smoothValue;
      out.valueText = cfg.formatValue(displayVal);
      if (cfg.valueMomentumColor) {
        out.valueColor =
          momentum === 'up' ? '#22c55e' : momentum === 'down' ? '#ef4444' : '';
      }
    }

    return out;
  }
}
