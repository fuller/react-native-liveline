import type { ChartLayout } from '../types';
import { niceTimeInterval } from '../math/intervals';
import type { Ctx2D } from './canvas2d';

/**
 * Pure label-selection logic for the cached time-axis scroll layer.
 *
 * `draw/timeAxis.ts` re-derives all of this every frame at 60fps: the
 * interval, a `formatTime()` call per label (the default formatter allocates
 * a `Date` plus three `padStart` results *per label per frame*), a `Map` walk
 * with per-label alpha lerps, text measurement, a sort, and overlap
 * resolution. Under the scroll-layer architecture the axis is baked into a
 * cached `SkPicture` and composited at a horizontal offset, so all of this
 * runs only when the label set actually changes — roughly once per `interval`
 * seconds instead of 60 times per second.
 *
 * Two deliberate differences from `timeAxis.ts`:
 *
 * 1. **No per-label alpha.** Labels bake at alpha 1; the 50px edge fade
 *    (`timeAxis.ts:65-72`) becomes a gradient `destination-out` erase over the
 *    axis strip in the screen pass. Label visibility is therefore a pure
 *    function of position — which is what makes this module testable.
 * 2. **Positional overlap resolution.** The alpha tiebreak ("keep the
 *    higher-alpha one", `timeAxis.ts:184-198`) has no meaning without alpha.
 *    See `timeAxisStride` for the replacement and its determinism argument.
 *
 * Skia-free by construction: `Ctx2D` is imported as a **type only**, exactly
 * like `timeAxis.ts` does, so jest can drive this with a plain fake context.
 * Do not add a value import from `@shopify/react-native-skia` here — it would
 * pull the native binding into the test process and this module would become
 * as untestable as `draw/index.ts`.
 *
 * Nothing in this module allocates per call: every producer writes into a
 * caller-owned array that it grows once and then reuses, the same pooling
 * discipline `TimeAxisState` already documents.
 */

/** Minimum on-screen spacing between tick positions, in px. Below this the
 * interval is doubled. Matches `timeAxis.ts:81`. */
const MIN_TICK_SPACING_PX = 60;

/** Minimum clear gap between two rendered label boxes, in px. Matches the
 * `+ 8` slack in `timeAxis.ts:189`. */
const LABEL_GAP_PX = 8;

/** How far left of the plot area a label may sit and still be built. A label
 * whose centre is just off the left edge still has its right half visible, so
 * culling exactly at `chartLeft` would pop it. Matches `timeAxis.ts:161`. */
const LEFT_CULL_SLACK_PX = 20;

/** Hard cap on generated labels. During a wide→narrow window transition the
 * target interval can be tiny relative to the currently-displayed span, so the
 * generation loop is bounded rather than trusted. Matches `timeAxis.ts:102`. */
const MAX_LABELS = 30;

/** One built label, pooled across rebuilds. `key` is the label's timestamp in
 * centiseconds (`Math.round(t * 100)`) — the same integer key `timeAxis.ts`
 * uses, chosen so day-aligned times that land on fractional seconds still
 * compare exactly. */
export interface TimeAxisLabel {
  /** `Math.round(t * 100)` — timestamp in centiseconds. */
  key: number;
  /** Build-time screen X. Only valid for the layout it was built with; the
   * scroll layer re-derives the frame's X by translating the whole picture. */
  x: number;
  text: string;
  /** Measured width via `ctx.measureText`, which is cached upstream by
   * font slot + string in `canvas2d.ts`. */
  w: number;
}

/**
 * Picks the tick interval in seconds.
 *
 * Ported verbatim from `timeAxis.ts:79-83`. Two invariants worth preserving:
 *
 * - It is derived from the **target** window, never the interpolating display
 *   window. Deriving it from the display window makes the interval change
 *   mid-transition and flicker for one frame when `windowSecs` snaps to
 *   `targetWindowSecs` at the end of the transition.
 * - The doubling loop is bounded by `interval < targetWindowSecs`, so a
 *   degenerate `chartW` (0, or a first-frame layout) cannot spin forever.
 */
export function timeAxisInterval(
  targetWindowSecs: number,
  chartW: number
): number {
  'worklet';
  const targetPxPerSec = chartW / targetWindowSecs;
  let interval = niceTimeInterval(targetWindowSecs);
  while (
    interval * targetPxPerSec < MIN_TICK_SPACING_PX &&
    interval < targetWindowSecs
  ) {
    interval *= 2;
  }
  return interval;
}

