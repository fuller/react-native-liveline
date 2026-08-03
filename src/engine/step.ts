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
import { easeInOutCos } from '../math/ease';
import { filterVisiblePointsInto } from '../math/visible';
import type { SkPicture } from '@shopify/react-native-skia';
import type { Ctx2D } from '../draw/canvas2d';
import {
  drawFrame,
  drawMultiFrame,
  drawCandleFrame,
  drawEdgeFade,
  type MultiSeriesEntry,
} from '../draw';
import { shouldBuildLineOverlay } from '../draw/lineOverlay';
import { drawLoading } from '../draw/loading';
import { drawEmpty } from '../draw/empty';
import type { EngineConfigStep, FrameInputs } from './types';
import type { EngineState } from './state';
import { perSeriesMaps, pruneByIds } from './state';
import { drawBadge } from './badge';
import { updateGridLayer } from './gridLayer';
import { updateLineScrollLayer } from './lineScrollLayer';
import { lineCacheHits, lineScrollDx } from '../draw/lineCache';
import { canCompositeLineScroll } from '../draw/lineScrollLayer';
import { scrollLayerUsable } from '../draw/scrollLayer';
import {
  computeAdaptiveSpeed,
  updateWindowTransition,
  updateRange,
  updateHoverState,
  makeLayout,
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
  CANDLE_SNAP_THRESHOLD,
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
  /**
   * The scroll layer's picture for this frame, or null when nothing may be
   * composited there and the screen picture already holds the whole frame
   * (every pipeline except single-series line, and any single-series frame
   * that fails the alpha gate or the cache check — see
   * draw/lineScrollLayer.ts). The caller publishes an empty picture for
   * null; it must never leave a stale picture composited.
   */
  scrollPicture: SkPicture | null;
  /**
   * `translateX` for the scroll layer, in screen pixels — meaningless (and
   * always 0) when `scrollPicture` is null.
   */
  scrollDx: number;
  /** Live value display text (line mode + showValue), null = leave unchanged */
  valueText: string | null;
  /** Live value display color ('' = default color) */
  valueColor: string | null;
}

/**
 * Which backing array a draw pipeline's points came from this frame, for
 * the line path cache's invalidation key (see draw/lineCache.ts):
 * 0 = live buffer, 1 = paused snapshot, 2 = reverse-morph stash.
 */
function dataSourceOf(useStash: boolean, hasPausedSnapshot: boolean): number {
  'worklet';
  return useStash ? 2 : hasPausedSnapshot ? 1 : 0;
}

/** Shared empty-array fallback — avoids a fresh `[]` allocation at every
 * lookup miss below (mirrors `EMPTY_CANDLES` in useLivelineEngine.ts). */
const EMPTY_MULTI_POINTS: LivelinePoint[] = [];

/** Stable empty array handed to `drawCandleFrame` as `lineVisible` on the
 * frames where the line overlay provably isn't drawn — see the
 * `wantLineVisible` gate in the candle pipeline below. Separate from
 * `EMPTY_MULTI_POINTS` purely so neither const's purpose has to be inferred
 * from the other's call sites; both are read-only. */
const EMPTY_LINE_POINTS: LivelinePoint[] = [];

/** Stable empty arrays for the *other* mode's slot in the `points` /
 * `effectiveCandles` pair below — exactly one of the two is real on any
 * given frame and the unused one is never read past its `.length` check,
 * so both may share a module-level empty. Read-only, like the two above. */
const EMPTY_POINTS_SLOT: LivelinePoint[] = [];
const EMPTY_CANDLES_SLOT: CandlePoint[] = [];

/** Stable empty array for multi-series hover entries on frames with no
 * active hover — which is nearly all of them. A fresh array is allocated
 * only inside the active-hover branch, where it is retained in
 * `s.lastHoverEntries` for the scrub fade-out and so genuinely cannot be
 * pooled. Read-only (`drawMultiFrame` only reads it). */
const EMPTY_HOVER_ENTRIES: { color: string; label: string; value: number }[] =
  [];

/**
 * Look up a multi-series entry's data points. `series` is either a live
 * `cfg.multiSeries` entry (no `.data` — its points live in `multiData`,
 * keyed by id, synced via its own delta-updated buffer) or a reverse-morph
 * stash entry from `s.lastMultiSeries` (a `StashedSeries`, which carries its
 * own `.data` copy directly — see the doc comment on `StashedSeries` in
 * state.ts). Checking `.data` first covers both without the caller needing
 * to know which one it has.
 */
function multiSeriesData(
  series: { id: string; data?: LivelinePoint[] },
  multiData: Record<string, LivelinePoint[]>
): LivelinePoint[] {
  'worklet';
  return series.data ?? multiData[series.id] ?? EMPTY_MULTI_POINTS;
}

