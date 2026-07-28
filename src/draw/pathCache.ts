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
