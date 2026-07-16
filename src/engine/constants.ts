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

// --- Candle-specific constants ---
export const CANDLE_LERP_SPEED = 0.25;
export const CANDLE_WIDTH_TRANS_MS = 300;
export const LINE_MORPH_MS = 500;
export const CLOSE_LINE_LERP_SPEED = 0.25; // matches candle body speed
export const LINE_DENSITY_MS = 350;
export const LINE_LERP_BASE = 0.08;
export const LINE_ADAPTIVE_BOOST = 0.2;
export const LINE_SNAP_THRESHOLD = 0.001;
export const RANGE_LERP_SPEED = 0.15;
export const RANGE_ADAPTIVE_BOOST = 0.2;
export const CANDLE_BUFFER = 0.05;
export const CANDLE_BUFFER_NO_BADGE = 0.015;
