import type { LivelinePoint, ChartLayout } from '../types';
import {
  computeSplineTangents,
  emitSplineSegments,
  drawSplineTail,
} from '../math/spline';
import { ensured, type CachePath } from './pathCache';

export type { CachePath } from './pathCache';

/**
 * Cross-frame cache for the chart line's SkPath.
 *
 * Between data ticks, almost nothing about the line changes: the time-scroll
 * is a pure horizontal translate (`toX` is affine with a constant scale
 * outside window transitions), the Y-range lerp snaps exactly when settled
 * (see helpers.ts updateRange), and only the last data point and the live
 * tip move (both track the per-frame-lerped smooth value). Yet drawLine
 * rebuilt the full spline every frame — two JS Fritsch-Carlson passes (fill
 * + stroke) and ~2·N JSI cubicTo calls into the shim.
 *
 * This module caches a "prefix" path (the spline through all decimated
 * points except the last data point and the tip) and, on frames where the
 * inputs provably haven't changed, re-assembles the drawable paths with a
 * handful of native calls: addPath(prefix) + offset(dx, 0) + two tail
 * cubics. `dx` is always computed against the build-time reference (never
 * accumulated), so there is no drift.
 *
 * Kept free of Skia imports (paths are typed structurally via `CachePath`,
 * shared with the badge pill cache in engine/badge.ts — see draw/pathCache.ts)
 * so jest can exercise the full key/assembly logic with fake path recorders,
 * the same way math.test.ts fakes `SplinePath`.
 */

/** How drawLine receives a cache: the slot plus the data-identity inputs. */
export interface LineCacheRef {
  slot: LineCacheSlot;
  /** Revision counter bumped whenever the data buffer actually changed
   * (0 where no counter is available — the value-heuristic key fields
   * still catch appends/prunes/last-value changes). */
  dataRev: number;
  /** Which backing array the points came from: 0 = live buffer,
   * 1 = paused snapshot, 2 = reverse-morph stash. */
  dataSource: number;
  /**
   * Declarative scroll layer: when true, the caller is compositing the
   * prefix stroke itself (from a picture recorded by
   * engine/lineScrollLayer.ts) and `drawLine` must stroke the **tail only**,
   * so the prefix isn't drawn twice. The fill is unaffected — it is still
   * drawn whole, from the combined path.
   *
   * Advisory, not a command: `drawLine` honors it only on frames where the
   * path cache is actually in use (`cacheReady`), since the immediate-mode
   * fallback has no separable prefix. The caller therefore only sets it when
   * it has independently confirmed a `lineCacheHits` hit for this frame —
   * see engine/step.ts, which is also where the alpha gate lives.
   *
   * Absent (undefined) for the multi-series and candle pipelines, which draw
   * the combined path exactly as before.
   */
  splitPrefixStroke?: boolean;
}

export interface LineCacheSlot {
  /** Spline through decimated[0..N-2] in build-time screen coords. */
  prefix: CachePath | null;
  /** Assembled stroke path (valid after updateLinePaths returns true). */
  scratch: CachePath | null;
  /** Assembled fill path (valid only when wantFill was true). */
  fillScratch: CachePath | null;
  /** Tail-only stroke path in CURRENT screen coords: moveTo(cutX + dx, cutY)
   * then the same two tail cubics `scratch` ends with. Valid only after
   * `assembleLineTailStroke` (never written by `assembleLineTail`). */
  tailScratch: CachePath | null;

  // Prefix metadata
  tRef: number; // decimated[0].time at build
  xRefAtBuild: number; // toX(tRef) at build
  cutX: number; // build-time coords of decimated[N-2]
  cutY: number;
  endTangent: number; // tangent the prefix actually ended with (post-clamp)

  // Invalidation key — flat numbers only, compared field-by-field so a
  // per-frame check allocates nothing. Validity is `prefix !== null` (no
  // separate boolean — the two are always written together). `layout.w`
  // isn't keyed: it only reaches the drawn geometry through `chartW`
  // (already keyed) and pad.left (absorbed by `dx`, see below), so it can
  // never catch an invalidation those don't already catch.
  kDataRev: number;
  kDataSource: number;
  kLen: number; // visible.length
  kFirstT: number; // visible[0].time
  kLastT: number; // visible[len-1].time
  kLastV: number; // visible[len-1].value
  kMin: number; // layout.minVal (snaps exactly when settled)
  kMax: number;
  kWindow: number; // rightEdge - leftEdge (x scale)
  kH: number;
  kPadTop: number;
  kPadBottom: number;
  kChartW: number;
}