/**
 * One frame of the liveline engine — a direct port of the web version's
 * rAF `draw` callback, minus the DOM (badge and live value are handled via
 * the canvas and returned StepOutput). Runs entirely on the UI thread.
 *
 * Candle mode is not yet ported; it renders the loading/empty fallback.
 */
/**
 * Publish a blank live-value readout before an early return.
 *
 * `StepOutput.valueText` is `null` by default and the caller treats `null` as
 * "leave the shared value unchanged" — which is right for the modes that do
 * not own the readout, but wrong for an early return that draws no chart at
 * all. Without this, a chart that mounts with no data, loses every point out
 * of the window, or switches to a multi-series config whose data has not
 * arrived, keeps displaying whatever number the *previous* mode last wrote,
 * forever.
 *
 * `''` (not `null`) is the point: it is a real value that overwrites the stale
 * one. Only written when the consumer actually asked for the readout, so
 * charts without `showValue` publish nothing and cost nothing.
 */
function publishBlankValue(out: StepOutput, cfg: EngineConfigStep): void {
  'worklet';
  if (!cfg.showValue) return;
  out.valueText = '';
  out.valueColor = '';
}

export function engineStep(
  ctx: Ctx2D,
  cfg: EngineConfigStep,
  s: EngineState,
  /** This frame's varying inputs — see `FrameInputs`. Pooled on `EngineState`
   * as `s.frameInputs`; the caller fills it in place and passes it, so the
   * struct costs no allocation per frame. */
  frame: FrameInputs
): StepOutput {
  'worklet';
  // Destructured to the names the body below already uses. Local bindings
  // only — nothing is copied and nothing is allocated.
  const { w, h, dt, now_ms, fonts, data, candles, multiData } = frame;
  const hoverPixelXRaw = frame.hoverPixelX;
  const out: StepOutput = {
    valueText: null,
    valueColor: null,
    scrollPicture: null,
    scrollDx: 0,
  };

  const noMotion = cfg.noMotion;
  const hoverPixelX = cfg.scrub ? hoverPixelXRaw : null;

  // --- Mode-specific pause data snapshot ---
  const isCandle = cfg.mode === 'candle';

  if (isCandle) {
    if (cfg.paused && s.pausedCandles === null && candles.length > 0) {
      s.pausedCandles = candles.slice();
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
        const seriesData = multiData[series.id] ?? EMPTY_MULTI_POINTS;
        if (seriesData.length >= 2) {
          snap.set(series.id, {
            data: seriesData.slice(),
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
    if (cfg.paused && s.pausedData === null && data.length >= 2) {
      s.pausedData = data.slice();
    }
    if (!cfg.paused) {
      s.pausedData = null;
    }
  }

  const points = isCandle ? EMPTY_POINTS_SLOT : (s.pausedData ?? data);
  const effectiveCandles = isCandle
    ? (s.pausedCandles ?? candles)
    : EMPTY_CANDLES_SLOT;
  const hasMultiData =
    cfg.isMultiSeries && cfg.multiSeries
      ? cfg.multiSeries.some(
          (series) => (multiData[series.id] ?? EMPTY_MULTI_POINTS).length >= 2
        )
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
      // The point-array copy is revision-gated; the cheap fields are not.
      // This stash is only *read* during the reverse morph (`useMultiStash`,
      // i.e. `!hasData`), but it used to re-`.slice()` every series' whole
      // buffer on every frame — four series of a couple thousand points at
      // 60fps is ~half a million element copies a second, essentially all
      // of it thrown away. The data only changes when that series' delta
      // lands (a few times a second at most), which `multiRevs` now tells
      // us exactly. `value`/`palette`/`label` are still refreshed every
      // frame: they can change without the data changing (a theme or accent
      // switch), and a stale palette here would show up as the wrong colour
      // during a morph-back.
      const stashRevs = s.lastMultiStashRevs;
      const stashData = s.lastMultiStashData;
      s.lastMultiSeries = cfg.multiSeries.map((series) => {
        const rev = cfg.multiRevs?.[series.id] ?? 0;
        let stashed = stashData.get(series.id);
        if (stashed === undefined || stashRevs.get(series.id) !== rev) {
          // Copy — `multiData[series.id]` aliases the live per-series buffer
          // (mutated in place by the JS-thread delta applier via
          // `.modify()`), so a bare reference here would let future ticks
          // silently rewrite this stash. Same reasoning as `s.lastData`
          // above and `s.lastCandles` in the candle pipeline.
          stashed = (multiData[series.id] ?? EMPTY_MULTI_POINTS).slice();
          stashData.set(series.id, stashed);
          stashRevs.set(series.id, rev);
        }
        return {
          id: series.id,
          data: stashed,
          value: series.value,
          palette: series.palette,
          label: series.label,
        };
      });
      // Prune bookkeeping for removed series (same shape as the
      // `displayValues`/`lineCaches` cleanup in the multi pipeline below —
      // the size check makes the steady state allocation- and iteration-free).
      if (stashData.size > cfg.multiSeries.length) {
        const live = new Set<string>();
        for (const series of cfg.multiSeries) live.add(series.id);
        for (const id of stashData.keys()) {
          if (!live.has(id)) {
            stashData.delete(id);
            stashRevs.delete(id);
          }
        }
      }
    }
    // Clear multi stash when single-series data arrives
    if (hasData && !cfg.isMultiSeries) s.lastMultiSeries = [];

    useStash =
      !useMultiStash &&
      !hasData &&
      chartReveal > 0.005 &&
      s.lastData.length >= 2;
    // Copy — `points` may alias the live data buffer (mutated in place by
    // the JS-thread delta applier via `.modify()`), so a bare reference
    // here would let future ticks silently rewrite this stash.
    //
    // Revision-gated for the same reason as the multi-series stash above:
    // this is only read during the reverse morph, but copying the whole
    // buffer every frame meant ~120k element copies a second on a 2000-point
    // feed to maintain something that changes a few times a second.
    // `dataRev` moves exactly when the buffer does. (`points` is
    // `s.pausedData ?? data`; while paused the snapshot is frozen, so its
    // contents match what was already stashed and skipping is still correct.)
    if (hasData && !cfg.isMultiSeries && s.lastDataStashRev !== cfg.dataRev) {
      s.lastData = points.slice();
      s.lastDataStashRev = cfg.dataRev;
    }
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
      s.lineModeProg = lmt.from + (lmt.to - lmt.from) * easeInOutCos(t);
      if (t >= 1) {
        s.lineModeProg = lmt.to;
        lmt.startMs = 0;
      }
    } else {
      s.lineModeProg = lmt.to;
    }
  }

  // Per-series bookkeeping is pruned *inside* the multi pipeline, which
  // stops running the instant the chart leaves multi-series mode (mode
  // switch, `isMultiSeries` going false, or the series list emptying out).
  // Everything keyed by series id then survives indefinitely — including
  // `lineCaches`, which retains an SkPath per series — so a chart that
  // toggles multi → single → multi with a different series set accumulates
  // them. Sibling of the within-multi-mode prune below (PLAN_MAINT #3);
  // deliberately placed above the loading/empty early return so the
  // "multiSeries went empty" case is covered too. `displayValues` is
  // written for every series on every non-stash multi frame, so a non-zero
  // size is an exact "this chart has multi state to drop" test, and it
  // becomes 0 on the first frame after the switch — no per-frame work, and
  // the one `Set` allocation happens only on that transition frame.
  // Mirrors the multi pipeline's own `else if` condition below, `isCandle`
  // included — a chart that switches straight from multi to candle mode
  // while `isMultiSeries` is still set has left the pipeline just as surely.
  const inMultiPipeline =
    !isCandle &&
    ((cfg.isMultiSeries && cfg.multiSeries && cfg.multiSeries.length > 0) ||
      useMultiStash);
  if (!inMultiPipeline && s.displayValues.size > 0) {
    pruneByIds(new Set<string>(), perSeriesMaps(s));
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
    publishBlankValue(out, cfg);
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
      morphT = easeInOutCos(t);
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
    // Copy — `candles` is the live candle buffer (mutated in place by the
    // JS-thread delta applier via `.modify()`); stashing a bare reference
    // would let a later tick silently rewrite `cwt.oldCandles` (read on a
    // future candle-width-change frame) out from under this snapshot.
    //
    // Revision-gated for the same reason as `s.lastData` above: the copy's
    // only consumer is the `candleWidthSecs !== cwt.toWidth` branch directly
    // above — i.e. frames where the *user* changed candle width — while this
    // ran unconditionally, copying the whole buffer every frame. A 500-candle
    // chart at 120Hz was allocating 60k objects a second and discarding all
    // of them. `cfg.candlesRev` moves exactly when the buffer does.
    //
    // `.width` is deliberately still refreshed every frame (a scalar, no
    // allocation): the branch above reads it as `cwt.oldWidth`, and its
    // correctness depends on it holding the *previous* frame's width, not
    // the width the point copy happens to have been taken at. Mutated in
    // place rather than replaced so the object identity is stable; the
    // `.candles` slot is *reassigned* (never spliced) on a new revision, so
    // a `cwt.oldCandles` reference grabbed earlier still points at the
    // snapshot it was given.
    const prevCandleData = s.prevCandleData;
    if (s.prevCandleDataRev !== cfg.candlesRev) {
      prevCandleData.candles = candles.slice();
      s.prevCandleDataRev = cfg.candlesRev;
    }
    prevCandleData.width = candleWidthSecs;

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
        // Exact snap once each component is within an epsilon of its
        // target — every sibling lerp in this codebase does this (see
        // updateCandleRange's pxThreshold, LINE_SNAP_THRESHOLD/
        // VALUE_SNAP_THRESHOLD elsewhere in this file). Without it, high/low
        // never becomes bit-exact with rawLive; since computeCandleRange
        // scans the live candle too, that epsilon drift keeps nudging
        // displayMax/displayMin whenever the live candle holds the visible
        // extreme, which mismatches the candle cache's kMinVal/kMaxVal and
        // forces a full geometry rebuild every frame.
        const prevRange = s.displayMax - s.displayMin || 1;
        if (
          Math.abs(dc.open - rawLive.open) <
          prevRange * CANDLE_SNAP_THRESHOLD
        ) {
          dc.open = rawLive.open;
        }
        if (
          Math.abs(dc.high - rawLive.high) <
          prevRange * CANDLE_SNAP_THRESHOLD
        ) {
          dc.high = rawLive.high;
        }
        if (
          Math.abs(dc.low - rawLive.low) <
          prevRange * CANDLE_SNAP_THRESHOLD
        ) {
          dc.low = rawLive.low;
        }
        if (
          Math.abs(dc.close - rawLive.close) <
          prevRange * CANDLE_SNAP_THRESHOLD
        ) {
          dc.close = rawLive.close;
        }
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
    // Reused scratch array (see EngineState.candleVisibleScratch) instead of
    // a fresh allocation every frame — same rationale as visibleScratch.
    const visible: CandlePoint[] = s.candleVisibleScratch;
    visible.length = 0;
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
    // Reused scratch array (see EngineState.candleOldVisibleScratch) — same
    // rationale as `visible` above; nothing retains it past this frame.
    const oldVisible: CandlePoint[] = s.candleOldVisibleScratch;
    oldVisible.length = 0;
    if (morphT >= 0 && cwt.oldCandles.length > 0) {
      for (const c of cwt.oldCandles) {
        if (c.time + cwt.oldWidth >= leftEdge && c.time <= rightEdge) {
          oldVisible.push(c);
        }
      }
    }

    // Stash visible candles for reverse morph. Copy — `visible` above is a
    // reused scratch array (`candleVisibleScratch`), refilled in place next
    // frame; a bare reference here (the old behavior, back when `visible`
    // was a fresh array every frame) would let next frame's refill silently
    // corrupt this stash out from under the reverse morph. Mirrors the
    // `s.lastData = points.slice()` copy above and its comment, for the
    // same reason.
    //
    // The `.slice()` alone is not enough, though: `visible`'s last element
    // IS `smoothLive` === `s.displayCandle`, whose OHLC is lerped in place
    // every frame above — so a copied array full of live references would
    // still keep moving during the reverse morph, and `s.lastLive` pointed
    // at the same moving object. Freeze the live candle's *values* too, into
    // a pooled slot (see EngineState.lastLiveStash). Pooling is safe because
    // this block only runs while `hasData`, and the stash is only read while
    // `!hasData` (`useStash`) — disjoint sets of frames.
    if (hasData) {
      s.lastCandles = visible.slice();
      if (smoothLive) {
        const frozen = s.lastLiveStash;
        frozen.time = smoothLive.time;
        frozen.open = smoothLive.open;
        frozen.high = smoothLive.high;
        frozen.low = smoothLive.low;
        frozen.close = smoothLive.close;
        const li = s.lastCandles.length - 1;
        if (li >= 0 && s.lastCandles[li] === smoothLive) {
          s.lastCandles[li] = frozen;
        }
        s.lastLive = frozen;
      } else {
        s.lastLive = null;
      }
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

    const layout: ChartLayout = makeLayout(
      w,
      h,
      pad,
      chartW,
      chartH,
      leftEdge,
      rightEdge,
      rangeResult
    );

    // Cross-frame grid picture cache — see engine/gridLayer.ts. Bypassed
    // while the reveal morph is animating: ctx.drawPicture ignores
    // globalAlpha, so compositing a cached picture during the fade-in
    // would visibly snap to full opacity instead of ramping. Uses
    // pausedDt (not dt) to match the dt this branch's own drawGrid call
    // (via CandleDrawOptions.dt below) already uses, so label fades
    // freeze/resume with pause exactly as they did before this cache.
    if (cfg.showGrid && chartReveal >= 1) {
      updateGridLayer(
        s.gridLayer,
        s.gridState,
        layout,
        cfg.palette,
        cfg.formatValue,
        pausedDt,
        s.gridLayerCache,
        fonts
      );
    }

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
    // Is the line overlay actually going to be drawn this frame? In steady
    // candle mode — the common case, held for as long as the chart is on
    // screen — it isn't, and the arrays built below are per-frame garbage the
    // drawer immediately ignores: one object per visible candle on the else
    // branch, one per visible tick (plus `closeRefs`) on the density-blend
    // branch, every frame at 60fps. The predicate and the drawer's own
    // presence test live together in draw/lineOverlay.ts, which documents
    // (and lineOverlay.test.ts enforces) the invariant that this can only
    // ever skip frames the drawer was going to ignore anyway.
    //
    // `lineSmoothValue` stays unconditional in both branches: it's a scalar,
    // and computing it here rather than under the gate keeps this change to
    // the allocation and leaves the value's derivation byte-for-byte as it was.
    const wantLineVisible = shouldBuildLineOverlay(lineModeProg, chartReveal);
    if (
      effectiveLineData &&
      effectiveLineData.length > 0 &&
      (lineDensityProg > 0.01 || lineModeProg > 0.05)
    ) {
      if (!wantLineVisible) {
        lineVisible = EMPTY_LINE_POINTS;
      } else {
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
      lineVisible = wantLineVisible
        ? drawCandles.map((c) => ({
            time: c.time + displayCandleWidth / 2,
            value: c.close,
          }))
        : EMPTY_LINE_POINTS;
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
    // Pooled instead of `{ ...rawLive, close: s.closeLineSmooth }` — that
    // spread allocated a candle every frame in candle mode. Safe: the only
    // consumer is `drawClosePrice`, reached synchronously from
    // `drawCandleFrame` below, which reads the fields and never retains the
    // object (see EngineState.closePriceScratch).
    let closePriceCandle: CandlePoint | undefined = rawLive;
    if (s.closeLineSmoothInited && rawLive) {
      const cp = s.closePriceScratch;
      cp.time = rawLive.time;
      cp.open = rawLive.open;
      cp.high = rawLive.high;
      cp.low = rawLive.low;
      cp.close = s.closeLineSmooth;
      closePriceCandle = cp;
    }
    // Pooled ref (EngineState.candleCacheRef) refilled in place, rather than
    // a fresh literal every candle frame.
    const candleCacheRef = s.candleCacheRef;
    candleCacheRef.slot = s.candleCache;
    candleCacheRef.dataSource = dataSourceOf(
      useStash,
      s.pausedCandles !== null
    );
    candleCacheRef.candlesRev = cfg.candlesRev;
    drawCandleFrame(ctx, layout, cfg.palette, {
      candles: drawCandles,
      displayCandleWidth,
      oldCandles: drawOldCandles,
      oldWidth: cwt.oldWidth,
      morphT,
      liveCandle: drawLive,
      closePriceCandle,
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
      gridLayer: s.gridLayer,
      candleCache: candleCacheRef,
      lineArgs: s.lineDrawArgs,
      candleArgs: s.candleDrawArgs,
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

    // --- Live value display ---
    // `out.valueText` used to be written only by the single-series line
    // pipeline, and `null` means "leave unchanged" to the caller — so a
    // chart switched from line to candle mode froze its readout on the last
    // line-mode value forever, and a chart mounted in candle mode showed a
    // blank one. Publish candle mode's own live value: `lineSmoothValue` is
    // the same number the badge above prints, so the two can never disagree.
    if (cfg.showValue) {
      const displayVal = cfg.valueMomentumColor
        ? Math.abs(lineSmoothValue)
        : lineSmoothValue;
      out.valueText = cfg.formatValue(displayVal);
      if (cfg.valueMomentumColor) {
        // Candle mode's direction signal is the live candle's own
        // bull/bear — the exact thing the chart is already colouring the
        // candle by — rather than line mode's `detectMomentum` scan, which
        // would read an overlay array that is deliberately empty on most
        // candle frames (see `wantLineVisible` above). '' = default colour.
        const lc = drawLive;
        out.valueColor = !lc
          ? ''
          : lc.close > lc.open
            ? '#22c55e'
            : lc.close < lc.open
              ? '#ef4444'
              : '';
      }
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

    // Clean stale entries from displayValues (series that were removed).
    // Guarded on a size check so the steady state (series count unchanged
    // frame-to-frame, the overwhelming common case) allocates and iterates
    // nothing: every current series gets `s.displayValues.set(series.id, dv)`
    // below (when `!useMultiStash`), so by the end of any frame that ran
    // this block, displayValues.size === effectiveMultiSeries.length for
    // *that* frame's series set. A size mismatch at the top of the next
    // frame therefore only happens when the set actually shrank (removals) —
    // growth alone (an id added, none removed) leaves size <= length and is
    // correctly skipped, since there's nothing stale to clean. Note this is
    // a cheap proxy, not exact identity: a same-size id swap (series A
    // replaced by series B in one commit, count unchanged) slips through
    // undetected until a future size change catches it — rare in practice
    // (call sites keep ids stable across renders) and harmless when it does
    // happen (the stale entry just sits unused in the map).
    if (!useMultiStash && s.displayValues.size > effectiveMultiSeries.length) {
      const currentIds = new Set<string>();
      for (const series of effectiveMultiSeries) currentIds.add(series.id);
      // Every per-series map that is keyed by the current series set is
      // registered on `perSeriesMaps` in engine/state.ts, next to the field
      // declarations — including which maps are deliberately excluded and
      // why. Adding one here is a one-line change there, not another
      // hand-written delete loop at this call site.
      pruneByIds(currentIds, perSeriesMaps(s));
    }

    // Use first series data for window transition seeding
    const firstSeries = effectiveMultiSeries[0]!;
    const transition = s.windowTransition;
    if (hasData) s.frozenNow = Date.now() / 1000 - s.timeDebt;
    const now = useMultiStash ? s.frozenNow : Date.now() / 1000 - s.timeDebt;

    // Per-series smooth values (freeze when using stash). Reused across
    // frames (cleared, not reallocated) — see EngineState.smoothValuesScratch.
    const smoothValues = s.smoothValuesScratch;
    smoothValues.clear();
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

    // Per-series visibility alpha (lerp toward 0 for hidden, 1 for visible).
    // Deliberately no `new Set(hiddenIds)` here: N is a handful of hidden
    // series ids at most, and building + hashing into a Set every frame
    // costs strictly more than the linear scan it would replace — don't
    // "optimize" this back to a Set.
    const hiddenIds = cfg.hiddenSeriesIds;
    const seriesAlphas = s.seriesAlpha;
    for (const series of effectiveMultiSeries) {
      const target = hiddenIds && hiddenIds.indexOf(series.id) >= 0 ? 0 : 1;
      // Seed a brand-new id at its *target*, not at 1: a series added while
      // already in `hiddenSeriesIds` would otherwise start fully opaque and
      // fade out, flashing in for ~a dozen frames — and, worse, counting
      // toward the Y-range scan below (which excludes alpha <= 0.01) and
      // visibly widening the axis while it faded. An id already in the map
      // keeps its in-flight alpha, so toggling still animates.
      let alpha = seriesAlphas.get(series.id) ?? target;
      alpha = noMotion
        ? target
        : lerp(alpha, target, SERIES_TOGGLE_SPEED, pausedDt);
      if (alpha < 0.01) alpha = 0;
      if (alpha > 0.99) alpha = 1;
      seriesAlphas.set(series.id, alpha);
    }

    // Window transition — seed with all series data for accurate range
    const firstData =
      s.pausedMultiData?.get(firstSeries.id)?.data ??
      multiSeriesData(firstSeries, multiData);
    const windowResult = updateWindowTransition(
      cfg,
      s,
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
      // Reused across iterations (see EngineState.multiUnionVisibleScratch)
      // — each series is filtered, read synchronously by computeRange right
      // below, then moved past; nothing needs its own copy.
      const targetVisible = s.multiUnionVisibleScratch;
      for (const series of effectiveMultiSeries) {
        const sData =
          s.pausedMultiData?.get(series.id)?.data ??
          multiSeriesData(series, multiData);
        const sv = smoothValues.get(series.id) ?? series.value;
        filterVisiblePointsInto(
          sData,
          targetLeftEdge,
          targetRightEdge,
          targetVisible
        );
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
    //
    // Both the per-series `visible` arrays and the `MultiSeriesEntry`
    // objects that wrap them are pooled on EngineState, keyed by series id
    // (multiVisibleScratch / multiSeriesEntryScratch — see their doc
    // comments), rather than allocated fresh every frame. Confirmed safe:
    // drawMultiFrame (draw/index.ts) only reads each entry synchronously
    // while building its own output; it never retains the entry or its
    // `.visible` array past the call. `seriesEntries` itself reuses
    // `seriesEntriesScratch` the same way `visibleScratch` is reused below.
    const seriesEntries: MultiSeriesEntry[] = s.seriesEntriesScratch;
    seriesEntries.length = 0;
    let globalMin = Infinity;
    let globalMax = -Infinity;
    for (const series of effectiveMultiSeries) {
      const snap = s.pausedMultiData?.get(series.id);
      const seriesData = snap?.data ?? multiSeriesData(series, multiData);
      let visible = s.multiVisibleScratch.get(series.id);
      if (visible === undefined) {
        visible = [];
        s.multiVisibleScratch.set(series.id, visible);
      }
      filterVisiblePointsInto(seriesData, leftEdge, filterRight, visible);
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
        // 0 when the caller's config predates multiRevs (or the series is
        // brand new this frame) — that just falls back to the previous
        // value-heuristic-only cache key rather than misbehaving.
        const seriesRev = cfg.multiRevs?.[series.id] ?? 0;
        let entry = s.multiSeriesEntryScratch.get(series.id);
        if (entry === undefined) {
          entry = {
            id: series.id,
            visible,
            smoothValue: sv,
            palette: series.palette,
            label: series.label,
            alpha,
            dataRev: seriesRev,
          };
          s.multiSeriesEntryScratch.set(series.id, entry);
        } else {
          entry.visible = visible;
          entry.smoothValue = sv;
          entry.palette = series.palette;
          entry.label = series.label;
          entry.alpha = alpha;
          entry.dataRev = seriesRev;
        }
        seriesEntries.push(entry);
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
      publishBlankValue(out, cfg);
      return out;
    }

    // Smooth global range
    const computedRange = {
      min: isFinite(globalMin) ? globalMin : 0,
      max: isFinite(globalMax) ? globalMax : 1,
    };
    const adaptiveSpeed = cfg.lerpSpeed + ADAPTIVE_SPEED_BOOST * 0.5;
    const rangeResult = updateRange(
      s,
      computedRange,
      isWindowTransitioning,
      windowTransProgress,
      adaptiveSpeed,
      chartH,
      pausedDt
    );
    s.rangeInited = rangeResult.rangeInited;
    s.targetMin = rangeResult.targetMin;
    s.targetMax = rangeResult.targetMax;
    s.displayMin = rangeResult.displayMin;
    s.displayMax = rangeResult.displayMax;

    const layout: ChartLayout = makeLayout(
      w,
      h,
      pad,
      chartW,
      chartH,
      leftEdge,
      rightEdge,
      rangeResult
    );

    // Cross-frame grid picture cache — see engine/gridLayer.ts. Bypassed
    // while the reveal morph is animating (ctx.drawPicture ignores
    // globalAlpha; see the candle-mode branch above for the full reason).
    // pausedDt (not dt) — the grid layer owns `gridState`'s label crossfades,
    // and the candle branch documents why they must freeze with pause; this
    // call site and the single-series one below were the two that didn't.
    if (cfg.showGrid && chartReveal >= 1) {
      updateGridLayer(
        s.gridLayer,
        s.gridState,
        layout,
        cfg.palette,
        cfg.formatValue,
        pausedDt,
        s.gridLayerCache,
        fonts
      );
    }

    // Hover — interpolate value at hover time for each series
    const hoverPx = hoverPixelX;
    let drawHoverX: number | null = null;
    let drawHoverTime: number | null = null;
    let isActiveHover = false;
    // Shared read-only empty until a hover actually happens — see
    // EMPTY_HOVER_ENTRIES. The array below genuinely can't be pooled: it is
    // handed to `s.lastHoverEntries` and read back on the scrub fade-out
    // frames, so a single reused buffer would be cleared out from under it.
    let hoverEntries: { color: string; label: string; value: number }[] =
      EMPTY_HOVER_ENTRIES;

    if (hoverPx !== null && hoverPx >= pad.left && hoverPx <= w - pad.right) {
      const maxHoverX = layout.toX(now);
      const clampedX = Math.min(hoverPx, maxHoverX);
      const t =
        leftEdge + ((clampedX - pad.left) / chartW) * (rightEdge - leftEdge);
      drawHoverX = clampedX;
      drawHoverTime = t;
      isActiveHover = true;
      hoverEntries = [];

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
      lineCaches: s.lineCaches,
      multiDataSource: dataSourceOf(useMultiStash, s.pausedMultiData !== null),
      gridLayer: s.gridLayer,
      lineArgs: s.lineDrawArgs,
      lineCacheRef: s.lineCacheRef,
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

    // --- Live value display ---
    // Multi-series has no single "the" value to show, but leaving
    // `out.valueText` as `null` means "leave unchanged" to the caller — so a
    // chart switched from single-series to multi kept displaying whatever
    // the line pipeline last wrote, forever. Publish an explicit blank.
    if (cfg.showValue) {
      out.valueText = '';
      out.valueColor = '';
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
      s,
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
    // Reused scratch array (see EngineState.visibleScratch) instead of a
    // fresh allocation every frame. Safe: nothing in this pipeline stashes
    // `visible` itself past this frame (contrast candle mode's
    // `lastCandles`, which does and therefore copies at the stash point —
    // see the comment there); drawFrame/drawLine only read it synchronously
    // while building this frame's picture.
    const visible = s.visibleScratch;
    filterVisiblePointsInto(effectivePoints, leftEdge, filterRight, visible);

    if (visible.length < 2) {
      // Data exists (`hasData` is true, so `chartReveal` is heading to 1 and
      // the loading/empty early return at the top of the function is not
      // reached) but none of it lands inside the current window — a stalled
      // feed, or coming back from background, leaves every point older than
      // `leftEdge`. Returning here without drawing anything left the recorded
      // picture completely empty: no grid, no empty state, a fully
      // transparent chart. Draw the loading/empty fallback + edge fade, which
      // is exactly what the multi-series pipeline already does for the
      // identical `seriesEntries.length === 0` case above.
      if (loadingAlpha > 0.01) {
        drawLoading(ctx, w, h, pad, cfg.palette, now_ms, loadingAlpha);
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
      publishBlankValue(out, cfg);
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
      s,
      computedRange,
      isWindowTransitioning,
      windowTransProgress,
      adaptiveSpeed,
      chartH,
      pausedDt
    );
    s.rangeInited = rangeResult.rangeInited;
    s.targetMin = rangeResult.targetMin;
    s.targetMax = rangeResult.targetMax;
    s.displayMin = rangeResult.displayMin;
    s.displayMax = rangeResult.displayMax;
    const { valRange } = rangeResult;

    const layout: ChartLayout = makeLayout(
      w,
      h,
      pad,
      chartW,
      chartH,
      leftEdge,
      rightEdge,
      rangeResult
    );

    // Cross-frame grid picture cache — see engine/gridLayer.ts. Bypassed
    // while the reveal morph is animating (ctx.drawPicture ignores
    // globalAlpha; see the candle-mode branch above for the full reason).
    // pausedDt (not dt) — this pipeline already hands `drawFrame` pausedDt,
    // and `drawFrame`'s own inline `drawGrid` (the reveal < 1 path) drives
    // the same `gridState` label fades from it, so raw dt here meant the
    // fades froze or didn't depending purely on which path drew the grid.
    if (cfg.showGrid && chartReveal >= 1) {
      updateGridLayer(
        s.gridLayer,
        s.gridState,
        layout,
        cfg.palette,
        cfg.formatValue,
        pausedDt,
        s.gridLayerCache,
        fonts
      );
    }

    // Momentum
    const momentum: Momentum = cfg.momentumOverride ?? detectMomentum(visible);

    // Hover + scrub
    const hoverResult = updateHoverState(
      hoverPixelX,
      layout,
      now,
      visible,
      s.scrubAmount,
      s.lastHover,
      noMotion
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

    // --- Declarative scroll layer: the line's prefix stroke ---------------
    //
    // On frames where the prefix provably hasn't changed (a `lineCacheHits`
    // hit) and the whole line pipeline is at full opacity and untransformed
    // (`canCompositeLineScroll`), the prefix is composited from an SkPicture
    // under a `<Group transform>` and `drawLine` strokes only the tail. Any
    // other frame draws the line exactly as before, whole, and publishes an
    // empty scroll layer — the same both-branches shape the grid picture
    // uses above, and for the same reason: `ctx.drawPicture` ignores
    // `globalAlpha`, so a layer that can't be composited at alpha 1 must not
    // be composited at all.
    //
    // Deliberately runs after `updateHoverState` (it reads this frame's
    // settled `s.scrubAmount`) and before `drawFrame` (which reads
    // `splitPrefixStroke`). `s.shakeState.amplitude` is read pre-decay,
    // which is the value `drawFrame`'s own translate will use this frame.
    const dataSource = dataSourceOf(useStash, s.pausedData !== null);
    const canComposite = canCompositeLineScroll(
      chartReveal,
      s.scrubAmount,
      cfg.degenOptions ? s.shakeState.amplitude : 0
    );
    // Pooled ref (EngineState.lineCacheRef), refilled in place — the same
    // object is handed to `drawFrame` below as `lineCache`, so the predicate
    // here and the cache `drawLine` consults are provably the same inputs,
    // and neither costs an allocation.
    const lineCacheRef = s.lineCacheRef;
    lineCacheRef.slot = s.lineCache;
    lineCacheRef.dataRev = cfg.dataRev;
    lineCacheRef.dataSource = dataSource;
    lineCacheRef.splitPrefixStroke = false;
    let splitPrefixStroke = false;
    if (canComposite && lineCacheHits(lineCacheRef, layout, visible)) {
      updateLineScrollLayer(
        s.lineScroll,
        s.lineCache,
        layout,
        cfg.palette,
        s.lineScrollCache,
        fonts
      );
      // `canComposite` is already true inside this branch, so the alpha
      // argument is 1; `scrollLayerUsable` keeps its alpha-1 contract for a
      // future consumer that genuinely is alpha-driven.
      splitPrefixStroke = scrollLayerUsable(s.lineScroll, 1);
    }
    lineCacheRef.splitPrefixStroke = splitPrefixStroke;
    if (splitPrefixStroke) {
      out.scrollPicture = s.lineScroll.picture;
      // Same dx the cached prefix path is offset by — the picture IS that
      // path, rendered (see draw/lineCache.ts's `lineScrollDx`).
      out.scrollDx = lineScrollDx(s.lineCache, layout);
    }

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
      // pausedDt (not dt) — this pipeline is the only one that reaches
      // drawOrderbook (see draw/index.ts drawFrame), whose label spawn/
      // movement is otherwise driven purely by raw dt + Math.random() with
      // no pause gate of its own. Using pausedDt here freezes it at full
      // pause, matching the candle pipeline's existing precedent (step.ts,
      // drawCandleFrame call) and making orderbook charts eligible for
      // engine quiescence (see engine/quiescence.ts). The other opts.dt
      // consumers in drawFrame (grid/time-axis fade, shake decay, arrows,
      // particles) are unaffected by this: they're either already
      // pause-gated to zero effect or gated off entirely via
      // cfg.degenOptions, so freezing dt here doesn't change their
      // behavior at full pause.
      dt: pausedDt,
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
      lineCache: lineCacheRef,
      gridLayer: s.gridLayer,
      lineArgs: s.lineDrawArgs,
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
