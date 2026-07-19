import type {
  LivelinePoint,
  ChartLayout,
  Momentum,
  HoverPoint,
  CandlePoint,
} from '../types';
import { lerp } from '../math/lerp';
import { computeRange } from '../math/range';
import { detectMomentum } from '../math/momentum';
import { interpolateAtTime } from '../math/interpolate';
import type { Ctx2D } from '../draw/canvas2d';
import {
  drawFrame,
  drawMultiFrame,
  drawCandleFrame,
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
  computeCandleRange,
  candleAtX,
  updateCandleRange,
  updateCandleWindowTransition,
} from './candleHelpers';
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
  CANDLE_LERP_SPEED,
  CANDLE_WIDTH_TRANS_MS,
  CLOSE_LINE_LERP_SPEED,
  LINE_DENSITY_MS,
  LINE_LERP_BASE,
  LINE_ADAPTIVE_BOOST,
  LINE_SNAP_THRESHOLD,
  CANDLE_BUFFER_NO_BADGE,
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
    // CANDLE MODE PIPELINE
    // ═══════════════════════════════════════════════════════

    // Badge is never visible in pure candle mode (only during line morph),
    // so always use the smaller buffer to avoid dead space on the right.
    const candleBuffer = CANDLE_BUFFER_NO_BADGE;

    // Frozen now — prevent candles from scrolling during reverse morph
    if (hasData) s.frozenNow = Date.now() / 1000 - s.timeDebt;
    const now =
      hasData || chartReveal < 0.005
        ? Date.now() / 1000 - s.timeDebt
        : s.frozenNow;
    const rawLive = s.pausedCandles
      ? (s.pausedLive ?? undefined)
      : cfg.liveCandle;
    let effectiveLineData = s.pausedLineData ?? cfg.lineData;
    let effectiveLineValue = s.pausedLineValue ?? cfg.lineValue;
    // Stash tick data for reverse morph — keeps tick resolution during morphback
    if (hasData && effectiveLineData && effectiveLineData.length > 0) {
      s.lastLineDataStash = effectiveLineData;
      s.lastLineValueStash = effectiveLineValue;
    }
    if (useStash && s.lastLineDataStash.length > 0) {
      effectiveLineData = s.lastLineDataStash;
      effectiveLineValue = s.lastLineValueStash;
    }
    const candleWidthSecs = cfg.candleWidth ?? 1;

    // --- Candle width morph transition ---
    const cwt = s.candleWidthTrans;
    let morphT = -1;
    let displayCandleWidth: number;
    if (cwt.startMs > 0) {
      const elapsed = now_ms - cwt.startMs;
      const t = Math.min(elapsed / CANDLE_WIDTH_TRANS_MS, 1);
      morphT = (1 - Math.cos(t * Math.PI)) / 2;
      displayCandleWidth = Math.exp(
        Math.log(cwt.fromWidth) +
          (Math.log(cwt.toWidth) - Math.log(cwt.fromWidth)) * morphT
      );
      if (t >= 1) {
        displayCandleWidth = cwt.toWidth;
        cwt.startMs = 0;
        morphT = -1;
      }
    } else {
      displayCandleWidth = cwt.toWidth;
    }
    if (candleWidthSecs !== cwt.toWidth) {
      cwt.oldCandles = s.prevCandleData.candles;
      cwt.oldWidth = s.prevCandleData.width;
      cwt.fromWidth = displayCandleWidth;
      cwt.toWidth = candleWidthSecs;
      cwt.startMs = now_ms;
      morphT = 0;
      cwt.rangeFromMin = s.displayMin;
      cwt.rangeFromMax = s.displayMax;
      const curWindow = s.displayWindow;
      const re = now + curWindow * candleBuffer;
      const le = re - curWindow;
      const targetVis: CandlePoint[] = [];
      for (const c of effectiveCandles) {
        if (c.time + candleWidthSecs >= le && c.time <= re) targetVis.push(c);
      }
      if (rawLive) targetVis.push(rawLive);
      if (targetVis.length > 0) {
        const tr = computeCandleRange(targetVis);
        cwt.rangeToMin = tr.min;
        cwt.rangeToMax = tr.max;
      } else {
        cwt.rangeToMin = s.displayMin;
        cwt.rangeToMax = s.displayMax;
      }
    }
    s.prevCandleData = { candles: cfg.candles ?? [], width: candleWidthSecs };

    // lineModeProg is updated before the early return (see above).
    const lineModeProg = s.lineModeProg;

    // --- Line density transition ---
    const ldt = s.lineDensityTrans;
    const hasTickData = effectiveLineData && effectiveLineData.length > 0;
    const densityTarget =
      cfg.lineMode && lineModeProg >= 0.3 && hasTickData ? 1 : 0;
    if (ldt.to !== densityTarget) {
      ldt.from = s.lineDensityProg;
      ldt.to = densityTarget;
      ldt.startMs = now_ms;
    }
    let lineDensityProg: number;
    if (ldt.startMs > 0) {
      const elapsed = now_ms - ldt.startMs;
      const t = Math.min(elapsed / LINE_DENSITY_MS, 1);
      lineDensityProg =
        ldt.from + (ldt.to - ldt.from) * (1 - (1 - t) * (1 - t));
      if (t >= 1) {
        lineDensityProg = ldt.to;
        ldt.startMs = 0;
      }
    } else {
      lineDensityProg = ldt.to;
    }
    s.lineDensityProg = lineDensityProg;

    // --- Window transition ---
    const transition = s.windowTransition;
    const windowResult = updateCandleWindowTransition(
      cfg.windowSecs,
      transition,
      s.displayWindow,
      s.displayMin,
      s.displayMax,
      now_ms,
      now,
      effectiveCandles,
      rawLive,
      candleWidthSecs,
      candleBuffer
    );
    s.displayWindow = windowResult.windowSecs;
    const windowSecs = windowResult.windowSecs;
    const windowTransProgress = windowResult.windowTransProgress;
    const isWindowTransitioning = transition.startMs > 0;

    const rightEdge = now + windowSecs * candleBuffer;
    const leftEdge = rightEdge - windowSecs;

    // --- Live candle OHLC lerp ---
    let smoothLive: CandlePoint | undefined;
    if (rawLive) {
      const prev = s.displayCandle;
      if (!prev || prev.time !== rawLive.time) {
        s.displayCandle = {
          time: rawLive.time,
          open: rawLive.open,
          high: rawLive.open,
          low: rawLive.open,
          close: rawLive.open,
        };
        s.liveBirthAlpha = 0;
      } else {
        const dc = s.displayCandle!;
        dc.open = lerp(dc.open, rawLive.open, CANDLE_LERP_SPEED, pausedDt);
        dc.high = lerp(dc.high, rawLive.high, CANDLE_LERP_SPEED, pausedDt);
        dc.low = lerp(dc.low, rawLive.low, CANDLE_LERP_SPEED, pausedDt);
        dc.close = lerp(dc.close, rawLive.close, CANDLE_LERP_SPEED, pausedDt);
      }
      s.liveBirthAlpha = lerp(s.liveBirthAlpha, 1, 0.2, pausedDt);
      if (s.liveBirthAlpha > 0.99) s.liveBirthAlpha = 1;
      const dc = s.displayCandle!;
      const bullTarget = dc.close >= dc.open ? 1 : 0;
      s.liveBull = lerp(s.liveBull, bullTarget, 0.12, pausedDt);
      if (s.liveBull > 0.99) s.liveBull = 1;
      if (s.liveBull < 0.01) s.liveBull = 0;
      smoothLive = dc;
    } else {
      s.displayCandle = null;
      s.liveBirthAlpha = 1;
      s.liveBull = 0.5;
    }

    // --- Smooth close for dashed price line ---
    // Tracks rawLive.close at candle-body speed but never resets on candle
    // birth, so the dashed line doesn't jump when a new candle starts.
    if (rawLive) {
      if (!s.closeLineSmoothInited) {
        s.closeLineSmooth = rawLive.close;
        s.closeLineSmoothInited = true;
      } else {
        s.closeLineSmooth = lerp(
          s.closeLineSmooth,
          rawLive.close,
          CLOSE_LINE_LERP_SPEED,
          pausedDt
        );
        const gap = Math.abs(s.closeLineSmooth - rawLive.close);
        const range = s.displayMax - s.displayMin || 1;
        if (gap < range * 0.0005) s.closeLineSmooth = rawLive.close;
      }
    } else if (!useStash) {
      s.closeLineSmoothInited = false;
    }

    // --- Smooth close for line mode ---
    if (rawLive) {
      if (!s.lineSmoothInited) {
        s.lineSmoothClose = rawLive.close;
        s.lineSmoothInited = true;
      } else {
        const valGap = Math.abs(rawLive.close - s.lineSmoothClose);
        const prevRange = s.displayMax - s.displayMin || 1;
        const gapRatio = Math.min(valGap / prevRange, 1);
        const adaptiveSpeed =
          LINE_LERP_BASE + (1 - gapRatio) * LINE_ADAPTIVE_BOOST;
        s.lineSmoothClose = lerp(
          s.lineSmoothClose,
          rawLive.close,
          adaptiveSpeed,
          pausedDt
        );
        if (valGap < prevRange * LINE_SNAP_THRESHOLD) {
          s.lineSmoothClose = rawLive.close;
        }
      }
    } else if (!useStash) {
      // Only reset when not using stash — during reverse morph,
      // freeze the smooth value (matches line mode's displayValueRef freeze)
      s.lineSmoothInited = false;
    }

    // --- Smooth tick value for density transition ---
    if (effectiveLineValue !== undefined && hasTickData) {
      if (!s.lineTickSmoothInited) {
        s.lineTickSmooth = effectiveLineValue;
        s.lineTickSmoothInited = true;
      } else {
        const valGap = Math.abs(effectiveLineValue - s.lineTickSmooth);
        const prevRange = s.displayMax - s.displayMin || 1;
        const gapRatio = Math.min(valGap / prevRange, 1);
        const adaptiveSpeed =
          LINE_LERP_BASE + (1 - gapRatio) * LINE_ADAPTIVE_BOOST;
        s.lineTickSmooth = lerp(
          s.lineTickSmooth,
          effectiveLineValue,
          adaptiveSpeed,
          pausedDt
        );
        if (valGap < prevRange * LINE_SNAP_THRESHOLD) {
          s.lineTickSmooth = effectiveLineValue;
        }
      }
    } else if (!useStash) {
      s.lineTickSmoothInited = false;
    }

    // --- Build visible candles ---
    const visible: CandlePoint[] = [];
    for (const c of effectiveCandles) {
      if (c.time + candleWidthSecs >= leftEdge && c.time <= rightEdge) {
        visible.push(c);
      }
    }
    if (
      smoothLive &&
      smoothLive.time + displayCandleWidth >= leftEdge &&
      smoothLive.time <= rightEdge
    ) {
      visible.push(smoothLive);
    }
    let oldVisible: CandlePoint[] = [];
    if (morphT >= 0 && cwt.oldCandles.length > 0) {
      for (const c of cwt.oldCandles) {
        if (c.time + cwt.oldWidth >= leftEdge && c.time <= rightEdge) {
          oldVisible.push(c);
        }
      }
    }

    // Stash visible candles for reverse morph
    if (hasData) {
      s.lastCandles = visible;
      s.lastLive = smoothLive ?? null;
    }
    const effectiveVisible = useStash ? s.lastCandles : visible;
    const effectiveLive = useStash ? (s.lastLive ?? undefined) : smoothLive;

    // --- Range computation ---
    // Always use full OHLC range regardless of line mode progress.
    // The close-only and tick-level ranges are tighter (no wicks),
    // so blending between them during morphs shifts the Y axis and
    // causes visible grid label drift + line position jumps.
    // Using one consistent OHLC range means zero range change during
    // the morph — the line gets slightly more Y margin in line mode
    // (room for wicks it doesn't use) but that's an acceptable trade-off.
    const chartW = w - pad.left - pad.right;
    const computed =
      effectiveVisible.length > 0
        ? computeCandleRange(effectiveVisible)
        : { min: s.displayMin, max: s.displayMax };

    const rangeResult = updateCandleRange(
      computed,
      s.rangeInited,
      s.displayMin,
      s.displayMax,
      isWindowTransitioning,
      windowTransProgress,
      transition,
      chartH,
      pausedDt
    );
    if (morphT >= 0) {
      rangeResult.displayMin =
        cwt.rangeFromMin + (cwt.rangeToMin - cwt.rangeFromMin) * morphT;
      rangeResult.displayMax =
        cwt.rangeFromMax + (cwt.rangeToMax - cwt.rangeFromMax) * morphT;
      rangeResult.minVal = rangeResult.displayMin;
      rangeResult.maxVal = rangeResult.displayMax;
      rangeResult.valRange =
        rangeResult.displayMax - rangeResult.displayMin || 0.001;
    }
    s.rangeInited = rangeResult.rangeInited;
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

    // --- Hover + scrub ---
    const hoverPx = hoverPixelX;
    let hoveredCandle: CandlePoint | null = null;
    let isActiveHover = false;
    if (hoverPx !== null && hoverPx >= pad.left && hoverPx <= w - pad.right) {
      hoveredCandle = candleAtX(
        effectiveVisible,
        hoverPx,
        displayCandleWidth,
        layout
      );
      if (hoveredCandle) isActiveHover = true;
    }
    const scrubTarget = isActiveHover ? 1 : 0;
    s.scrubAmount = lerp(s.scrubAmount, scrubTarget, 0.12, dt);
    if (s.scrubAmount < 0.01) s.scrubAmount = 0;
    if (s.scrubAmount > 0.99) s.scrubAmount = 1;
    const scrubAmount = s.scrubAmount;

    let drawHoverX = hoverPx;
    let drawHoverTime = 0;
    let drawHoverCandle: CandlePoint | null = hoveredCandle;
    if (!isActiveHover && scrubAmount > 0 && s.lastHover) {
      drawHoverX = s.lastHover.x;
      drawHoverTime = s.lastHover.time;
      drawHoverCandle = candleAtX(
        effectiveVisible,
        s.lastHover.x,
        displayCandleWidth,
        layout
      );
    } else if (isActiveHover && hoverPx !== null) {
      drawHoverTime =
        layout.leftEdge +
        ((hoverPx - pad.left) / chartW) * (layout.rightEdge - layout.leftEdge);
      s.lastHover = {
        x: hoverPx,
        value: hoveredCandle?.close ?? 0,
        time: drawHoverTime,
      };
    }

    let drawCandles = effectiveVisible;
    let drawOldCandles = oldVisible;
    let drawLive = effectiveLive;

    // Line mode: blend live close toward smooth close
    if (lineModeProg > 0.01 && drawLive && s.lineSmoothInited) {
      const blended =
        drawLive.close + (s.lineSmoothClose - drawLive.close) * lineModeProg;
      drawLive = { ...drawLive, close: blended };
      const li = drawCandles.length - 1;
      if (li >= 0 && drawCandles[li]!.time === drawLive.time) {
        drawCandles = drawCandles.slice();
        drawCandles[li] = { ...drawCandles[li]!, close: blended };
      }
    }

    // Line mode OHLC collapse
    if (lineModeProg > 0.01 && lineModeProg < 0.99) {
      const collapseOHLC = (c: CandlePoint): CandlePoint => {
        const inv = 1 - lineModeProg;
        return {
          time: c.time,
          open: c.close + (c.open - c.close) * inv,
          high: c.close + (c.high - c.close) * inv,
          low: c.close + (c.low - c.close) * inv,
          close: c.close,
        };
      };
      drawCandles = drawCandles.map(collapseOHLC);
      if (drawOldCandles.length > 0)
        drawOldCandles = drawOldCandles.map(collapseOHLC);
      if (drawLive) drawLive = collapseOHLC(drawLive);
    }

    // Build lineVisible for drawLine — value-space points that drawLine
    // converts to screen coords with its own morphY/alpha/color logic.
    // Use tick-level resolution whenever the line is visible (lineModeProg > 0.05),
    // not just when lineDensityProg > 0.01.  The density transition finishes
    // 150ms before the line fades out; without this, lineVisible abruptly drops
    // from ~300 smooth points to ~5 stepped candle-close points while the line
    // is still at ~30% opacity, causing a visible shape jump.
    let lineVisible: LivelinePoint[];
    let lineSmoothValue: number;
    if (
      effectiveLineData &&
      effectiveLineData.length > 0 &&
      (lineDensityProg > 0.01 || lineModeProg > 0.05)
    ) {
      // Density transition: blend candle-close values toward tick values
      const closeRefs: { t: number; v: number }[] = [];
      for (const c of drawCandles) {
        closeRefs.push({ t: c.time + displayCandleWidth / 2, v: c.close });
      }
      if (drawLive) closeRefs.push({ t: now, v: drawLive.close });

      lineVisible = [];
      let refIdx = 0;
      for (const pt of effectiveLineData) {
        if (pt.time < leftEdge || pt.time > rightEdge) continue;
        while (
          refIdx < closeRefs.length - 2 &&
          closeRefs[refIdx + 1]!.t < pt.time
        ) {
          refIdx++;
        }
        let interpClose: number;
        if (closeRefs.length === 0) {
          interpClose = pt.value;
        } else if (closeRefs.length === 1 || pt.time <= closeRefs[0]!.t) {
          interpClose = closeRefs[0]!.v;
        } else if (refIdx >= closeRefs.length - 1) {
          interpClose = closeRefs[closeRefs.length - 1]!.v;
        } else {
          const a = closeRefs[refIdx]!;
          const b = closeRefs[refIdx + 1]!;
          const span = b.t - a.t;
          const frac =
            span > 0 ? Math.max(0, Math.min(1, (pt.time - a.t) / span)) : 0;
          interpClose = a.v + (b.v - a.v) * frac;
        }
        const blended =
          interpClose + (pt.value - interpClose) * lineDensityProg;
        lineVisible.push({ time: pt.time, value: blended });
      }

      const smoothTick = s.lineTickSmoothInited
        ? s.lineTickSmooth
        : (effectiveLineValue ??
          effectiveLineData[effectiveLineData.length - 1]!.value);
      // No explicit live tip — drawLine appends one at toX(now) using lineSmoothValue
      lineSmoothValue =
        s.lineSmoothClose + (smoothTick - s.lineSmoothClose) * lineDensityProg;
    } else {
      // Candle-close resolution — no live tip; drawLine appends one at toX(now)
      lineVisible = drawCandles.map((c) => ({
        time: c.time + displayCandleWidth / 2,
        value: c.close,
      }));
      lineSmoothValue = s.lineSmoothInited
        ? s.lineSmoothClose
        : (drawLive?.close ?? drawCandles[drawCandles.length - 1]?.close ?? 0);
    }

    // Pad lineVisible to span full chart width during reveal morph.
    // Without this, data that doesn't fill the window creates a partial-width
    // line that pops when it hands off to the full-width loading squiggly.
    if (chartReveal < 1 && lineVisible.length >= 2) {
      const firstTime = lineVisible[0]!.time;
      const windowSpan = rightEdge - leftEdge;
      if (firstTime - leftEdge > windowSpan * 0.05) {
        const firstVal = lineVisible[0]!.value;
        const step = windowSpan / 32;
        const padded: LivelinePoint[] = [];
        for (let t = leftEdge; t < firstTime - step * 0.5; t += step) {
          padded.push({ time: t, value: firstVal });
        }
        lineVisible = [...padded, ...lineVisible];
      }
    }

    // --- Draw ---
    drawCandleFrame(ctx, layout, cfg.palette, {
      candles: drawCandles,
      displayCandleWidth,
      oldCandles: drawOldCandles,
      oldWidth: cwt.oldWidth,
      morphT,
      liveCandle: drawLive,
      closePriceCandle:
        s.closeLineSmoothInited && rawLive
          ? { ...rawLive, close: s.closeLineSmooth }
          : rawLive,
      liveTime: effectiveLive?.time ?? -1,
      liveBirthAlpha: s.liveBirthAlpha,
      liveBullBlend: s.liveBull,
      lineModeProg,
      chartReveal,
      now_ms,
      now,
      pauseProgress,
      showGrid: cfg.showGrid,
      scrubAmount,
      hoverX: drawHoverX,
      hoverValue: drawHoverCandle?.close ?? null,
      hoverTime: drawHoverTime,
      hoveredCandle: drawHoverCandle,
      formatValue: cfg.formatValue,
      formatTime: cfg.formatTime,
      gridState: s.gridState,
      timeAxisState: s.timeAxisState,
      dt: pausedDt,
      targetWindowSecs: cfg.windowSecs,
      tooltipY: cfg.tooltipY,
      tooltipOutline: cfg.tooltipOutline,
      lineVisible,
      lineSmoothValue,
      emptyText: cfg.emptyText,
      loadingAlpha,
      // Show empty overlay when not loading AND loadingAlpha has fully
      // decayed. This prevents the gradient gap from flashing during
      // loading→live (where loadingAlpha starts at ~1), while still
      // allowing smooth fade-out during empty→live (loadingAlpha is 0).
      showEmptyOverlay: !(cfg.loading ?? false) && loadingAlpha < 0.01,
    });

    // Badge in candle mode — only when in line mode (lineModeProg > 0.5)
    if (s.lineModeProg > 0.5 && cfg.showBadge) {
      const momentum = detectMomentum(lineVisible);
      const badgeFade = (s.lineModeProg - 0.5) * 2;
      drawBadge(
        ctx,
        cfg,
        s.badge,
        lineSmoothValue,
        layout,
        momentum,
        isWindowTransitioning,
        noMotion,
        pausedDt,
        chartReveal,
        badgeFade * (1 - pauseProgress)
      );
    }

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
        // Emit only when the hovered point actually changed — a stationary
        // finger must not fire runOnJS every frame.
        const ev = hoverEntries[0]?.value ?? 0;
        if (
          s.lastEmitHover === null ||
          s.lastEmitHover.time !== t ||
          s.lastEmitHover.value !== ev
        ) {
          s.lastEmitHover = { time: t, value: ev };
          out.emitHover = {
            time: t,
            value: ev,
            x: clampedX,
            y: layout.toY(ev),
          };
        }
      }
    }
    if (!isActiveHover) s.lastEmitHover = null;

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
      // Emit only when the hovered point actually changed — a stationary
      // finger must not fire runOnJS every frame.
      const ep = hoverResult.emitPoint;
      if (
        s.lastEmitHover === null ||
        s.lastEmitHover.time !== ep.time ||
        s.lastEmitHover.value !== ep.value
      ) {
        s.lastEmitHover = { time: ep.time, value: ep.value };
        out.emitHover = ep;
      }
    }
    if (!hoverResult.isActiveHover) s.lastEmitHover = null;
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
