import type { CachePath } from './pathCache';

/**
 * Builds the badge pill (+ optional curved tail) shape directly on a
 * cached path via primitive calls — moveTo/lineTo/arcToTangent/cubicTo —
 * instead of building an SVG path string and parsing it natively via
 * `Skia.Path.MakeFromSVGString`. `arcToTangent` for the two right-side
 * corners (and, tail-less, the two left-side corners) is the same
 * radius-rounding primitive `roundedRect` (candlestick.ts) already uses;
 * since `pillH === 2·r` here, the two corners on each rounded side meet
 * with no straight segment between them, degenerating to a full semicircle
 * exactly as the original SVG's `A{r},{r},0,0,1,...` arc commands did. The
 * tail's two cubic curves are ported verbatim from the original SVG's `C`
 * commands (same control points, same endpoints).
 *
 * Coordinate system: (0,0) is top-left of the shape bounding box. Total
 * size: (tailLen + pillW) × pillH (tailLen is 0 when `tail` is false). The
 * tail tip points left at (0, pillH/2). Caller positions the finished path
 * with a canvas translate rather than baking an offset in here, so it can
 * stay cached across frames while only the badge's on-screen position moves.
 *
 * Caller must rewind (or freshly allocate) `path` first — this only emits
 * verbs, it never resets the path itself.
 */
export function buildBadgePillPath(
  path: CachePath,
  pillW: number,
  pillH: number,
  tailLen: number,
  tailSpread: number,
  tail: boolean
): void {
  'worklet';
  const r = pillH / 2;
  const left = tail ? tailLen : 0;
  const rightX = left + pillW;

  path.moveTo(left + r, 0);
  path.lineTo(rightX - r, 0);
  path.arcToTangent(rightX, 0, rightX, r, r); // top-right corner
  path.lineTo(rightX, pillH - r);
  path.arcToTangent(rightX, pillH, rightX - r, pillH, r); // bottom-right corner
  path.lineTo(left + r, pillH);

  if (tail) {
    path.cubicTo(tailLen + 2, pillH, 3, r + tailSpread, 0, r);
    path.cubicTo(3, r - tailSpread, tailLen + 2, 0, tailLen + r, 0);
  } else {
    path.arcToTangent(0, pillH, 0, pillH - r, r); // bottom-left corner
    path.lineTo(0, r);
    path.arcToTangent(0, 0, r, 0, r); // top-left corner
  }
  path.close();
}

/** Badge geometry constants */
export const BADGE_PAD_X = 10;
export const BADGE_PAD_Y = 3;
export const BADGE_TAIL_LEN = 5;
export const BADGE_TAIL_SPREAD = 2.5;
export const BADGE_LINE_H = 16;
