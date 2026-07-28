/**
 * Minimal path interface for spline drawing — satisfied by Skia's `SkPath`.
 * (The web version drew into a CanvasRenderingContext2D; SkPath's `cubicTo`
 * is the direct equivalent of `bezierCurveTo`.)
 */
export interface SplinePath {
  lineTo(x: number, y: number): void;
  cubicTo(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number
  ): void;
}

// NOTE: worklet helper ordering matters — drawSpline calls the two helpers
// below, so they must be declared above it (the worklets babel plugin turns
// function declarations into const-assigned worklets, losing hoisting; a
// helper referenced before its const assignment would be captured as
// undefined on the UI thread).

/**
 * Steps 1-3 of Fritsch-Carlson monotone cubic interpolation: secant slopes,
 * tangent estimates, and the monotonicity constraint (alpha^2 + beta^2 <= 9).
 * `count` limits the pass to `pts[0..count-1]` without slicing — used by the
 * line-path cache to build a prefix spline over all but the moving tail
 * points. Requires count >= 2.
 */
export function computeSplineTangents(
  pts: [number, number][],
  count: number = pts.length
): { m: number[]; h: number[] } {
  'worklet';
  const n = count;

  // 1. Compute secant slopes (delta) between consecutive points
  const delta: number[] = new Array(n - 1);
  const h: number[] = new Array(n - 1); // x-intervals
  for (let i = 0; i < n - 1; i++) {
    h[i] = pts[i + 1]![0] - pts[i]![0];
    delta[i] = h[i] === 0 ? 0 : (pts[i + 1]![1] - pts[i]![1]) / h[i]!;
  }

  // 2. Initial tangent estimates
  const m: number[] = new Array(n);
  m[0] = delta[0]!;
  m[n - 1] = delta[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1]! * delta[i]! <= 0) {
      // Sign change or zero — tangent must be zero for monotonicity
      m[i] = 0;
    } else {
      m[i] = (delta[i - 1]! + delta[i]!) / 2;
    }
  }

  // 3. Fritsch-Carlson constraint: alpha^2 + beta^2 <= 9
  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) {
      // Flat segment — zero both endpoint tangents
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const alpha = m[i]! / delta[i]!;
      const beta = m[i + 1]! / delta[i]!;
      const s2 = alpha * alpha + beta * beta;
      if (s2 > 9) {
        const s = 3 / Math.sqrt(s2);
        m[i] = s * alpha * delta[i]!;
        m[i + 1] = s * beta * delta[i]!;
      }
    }
  }

  return { m, h };
}

/**
 * Step 4: emit the bezier segments for `pts[0..count-1]` using precomputed
 * tangents. Caller must have positioned the path at `pts[0]` (moveTo).
 */
export function emitSplineSegments(
  path: SplinePath,
  pts: [number, number][],
  m: number[],
  h: number[],
  count: number = pts.length
): void {
  'worklet';
  for (let i = 0; i < count - 1; i++) {
    const hi = h[i]!;
    path.cubicTo(
      pts[i]![0] + hi / 3,
      pts[i]![1] + (m[i]! * hi) / 3,
      pts[i + 1]![0] - hi / 3,
      pts[i + 1]![1] - (m[i + 1]! * hi) / 3,
      pts[i + 1]![0],
      pts[i + 1]![1]
    );
  }
}

/**
 * Fritsch-Carlson monotone cubic interpolation.
 * Guarantees no overshoots — the curve never exceeds local min/max.
 * Used by Chart.js (monotone mode) and D3 (curveMonotoneX).
 *
 * Continues from the path's current position — caller must moveTo first point.
 */
export function drawSpline(path: SplinePath, pts: [number, number][]) {
  'worklet';
  if (pts.length < 2) return;
  if (pts.length === 2) {
    path.lineTo(pts[1]![0], pts[1]![1]);
    return;
  }
  const { m, h } = computeSplineTangents(pts);
  emitSplineSegments(path, pts, m, h);
}

/**
 * Appends the two live-tail segments to a cached prefix spline:
 * cut → (x1,y1) [last data point, smooth Y] → (x2,y2) [live tip].
 *
 * `mCut` is the tangent the cached prefix actually ended with (post-clamp) —
 * reused verbatim so the junction stays C1 regardless of how the tail points
 * move between frames. The interior tangent uses the same averaged-secant +
 * monotone clamp idea as the full spline (three-times rule), computed only
 * over the two tail secants. Caller guarantees the path's current position
 * is (cutX, cutY).
 */
export function drawSplineTail(
  path: SplinePath,
  cutX: number,
  cutY: number,
  mCut: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): void {
  'worklet';
  const h0 = x1 - cutX;
  const h1 = x2 - x1;
  if (h0 <= 0) {
    // Degenerate ordering — straight segments (matches drawSpline's zero-h
    // slope handling in spirit; should not happen with monotonic time data)
    path.lineTo(x1, y1);
    path.lineTo(x2, y2);
    return;
  }
  const d0 = (y1 - cutY) / h0;
  const d1 = h1 > 0 ? (y2 - y1) / h1 : 0;

  let m1: number;
  if (d0 * d1 <= 0) {
    m1 = 0;
  } else {
    m1 = (d0 + d1) / 2;
    const lim = 3 * Math.min(Math.abs(d0), Math.abs(d1));
    if (Math.abs(m1) > lim) m1 = m1 > 0 ? lim : -lim;
  }
  const m2 = d1;

  path.cubicTo(
    cutX + h0 / 3,
    cutY + (mCut * h0) / 3,
    x1 - h0 / 3,
    y1 - (m1 * h0) / 3,
    x1,
    y1
  );
  if (h1 > 0) {
    path.cubicTo(
      x1 + h1 / 3,
      y1 + (m1 * h1) / 3,
      x2 - h1 / 3,
      y2 - (m2 * h1) / 3,
      x2,
      y2
    );
  } else {
    path.lineTo(x2, y2);
  }
}
