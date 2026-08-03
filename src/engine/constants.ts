// --- Engine constants (shared across pipelines) ---
export const MAX_DELTA_MS = 50;
export const SCRUB_LERP_SPEED = 0.12;
export const BADGE_WIDTH_LERP = 0.15;
export const BADGE_Y_LERP = 0.35;
export const BADGE_Y_LERP_TRANSITIONING = 0.5;
export const MOMENTUM_COLOR_LERP = 0.12;
export const WINDOW_TRANSITION_MS = 750;
export const WINDOW_BUFFER = 0.05;
export const WINDOW_BUFFER_NO_BADGE = 0.015;
export const VALUE_SNAP_THRESHOLD = 0.001;
export const ADAPTIVE_SPEED_BOOST = 0.2;
export const MOMENTUM_GREEN: [number, number, number] = [34, 197, 94];
export const MOMENTUM_RED: [number, number, number] = [239, 68, 68];
export const CHART_REVEAL_SPEED = 0.14; // data → loading/empty (reverse)
export const CHART_REVEAL_SPEED_FWD = 0.09; // loading/empty → data (forward, slower for choreography)
export const PAUSE_PROGRESS_SPEED = 0.12;
export const PAUSE_CATCHUP_SPEED = 0.08;
export const PAUSE_CATCHUP_SPEED_FAST = 0.22;
export const LOADING_ALPHA_SPEED = 0.14;
export const SERIES_TOGGLE_SPEED = 0.1;

// --- Quiescence (skip picture re-recording when provably static) ---
// 90 consecutively-settled *vsyncs* — ~1.5s on a 60Hz display, ~0.75s on a
// 120Hz one. It counts vsyncs, not recorded frames, because
// `s.quiescentFrames++` runs BEFORE the frame-pacing gate below. That is
// fine: the threshold only needs to be long enough that every exponential
// lerp in the engine (smoothValue, range, badge, grid/time-axis label fades,
// window transitions) has fully converged, so a shorter wall-clock delay on
// high-refresh hardware is still comfortably past convergence. Do not
// re-describe this as "frames at 60fps" — the distinction matters now that
// the scroll transform runs on the vsyncs pacing skips.
export const QUIESCENT_FRAME_THRESHOLD = 90;

// ── Frame-pacing / extrapolation relationship (DO NOT TUNE ONE ALONE) ──────
//
// MIN_FRAME_INTERVAL_MS and MAX_SCROLL_EXTRAPOLATION_MS are not independent.
// Two inequalities must hold, and `constants.test.ts` asserts both:
//
//   1. MIN_FRAME_INTERVAL_MS < MAX_SCROLL_EXTRAPOLATION_MS
//      A paced-out vsync asks `extrapolateScrollDx` for a dx at a gap of up
//      to one pacing interval past the last recorded frame. If the pacing
//      interval could exceed the extrapolation window, that request returns
//      null and the transform freezes on exactly the frames the whole
//      high-refresh scroll feature exists to smooth.
//
//   2. MAX_SCROLL_EXTRAPOLATION_MS < MIN_FRAME_INTERVAL_MS * 2
//      `observeScrollRate` refuses to derive a rate across a gap longer than
//      `MAX_SCROLL_EXTRAPOLATION_MS * 2`, so that a stall or a quiescence
//      resume can't bake in a meaningless rate. For an ordinary paced
//      interval to stay comfortably inside that bound, the window must be
//      under twice the pacing interval.
//
// Today: 15 < 20 < 30. Five milliseconds of slack. Raising
// MIN_FRAME_INTERVAL_MS to 22 (a plausible "record at 45fps" tuning) breaks
// (1) and silently reverts the scroll layer to juddering — visible only on
// 120Hz hardware, which neither jest nor the simulator has.

// --- Frame pacing (cap picture re-recording on high-refresh displays) ---
// Below the nominal 60fps interval (1000/60 ≈ 16.67ms) on purpose: at
// exactly 16.67, vsync jitter alone would intermittently trip the gate on
// a real 60Hz display, silently skipping legitimate frames and halving its
// effective frame rate. This margin lets every native 60Hz vsync through
// while still roughly halving work on a 120Hz display.
export const MIN_FRAME_INTERVAL_MS = 15;

// --- Scroll-transform extrapolation window ---
// On a vsync that frame pacing skips, the scroll layer's translate is
// extrapolated from the last two recorded frames rather than recomputed (see
// engine/scrollExtrapolate.ts, which owns the full rationale). Any gap longer
// than this leaves the transform untouched until the next recorded frame
// supplies an exact value. 20ms is just over one 60Hz interval, so it covers
// the intended case (a 120Hz vsync landing ~8ms after a record) with margin
// for jitter, and nothing else — see the relationship block above.
export const MAX_SCROLL_EXTRAPOLATION_MS = 20;

// --- Candle-specific constants ---
export const CANDLE_LERP_SPEED = 0.25;
// Relative snap threshold for the live candle's OHLC lerp (see step.ts).
// Without an exact snap, high/low never becomes bit-exact with its target;
// since computeCandleRange scans the live candle too, that epsilon-level
// drift propagates into displayMax/displayMin whenever the live candle
// holds the visible extreme, which mismatches the candle cache's
// kMinVal/kMaxVal and forces a full geometry rebuild every single frame —
// the main limiter on the cache's hit rate. Sub-pixel (matches
// LINE_SNAP_THRESHOLD), so the snap itself is invisible.
export const CANDLE_SNAP_THRESHOLD = 0.001;
export const CANDLE_WIDTH_TRANS_MS = 300;
export const LINE_MORPH_MS = 500;
export const CLOSE_LINE_LERP_SPEED = 0.25; // matches candle body speed
export const LINE_DENSITY_MS = 350;
export const LINE_LERP_BASE = 0.08;
export const LINE_ADAPTIVE_BOOST = 0.2;
export const LINE_SNAP_THRESHOLD = 0.001;
export const RANGE_LERP_SPEED = 0.15;
export const RANGE_ADAPTIVE_BOOST = 0.2;
export const CANDLE_BUFFER_NO_BADGE = 0.015;