/**
 * Generates the label timestamps for the current view, plus one interval of
 * buffer on each side so a label is already built before it scrolls in.
 *
 * Ported from `timeAxis.ts:89-106`. Writes ascending centisecond keys into
 * `out` and returns how many are valid; `out` is grown once and reused, never
 * reallocated, and entries past the returned count are stale.
 *
 * For intervals of a day or more the sequence is anchored to **local**
 * midnight rather than the UTC epoch, because a "1 Feb" tick drawn at 19:00
 * the previous day is simply wrong to a user. Note the anchor is applied only
 * to the first label and the rest step by a fixed `interval`; across a DST
 * boundary later labels therefore drift an hour off local midnight. That is
 * existing `timeAxis.ts` behaviour and is preserved deliberately — changing it
 * belongs in a separate change with its own visual verification.
 */
export function timeAxisLabelKeys(
  interval: number,
  leftEdge: number,
  rightEdge: number,
  out: number[]
): number {
  'worklet';
  const useLocalDays = interval >= 86400;
  let firstTime: number;
  if (useLocalDays) {
    const d = new Date((leftEdge - interval) * 1000);
    d.setHours(0, 0, 0, 0);
    firstTime = d.getTime() / 1000;
  } else {
    firstTime = Math.ceil((leftEdge - interval) / interval) * interval;
  }

  let count = 0;
  for (
    let t = firstTime;
    t <= rightEdge + interval && count < MAX_LABELS;
    t += interval
  ) {
    out[count] = Math.round(t * 100);
    count++;
  }
  return count;
}

/**
 * Formats and measures the subset of `keys` that is actually on screen.
 *
 * Writes into `pool` (grown once, entries reused across rebuilds — a given
 * slot backs a different label on every rebuild, which is safe because every
 * field is overwritten) and returns the valid count. Output stays ascending
 * because `timeAxisLabelKeys` emits ascending keys, so the sort
 * `timeAxis.ts:176` performs every frame is not needed here.
 *
 * `ctx` is used only for `measureText`, which `canvas2d.ts` caches by font
 * slot + string; the font slot is set here so that cache is keyed correctly.
 */
export function buildTimeAxisLabels(
  ctx: Ctx2D,
  keys: number[],
  keyCount: number,
  layout: ChartLayout,
  formatTime: (t: number) => string,
  pool: TimeAxisLabel[]
): number {
  'worklet';
  ctx.font = ctx.fonts.label;
  const chartLeft = layout.pad.left;
  const chartRight = layout.w - layout.pad.right;

  let count = 0;
  for (let i = 0; i < keyCount; i++) {
    const key = keys[i]!;
    const x = layout.toX(key / 100);
    if (x < chartLeft - LEFT_CULL_SLACK_PX || x > chartRight) continue;
    const text = formatTime(key / 100);
    const w = ctx.measureText(text).width;
    const entry = pool[count];
    if (!entry) {
      pool[count] = { key, x, text, w };
    } else {
      entry.key = key;
      entry.x = x;
      entry.text = text;
      entry.w = w;
    }
    count++;
  }
  return count;
}

/**
 * Chooses the decimation stride that resolves label overlap — the positional
 * replacement for the alpha tiebreak at `timeAxis.ts:184-198`.
 *
 * **Why not greedy left-to-right?** The obvious replacement ("walk sorted by
 * X, drop anything colliding with the last kept label") is deterministic for a
 * fixed input but *not* stable under scrolling: the greedy chain is anchored
 * on whichever label is currently leftmost, so the moment the leftmost label
 * scrolls out the whole chain shifts by one and every surviving label swaps
 * for its neighbour. On a continuously scrolling chart that is a visible
 * flicker once per interval, and it is exactly the failure the old alpha
 * tiebreak was papering over.
 *
 * **The rule instead:** keep a label iff its *absolute* interval index
 * `round(t / interval)` is a multiple of `stride`. The decision depends only
 * on the label's own timestamp and on `stride`, never on which labels happen
 * to be on screen, so a label's fate is identical on every frame it is
 * visible. Scrolling can never change a surviving label into a dropped one.
 *
 * `stride` itself is derived from view-scale quantities — the on-screen
 * spacing between consecutive ticks and the widest label in the set — not from
 * scan order. At a fixed zoom the spacing is constant, so `stride` is constant
 * and the kept set is fully scroll-invariant. The one residual way `stride`
 * can move without a zoom change is a wider label class scrolling in (`9:59`
 * → `10:00`). That flips the whole set at once, coherently, which is the
 * "hard swap" the design already accepts — not a two-label flicker.
 *
 * Spacing is taken as the **minimum** adjacent gap rather than the mean so an
 * irregular step (a DST-shortened day) tightens the stride rather than being
 * averaged away into an overlap.
 *
 * Clamped to `count` so at least one label always survives: keys are
 * consecutive integer indices, and any `count` consecutive integers contain a
 * multiple of any stride ≤ `count`.
 */