/** Below this many decimated points the legacy rebuild is cheap anyway. */
export const MIN_CACHE_POINTS = 8;

export function createLineCacheSlot(): LineCacheSlot {
  'worklet';
  return {
    prefix: null,
    scratch: null,
    fillScratch: null,
    tailScratch: null,
    tRef: 0,
    xRefAtBuild: 0,
    cutX: 0,
    cutY: 0,
    endTangent: 0,
    kDataRev: 0,
    kDataSource: 0,
    kLen: 0,
    kFirstT: 0,
    kLastT: 0,
    kLastV: 0,
    kMin: 0,
    kMax: 0,
    kWindow: 0,
    kH: 0,
    kPadTop: 0,
    kPadBottom: 0,
    kChartW: 0,
  };
}

/**
 * Pure, allocation-free key-comparison predicate: true when `slot`'s cached
 * prefix is still valid for this frame's data identity + layout. Compares
 * flat numbers field-by-field, same as the invalidation key documented on
 * `LineCacheSlot` above — no arrays, no path objects, safe to call every
 * frame before doing any expensive work.
 *
 * This is the ONE place the key comparison is written. `drawLine` calls it
 * directly to decide — BEFORE building the decimated/points arrays — whether
 * the expensive per-frame work is needed at all, and `updateLinePaths` below
 * calls the exact same function on its (already-built) inputs, so the two
 * checks can never drift apart.
 */
export function lineCacheHits(
  slot: LineCacheSlot,
  layout: ChartLayout,
  dataRev: number,
  dataSource: number,
  visLen: number,
  visFirstT: number,
  visLastT: number,
  visLastV: number
): boolean {
  'worklet';
  const window = layout.rightEdge - layout.leftEdge;
  return (
    slot.prefix !== null &&
    slot.kDataRev === dataRev &&
    slot.kDataSource === dataSource &&
    slot.kLen === visLen &&
    slot.kFirstT === visFirstT &&
    slot.kLastT === visLastT &&
    slot.kLastV === visLastV &&
    slot.kMin === layout.minVal &&
    slot.kMax === layout.maxVal &&
    slot.kWindow === window &&
    slot.kH === layout.h &&
    slot.kPadTop === layout.pad.top &&
    slot.kPadBottom === layout.pad.bottom &&
    slot.kChartW === layout.chartW
  );
}

/**
 * Horizontal scroll of the cached prefix since it was built, in screen px.
 *
 * The ONE place this subtraction is written, so the combined path, the
 * split-out tail and any caller that translates the prefix itself (the
 * declarative scroll layer) can never disagree about where the prefix is.
 * Always recomputed against the build-time reference — never accumulated —
 * so there is no drift; see the note on `assembleLineTail` below.
 *
 * Returns 0 for a slot with no prefix (tRef/xRefAtBuild are both still 0
 * only by coincidence there, so callers should gate on `slot.prefix`).
 *
 * Identical formula to `scrollLayer.ts`'s `scrollLayerDx` — a scroll-layer
 * slot wrapping the prefix picture takes its `tRef`/`xRefAtBuild` straight
 * from this slot, and the two then agree by construction.
 */
export function lineScrollDx(slot: LineCacheSlot, layout: ChartLayout): number {
  'worklet';
  return layout.toX(slot.tRef) - slot.xRefAtBuild;
}

/**
 * Assembles `slot.scratch` (and `slot.fillScratch` when `wantFill`) from an
 * already-valid `slot.prefix` plus this frame's two live tail points — the
 * last data point (re-Y'd to smoothValue) and the live tip. This is the
 * cheap part of the cache: a translate-by-`dx` of the cached prefix plus a
 * couple of tail cubics, no spline rebuild.
 *
 * `dx` is recomputed from `slot.tRef`/`slot.xRefAtBuild` rather than taken
 * as a parameter: right after a fresh prefix build those two come from the
 * very same `layout.toX` call this frame, so the subtraction is exactly 0
 * with no special-casing needed; on a reused prefix it recovers the
 * horizontal scroll since build (never accumulated, so no drift). Caller
 * guarantees `slot.prefix` is non-null (checked via `lineCacheHits` on a
 * hit, or just-built on a miss).
 *
 * `firstY` (the on-curve Y of the prefix's first point, needed only for the
 * fill polygon's left edge) is a parameter rather than read off the cached
 * path: it isn't part of the invalidation key, so — matching the pre-split
 * behavior exactly — it's still recomputed fresh by the caller every frame
 * rather than trusted from a prior build.
 */
