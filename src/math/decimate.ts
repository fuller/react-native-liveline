import type { LivelinePoint } from '../types';

/**
 * Min-max decimation for spline rendering.
 *
 * `drawLine` feeds every visible point into `drawSpline`, whose
 * Fritsch-Carlson tangent pass is O(n) over the array — every frame. For a
 * dense tick feed that's unbounded work that buys nothing: past a point,
 * screen pixels can't distinguish more detail anyway. This caps the point
 * count at roughly 2 per pixel-bucket of `chartW` (one bucket's min value and
 * max value point) so spikes/wicks survive instead of being silently dropped
 * the way naive stride-sampling would drop them.
 *
 * Fast path: if `visible.length <= chartW`, the input is returned unchanged
 * (same array reference, zero allocation) — normal sparse real-time usage
 * (e.g. one tick per second) never pays for this.
 *
 * The first and last elements of `visible` are always preserved as the
 * first/last elements of the output — `drawLine` treats the last point
 * specially (its Y comes from `smoothValue`, not the raw data), and the
 * appended live tip depends on iterating that same last-index position.
 *
 * Output is chronologically ordered (`drawSpline` assumes monotonically
 * increasing x).
 */
export function decimateMinMax(
  visible: LivelinePoint[],
  chartW: number
): LivelinePoint[] {
  'worklet';
  const n = visible.length;
  if (n <= chartW) return visible;

  const first = visible[0]!;
  const last = visible[n - 1]!;
  const bucketCount = Math.max(1, Math.round(chartW));
  const timeRange = last.time - first.time;
  const bucketWidth = timeRange > 0 ? timeRange / bucketCount : 0;

  // Per-bucket min/max, tracked as indices into `visible` (interior points
  // only — index 0 and n-1 are handled separately as first/last).
  const minIdx: number[] = new Array(bucketCount).fill(-1);
  const maxIdx: number[] = new Array(bucketCount).fill(-1);

  for (let i = 1; i < n - 1; i++) {
    const p = visible[i]!;
    let b =
      bucketWidth > 0 ? Math.floor((p.time - first.time) / bucketWidth) : 0;
    if (b < 0) b = 0;
    else if (b >= bucketCount) b = bucketCount - 1;

    const mi = minIdx[b]!;
    if (mi === -1 || p.value < visible[mi]!.value) minIdx[b] = i;
    const ma = maxIdx[b]!;
    if (ma === -1 || p.value > visible[ma]!.value) maxIdx[b] = i;
  }

  const out: LivelinePoint[] = [first];
  for (let b = 0; b < bucketCount; b++) {
    const mi = minIdx[b]!;
    const ma = maxIdx[b]!;
    if (mi === -1) continue; // empty bucket
    if (mi === ma) {
      out.push(visible[mi]!);
    } else if (visible[mi]!.time <= visible[ma]!.time) {
      out.push(visible[mi]!);
      out.push(visible[ma]!);
    } else {
      out.push(visible[ma]!);
      out.push(visible[mi]!);
    }
  }
  out.push(last);

  return out;
}