export function timeAxisStride(labels: TimeAxisLabel[], count: number): number {
  'worklet';
  if (count < 2) return 1;

  let minSpacing = Infinity;
  let maxW = 0;
  for (let i = 0; i < count; i++) {
    const w = labels[i]!.w;
    if (w > maxW) maxW = w;
    if (i > 0) {
      const gap = labels[i]!.x - labels[i - 1]!.x;
      if (gap < minSpacing) minSpacing = gap;
    }
  }

  // Degenerate geometry (zero or negative spacing) — nothing sensible to
  // decimate towards, so keep one label rather than loop.
  if (!(minSpacing > 0)) return count;

  const needed = maxW + LABEL_GAP_PX;
  let stride = Math.ceil(needed / minSpacing);
  if (stride < 1) stride = 1;
  if (stride > count) stride = count;
  return stride;
}

/** True when this label survives decimation at `stride`. Pure in the label's
 * own timestamp — see `timeAxisStride` for why that matters. */
export function timeAxisLabelKept(
  key: number,
  interval: number,
  stride: number
): boolean {
  'worklet';
  if (stride <= 1) return true;
  const index = Math.round(key / (100 * interval));
  // Keys before the epoch give a negative index; JS `%` keeps the sign, so
  // normalise before comparing or pre-1970 charts would drop everything.
  return ((index % stride) + stride) % stride === 0;
}

/**
 * Applies `timeAxisLabelKept` to a built label list.
 *
 * `stride` is passed in rather than derived here because the caller also needs
 * it for the invalidation key (see `TimeAxisLabelSetId`) and it must be the
 * same value in both places — deriving it twice invites them to diverge.
 *
 * `out` holds **references into `labels`**, never its own objects — the same
 * contract `TimeAxisState.drawnScratch` documents. Returns the kept count;
 * entries past it are stale.
 */
export function resolveTimeAxisOverlaps(
  labels: TimeAxisLabel[],
  count: number,
  interval: number,
  stride: number,
  out: TimeAxisLabel[]
): number {
  'worklet';
  let kept = 0;
  for (let i = 0; i < count; i++) {
    const label = labels[i]!;
    if (!timeAxisLabelKept(label.key, interval, stride)) continue;
    out[kept] = label;
    kept++;
  }
  return kept;
}

/**
 * Cheap identity for the drawn label set, used as part of the `axisScroll`
 * picture invalidation key.
 *
 * **Is `count + firstKey + lastKey` collision-free?** For sets produced by
 * `timeAxisLabelKeys` + `resolveTimeAxisOverlaps`, yes — and not merely
 * "cheap and good enough". The generator emits a strictly ascending arithmetic
 * sequence with step `interval`, and decimation keeps a fixed-stride subset of
 * it, so `(interval, stride, firstKey, count)` reconstructs the whole set
 * exactly; `lastKey` is redundant but is retained as a cheap guard against the
 * one non-arithmetic case, the local-midnight anchor across a DST boundary.
 * `interval` and `stride` are therefore carried in this identity rather than
 * assumed — with only `count/first/last` the set genuinely *would* be
 * ambiguous (same span, different stride).
 *
 * What it does **not** cover, by design:
 *
 * - **Label text.** Two different formatter outputs for the same timestamps
 *   compare equal here. The slot key covers this separately by holding
 *   `formatTime` by reference; a formatter closing over mutable state (a
 *   locale that changes in place) would slip through both. Callers that swap
 *   formatting must swap the function identity.
 * - **Positions.** `x` moves every frame; that is the scroll layer's `dx`
 *   translation, not a rebuild trigger, and is deliberately absent.
 */
export interface TimeAxisLabelSetId {
  count: number;
  firstKey: number;
  lastKey: number;
  interval: number;
  stride: number;
}

export function createTimeAxisLabelSetId(): TimeAxisLabelSetId {
  'worklet';
  return { count: 0, firstKey: 0, lastKey: 0, interval: 0, stride: 0 };
}

/** Writes the identity of `labels[0..count)` into `id` (call on a rebuild). */
export function writeTimeAxisLabelSetId(
  id: TimeAxisLabelSetId,
  labels: TimeAxisLabel[],
  count: number,
  interval: number,
  stride: number
): void {
  'worklet';
  id.count = count;
  id.firstKey = count > 0 ? labels[0]!.key : 0;
  id.lastKey = count > 0 ? labels[count - 1]!.key : 0;
  id.interval = interval;
  id.stride = stride;
}

/** True when `labels[0..count)` has the same identity as `id`. Allocation-free
 * so it is safe to call every frame. */
export function timeAxisLabelSetIdMatches(
  id: TimeAxisLabelSetId,
  labels: TimeAxisLabel[],
  count: number,
  interval: number,
  stride: number
): boolean {
  'worklet';
  return (
    id.count === count &&
    id.interval === interval &&
    id.stride === stride &&
    id.firstKey === (count > 0 ? labels[0]!.key : 0) &&
    id.lastKey === (count > 0 ? labels[count - 1]!.key : 0)
  );
}
