import type { SplinePath } from '../math/spline';

/**
 * Structural subset of SkPath used by every cross-frame path cache in the
 * draw layer (badge pill, line spline) — SkPath satisfies it. Keeping
 * caches free of a direct Skia import lets jest exercise them with fake
 * path recorders, the same way math.test.ts fakes `SplinePath`.
 */
export interface CachePath extends SplinePath {
  moveTo(x: number, y: number): void;
  rewind(): void;
  close(): void;
  arcToTangent(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    r: number
  ): unknown;
  addPath(src: CachePath, matrix?: undefined, extend?: boolean): unknown;
  offset(dx: number, dy: number): unknown;
}

/**
 * Lazily allocates `slot`'s path on first use, otherwise returns the
 * existing object unchanged — every path cache in the draw layer rebuilds
 * by rewinding and refilling the *same* native object rather than replacing
 * it, so a rebuild never allocates a new host object, only a fresh commit
 * into an already-live one.
 */
export function ensured<P extends CachePath>(
  cur: P | null,
  makePath: () => P
): P {
  'worklet';
  return cur ?? makePath();
}

/**
 * Structural subset of `ChartLayout` that the shared layout key reads, for the
 * same reason `CachePath` is a structural subset of `SkPath`: this module
 * stays free of imports the caches don't strictly need, so jest can drive the
 * key logic with a plain object literal. `ChartLayout` satisfies it.
 */
export interface KeyedLayout {
  h: number;
  chartW: number;
  leftEdge: number;
  rightEdge: number;
  minVal: number;
  maxVal: number;
  pad: { top: number; bottom: number };
}

/**
 * The layout half of every cross-frame path cache's invalidation key — the
 * seven `layout`-derived numbers that `lineCache` and `candleCache` both
 * keyed on independently (and, before this, under two different spellings:
 * `kMin`/`kMax` vs `kMinVal`/`kMaxVal` for the same `layout.minVal`/`maxVal`).
 *
 * **Flat numbers only, compared field-by-field.** A cache slot allocates one
 * of these ONCE, at slot construction, and then only ever overwrites its
 * fields in place; `layoutKeyMatches` reads those fields directly and returns
 * a boolean. So the per-frame check — which runs 60-120x/sec on the UI thread
 * — allocates nothing, exactly as it did when the fields were inlined into the
 * slot. Nesting the object costs one extra property load per field and no
 * allocation; do NOT "generalize" this into an array of field names plus a
 * loop, which would trade that for an iteration and defeat the whole point.
 *
 * `window` is stored pre-subtracted (`rightEdge - leftEdge`, the x scale)
 * because that difference — not the two edges — is what the cached geometry
 * actually depends on: a pure pan moves both edges together and is absorbed by
 * the caches' `dx` translate, so keying the edges separately would invalidate
 * on every scrolled frame. `layout.w` is deliberately NOT keyed: it reaches
 * the drawn geometry only through `chartW` (keyed) and `pad.left` (absorbed by
 * `dx`), so it can never catch an invalidation those two miss.
 *
 * Each cache keeps its OWN data-identity fields (`kDataRev`/`kLen`/`kFirstT`/…
 * for the line, `kCandlesRev`/`kClosedCount`/`kRadius`/… for candles) on the
 * slot itself — those are not layout, and no two caches agree on them.
 */
export interface LayoutKey {
  minVal: number;
  maxVal: number;
  /** rightEdge - leftEdge (the x scale) — see the note above. */
  window: number;
  h: number;
  padTop: number;
  padBottom: number;
  chartW: number;
}

/** A zeroed layout key. Allocated once per cache slot, never per frame. */
export function createLayoutKey(): LayoutKey {
  'worklet';
  return {
    minVal: 0,
    maxVal: 0,
    window: 0,
    h: 0,
    padTop: 0,
    padBottom: 0,
    chartW: 0,
  };
}

/**
 * Overwrites `key` in place from `layout` — called only on a cache miss,
 * alongside the rebuild it is recording. Mutates rather than returning a fresh
 * object so a rebuild allocates no key.
 *
 * Must stay field-for-field in step with `layoutKeyMatches` below; they are
 * adjacent on purpose so a new dimension cannot be added to one alone.
 */
export function writeLayoutKey(key: LayoutKey, layout: KeyedLayout): void {
  'worklet';
  key.minVal = layout.minVal;
  key.maxVal = layout.maxVal;
  key.window = layout.rightEdge - layout.leftEdge;
  key.h = layout.h;
  key.padTop = layout.pad.top;
  key.padBottom = layout.pad.bottom;
  key.chartW = layout.chartW;
}

/**
 * True when `key` still describes `layout`. Pure, allocation-free, seven
 * number compares — safe to call every frame before any expensive work.
 */
export function layoutKeyMatches(key: LayoutKey, layout: KeyedLayout): boolean {
  'worklet';
  return (
    key.minVal === layout.minVal &&
    key.maxVal === layout.maxVal &&
    key.window === layout.rightEdge - layout.leftEdge &&
    key.h === layout.h &&
    key.padTop === layout.pad.top &&
    key.padBottom === layout.pad.bottom &&
    key.chartW === layout.chartW
  );
}
