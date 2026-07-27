import type { LivelinePoint } from '../types';

/**
 * A left edge is inclusive down to `leftEdge - LEFT_EDGE_EPSILON` rather
 * than exactly `leftEdge` — the window's left edge is a derived float
 * (`rightEdge - windowSecs`), so a point whose timestamp lands a hair
 * before it due to float rounding would otherwise be dropped for one frame
 * and pop back in the next, a visible flicker at the chart's left edge.
 */
const LEFT_EDGE_EPSILON = 2;

/**
 * Filters points to the visible time window `[leftEdge - epsilon,
 * rightEdge]`. Shared by the window-transition target-range scan
 * (engine/helpers.ts), the multi-series union-range scan and per-series
 * visible-array build, and the single-series visible-array build (all in
 * engine/step.ts) — four sites that previously copy-pasted this loop with
 * the same unexplained `- 2` epsilon, which this centralizes as a named,
 * commented constant.
 *
 * Deliberately monomorphic (no predicate callback) — this runs over
 * hundreds of points per series, per frame, on the UI thread, and an
 * indirect call per point would add overhead a hot loop like this can't
 * afford. Kept as a single call site doing its own allocation (rather than
 * e.g. a filter-into-caller's-array variant) so a future change to pool
 * this array on `EngineState` only has one line to touch.
 *
 * NOT used for the candle-width visibility checks (`c.time + candleWidthSecs
 * >= leftEdge`) — those test a different, width-adjusted left bound and are
 * intentionally left as their own thing.
 */
export function filterVisiblePoints(
  points: LivelinePoint[],
  leftEdge: number,
  rightEdge: number
): LivelinePoint[] {
  'worklet';
  const out: LivelinePoint[] = [];
  const minTime = leftEdge - LEFT_EDGE_EPSILON;
  for (const p of points) {
    if (p.time >= minTime && p.time <= rightEdge) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Pooled variant of `filterVisiblePoints` — fills a caller-provided array
 * instead of allocating a new one, for the per-frame UI-thread call sites
 * (`engine/step.ts`) that can hold the result array on `EngineState` across
 * frames (see `visibleScratch`/`multiVisibleScratch` there). Truncates via
 * `out.length = 0` then pushes, so the array's backing storage is retained
 * and reused rather than freed and reallocated every frame.
 *
 * `engine/helpers.ts`'s one-shot target-range scan still uses the
 * allocating `filterVisiblePoints` above — its result is never retained
 * past the scan, so pooling it would add bookkeeping for no benefit.
 */
export function filterVisiblePointsInto(
  points: LivelinePoint[],
  leftEdge: number,
  rightEdge: number,
  out: LivelinePoint[]
): void {
  'worklet';
  out.length = 0;
  const minTime = leftEdge - LEFT_EDGE_EPSILON;
  for (const p of points) {
    if (p.time >= minTime && p.time <= rightEdge) {
      out.push(p);
    }
  }
}