export function assembleLineTail(
  slot: LineCacheSlot,
  makePath: () => CachePath,
  layout: ChartLayout,
  wantFill: boolean,
  lastX: number,
  lastY: number,
  tipX: number,
  tipY: number,
  firstY: number
): void {
  'worklet';
  const dx = lineScrollDx(slot, layout);

  // Assemble the stroke path: translated prefix + live tail.
  slot.scratch = ensured(slot.scratch, makePath);
  const scratch = slot.scratch;
  scratch.rewind();
  scratch.addPath(slot.prefix!);
  if (dx !== 0) scratch.offset(dx, 0);
  drawSplineTail(
    scratch,
    slot.cutX + dx,
    slot.cutY,
    slot.endTangent,
    lastX,
    lastY,
    tipX,
    tipY
  );

  // Assemble the fill path: baseline → up the left edge → the stroke path
  // (extend=true converts its leading moveTo into a connecting segment) →
  // down to the baseline → close. Matches renderCurve's construction.
  if (wantFill) {
    slot.fillScratch = ensured(slot.fillScratch, makePath);
    const fill = slot.fillScratch;
    const baseY = layout.h - layout.pad.bottom;
    const firstX = layout.toX(slot.tRef);
    fill.rewind();
    fill.moveTo(firstX, baseY);
    fill.lineTo(firstX, firstY);
    fill.addPath(scratch, undefined, true);
    fill.lineTo(tipX, baseY);
    fill.close();
  }
}

/**
 * ── Split stroke API (declarative scroll layer) ────────────────────────────
 *
 * The declarative render shell wants the line's stroke as two *separately
 * drawable* pieces: the prefix, recorded once into a picture and moved by a
 * `<Group transform>`, and the tail, drawn live every frame. This section
 * adds exactly that, additively — `assembleLineTail` above and its combined
 * `slot.scratch` / `slot.fillScratch` are untouched and still the only thing
 * `drawLine` uses.
 *
 * Shape of the API, and why:
 *
 * - **The prefix is exposed as `slot.prefix` itself** (via `linePrefixPath`
 *   for a documented, null-checked accessor) rather than as a fresh
 *   untranslated copy. No copy is needed: `assembleLineTail` translates the
 *   *scratch* — `scratch.addPath(slot.prefix)` then `scratch.offset(dx, 0)`
 *   — so the offset lands on the copy inside `scratch`, never on `prefix`.
 *   `slot.prefix` is written in exactly one place (the miss branch of
 *   `updateLinePaths`) and is only ever read afterwards, so it stays in
 *   build-time coordinates for its whole life. A second copy would cost an
 *   extra native path per slot and one more thing to keep in sync, and would
 *   buy nothing. The caller supplies the transform: `translateX` =
 *   `lineScrollDx(slot, layout)`.
 *
 * - **The tail gets its own slot-owned scratch** (`slot.tailScratch`) filled
 *   by `assembleLineTailStroke`, in current screen coordinates, because
 *   unlike the prefix it has no cached representation to reuse — it is
 *   rebuilt from this frame's two moving points regardless.
 *
 * - **The tail is re-emitted rather than sliced out of `slot.scratch`.**
 *   Building the combined path as prefix + `addPath(tailScratch, …, true)`
 *   would insert a zero-length connector verb and stop the combined path
 *   from being verb-for-verb what it is today; two extra `cubicTo`s per
 *   frame is the cheaper price. The tail starts at `slot.cutX + dx` with
 *   `slot.endTangent`, the same arguments `assembleLineTail` passes, so the
 *   join with the translated prefix is the identical C1-continuous one.
 *
 * - **The fill is NOT split**, deliberately. It is one closed
 *   semi-transparent polygon; abutting two halves leaves a hairline seam
 *   (antialiased coverage on a shared edge sums to ~0.75), overlapping them
 *   double-darkens a 1px column, and a non-AA clip split only tiles exactly
 *   when both sides round a fractional `dx` identically. Whoever consumes
 *   this API keeps drawing the whole fill live from `slot.fillScratch`.
 */

/**
 * The prefix stroke — the spline through decimated points `0..N-2` — in
 * BUILD-TIME screen coordinates. Null until a prefix has been built.
 *
 * Never mutated by translation (see the section comment above), so it is
 * safe to record into a long-lived picture: the picture stays valid until
 * the next `lineCacheHits` miss rebuilds the prefix, and the caller moves it
 * with `lineScrollDx(slot, layout)` on the x axis.
 */
export function linePrefixPath(slot: LineCacheSlot): CachePath | null {
  'worklet';
  return slot.prefix;
}

