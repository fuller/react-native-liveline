import type { EngineConfigStep } from './types';
import type { EngineState } from './state';

/**
 * True only when the chart is provably static *this frame* — every
 * continuously-animating engine feature is either settled or disabled.
 * Used by the frame loop (see `useLivelineEngine.ts`) to decide whether a
 * picture re-record can be skipped. Deliberately cheap: field reads and
 * comparisons only, no allocation, no iteration.
 *
 * This does NOT account for whether the underlying config/canvas actually
 * changed since the last frame — that's the caller's job (the "break
 * conditions": cfg object identity + canvas size, tracked via
 * `s.lastCfgObj`/`s.lastRecordedW`/`s.lastRecordedH`). This function only
 * answers "if nothing broke, is every animatable feature currently at
 * rest?".
 *
 * Audit of every continuously-animating source in `engine/step.ts` and the
 * `draw/*` modules it calls, done while writing this (grep for `now_ms`,
 * `dt`, `lerp(`, `Math.random` across `src/draw` + `src/engine`):
 *
 *  - pause settle (`pauseProgress`), hover/scrub, loading↔empty crossfade,
 *    chart reveal morph — covered by the conditions below.
 *  - window-size transition (`WINDOW_TRANSITION_MS` = 750ms) — only
 *    re-triggered by a `cfg.windowSecs` change, which is itself a commit
 *    and already resets the counter via the config-identity break
 *    condition; 750ms < the 90-frame (~1.5s) quiescence threshold, so no
 *    separate check is needed here.
 *  - grid/time-axis label fade-in/out (`draw/grid.ts`, `draw/timeAxis.ts`)
 *    — lerp toward a stable target once the window/range stop moving;
 *    converges in well under 1.5s (fade speeds 0.08-0.18/frame), so it's
 *    always settled by the time `quiescentFrames` crosses the threshold.
 *  - badge lerps (`engine/badge.ts`) — driven by `pausedDt`, which is 0
 *    once `pauseProgress === 1`; badge alpha is also `1 - pauseProgress`
 *    (== 0), so it isn't even drawn.
 *  - momentum arrows (`draw/dot.ts` `drawArrows`, gated in `draw/index.ts`)
 *    — `arrowAlpha = arrowReveal * (1 - pause)` is forced to 0 at full
 *    pause; the draw call (and its arrow-state mutation) is skipped
 *    entirely, so `cfg.showMomentum` doesn't need its own condition.
 *  - pulse ring (`draw/dot.ts`) — excluded via `showPulse` below.
 *  - degen particles + chart shake (`draw/particles.ts`, shake in
 *    `draw/index.ts`) — both keyed off `cfg.degenOptions`; excluded below.
 *  - orderbook depth-flow labels (`draw/orderbook.ts`) — NOT mentioned in
 *    the brief; found during this audit. `drawOrderbook` spawns and moves
 *    labels every frame purely off raw (unpaused) `dt` and `Math.random()`,
 *    independent of whether the underlying data or pause state changed —
 *    excluded via `orderbookData` below.
 *  - candle-width morph, per-series alpha lerps (multi-series) — entire
 *    modes excluded below; candle and multi-series never go quiescent.
 */
export function isQuiescentCandidate(
  cfg: EngineConfigStep,
  s: EngineState,
  hoverPixelX: number | null
): boolean {
  'worklet';
  const isMultiSeries =
    !!cfg.isMultiSeries && !!cfg.multiSeries && cfg.multiSeries.length > 0;

  return (
    cfg.paused === true &&
    s.pauseProgress === 1 &&
    hoverPixelX === null &&
    s.scrubAmount === 0 &&
    !cfg.loading &&
    s.loadingAlpha === 0 &&
    s.chartReveal === 1 &&
    !cfg.showPulse &&
    !cfg.degenOptions &&
    !cfg.orderbookData &&
    cfg.mode !== 'candle' &&
    !isMultiSeries
  );
}