/**
 * Assembles `slot.tailScratch`: the tail stroke alone, in CURRENT screen
 * coordinates — `moveTo(slot.cutX + dx, slot.cutY)` followed by the same two
 * cubics `assembleLineTail` appends to the combined path. Drawing the
 * translated prefix and this back to back is geometrically identical to
 * drawing `slot.scratch`; only the leading `moveTo` differs, and it lands
 * exactly on the translated prefix's last on-curve point.
 *
 * Independent of `assembleLineTail` — callers that want both call both.
 * Caller guarantees `slot.prefix` is non-null (same contract as
 * `assembleLineTail`).
 */
export function assembleLineTailStroke(
  slot: LineCacheSlot,
  makePath: () => CachePath,
  layout: ChartLayout,
  lastX: number,
  lastY: number,
  tipX: number,
  tipY: number
): void {
  'worklet';
  const dx = lineScrollDx(slot, layout);
  slot.tailScratch = ensured(slot.tailScratch, makePath);
  const tail = slot.tailScratch;
  tail.rewind();
  tail.moveTo(slot.cutX + dx, slot.cutY);
  drawSplineTail(
    tail,
    slot.cutX + dx,
    slot.cutY,
    slot.endTangent,
    lastX,
    lastY,
    tipX,
    tipY
  );
}

/**
 * Key-compare (via `lineCacheHits`) → on miss rebuild the prefix → assemble
 * `slot.scratch` (and `slot.fillScratch` when `wantFill`) for this frame.
 *
 * `pts` is drawLine's screen-space point array: decimated points 0..N-1
 * (the last with smooth Y) plus the appended live tip at index N, where
 * N = decimated.length. The prefix covers pts[0..N-2]; the two moving
 * points (last data point, tip) are appended per frame as the tail.
 *
 * Returns true when the slot's scratch paths are ready to draw; false when
 * caching doesn't apply (too few points) and the caller should use the
 * legacy immediate-mode path.
 *
 * Not keyed on purpose: smoothValue and `now` (tail-only inputs) and
 * pad.left/buffer (a pure x-shift, absorbed by dx). Caller must bypass this
 * entirely while the reveal morph is active (geometry depends on now_ms).
 *
 * This is the "full" path — it needs the whole `decimated`/`pts` arrays
 * even on a hit (to rebuild them from scratch if it turns out to be a
 * miss). `drawLine` avoids calling this on a probable hit: it calls
 * `lineCacheHits` directly first and, on true, skips straight to
 * `assembleLineTail` without ever building `decimated`/`pts`.
 */
export function updateLinePaths(
  slot: LineCacheSlot,
  makePath: () => CachePath,
  layout: ChartLayout,
  decimated: LivelinePoint[],
  pts: [number, number][],
  wantFill: boolean,
  dataRev: number,
  dataSource: number,
  visLen: number,
  visFirstT: number,
  visLastT: number,
  visLastV: number
): boolean {
  'worklet';
  const N = decimated.length;
  if (N < MIN_CACHE_POINTS) return false;

  const hit = lineCacheHits(
    slot,
    layout,
    dataRev,
    dataSource,
    visLen,
    visFirstT,
    visLastT,
    visLastV
  );

  if (!hit) {
    slot.prefix = ensured(slot.prefix, makePath);
    const prefix = slot.prefix;
    prefix.rewind();
    prefix.moveTo(pts[0]![0], pts[0]![1]);
    const prefixCount = N - 1; // pts[0..N-2]
    const { m, h } = computeSplineTangents(pts, prefixCount);
    emitSplineSegments(prefix, pts, m, h, prefixCount);
    slot.endTangent = m[prefixCount - 1]!;
    slot.cutX = pts[prefixCount - 1]![0];
    slot.cutY = pts[prefixCount - 1]![1];
    slot.tRef = decimated[0]!.time;
    slot.xRefAtBuild = pts[0]![0];
    slot.kDataRev = dataRev;
    slot.kDataSource = dataSource;
    slot.kLen = visLen;
    slot.kFirstT = visFirstT;
    slot.kLastT = visLastT;
    slot.kLastV = visLastV;
    slot.kMin = layout.minVal;
    slot.kMax = layout.maxVal;
    slot.kWindow = layout.rightEdge - layout.leftEdge;
    slot.kH = layout.h;
    slot.kPadTop = layout.pad.top;
    slot.kPadBottom = layout.pad.bottom;
    slot.kChartW = layout.chartW;
  }

  assembleLineTail(
    slot,
    makePath,
    layout,
    wantFill,
    pts[N - 1]![0],
    pts[N - 1]![1],
    pts[N]![0],
    pts[N]![1],
    pts[0]![1]
  );

  return true;
}
