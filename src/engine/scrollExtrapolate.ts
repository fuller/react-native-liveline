import { MAX_SCROLL_EXTRAPOLATION_MS } from './constants';

/**
 * Scroll-transform extrapolation for paced-out vsyncs.
 *
 * Picture re-recording is paced to ~60fps (`MIN_FRAME_INTERVAL_MS`), but
 * translating an already-recorded picture is nearly free, so the scroll
 * layer's `<Group transform>` is allowed to advance on every vsync — 120fps on
 * a ProMotion display. On a vsync the pacing gate skips there is no `layout`
 * (it is computed inside `engineStep`), so `dx` cannot be recomputed; it is
 * linearly extrapolated from the last two *recorded* frames instead.
 *
 * Extrapolating the observed motion, rather than recomputing from
 * `windowSecs`/`chartW`, is deliberate: it keeps no copy of the engine's
 * time-advance rules, so it cannot drift out of sync with them, and pause,
 * window transitions and time-debt catch-up all come out right for free —
 * whatever the chart actually did over the last interval is assumed to
 * continue for the next few milliseconds. Every recorded frame overwrites the
 * result with the exact value, so error cannot accumulate past one vsync.
 *
 * Split into this Skia-free module (mirroring draw/scrollLayer.ts and
 * draw/gridLayer.ts) specifically so jest can exercise it: the call site lives
 * in useLivelineEngine.ts, which pulls in the native Skia binding and cannot
 * be unit-tested — and a sign error or a bad guard here would be invisible on
 * a 60Hz simulator, only surfacing on real high-refresh hardware.
 */

/**
 * Observed dx-per-ms across the last two recorded frames.
 *
 * Returns 0 (i.e. "don't extrapolate") unless the gap looks like a genuine
 * paced interval. A quiescence resume, a return from background or a
 * JS-thread stall produces a large dx change over a large gap; dividing one
 * by the other would bake in a meaningless rate that the next skipped vsync
 * would then apply. The bound is twice the extrapolation window, so an
 * ordinary paced interval (~16ms) is comfortably inside it while a stall is
 * not.
 *
 * `tPrev < 0` means no previous recorded frame.
 */
export function observeScrollRate(
  dxPrev: number,
  tPrev: number,
  dx: number,
  now: number
): number {
  'worklet';
  if (tPrev < 0) return 0;
  const gap = now - tPrev;
  if (gap <= 0 || gap > MAX_SCROLL_EXTRAPOLATION_MS * 2) return 0;
  return (dx - dxPrev) / gap;
}

/**
 * dx for a vsync that will not record, or `null` when the transform should be
 * left exactly as it is.
 *
 * `null` (rather than a fallback number) is the point: leaving the shared
 * value untouched costs nothing and shows the last correct position, whereas
 * guessing would move the layer somewhere it never was. Returns `null` when
 * there is no previous recorded frame, when no usable rate has been observed,
 * or when the gap has grown past `MAX_SCROLL_EXTRAPOLATION_MS` — beyond that
 * the stored rate is stale and extrapolating it would fling the layer.
 */
export function extrapolateScrollDx(
  dxLast: number,
  tLast: number,
  rate: number,
  now: number
): number | null {
  'worklet';
  if (tLast < 0 || rate === 0) return null;
  const gap = now - tLast;
  if (gap <= 0 || gap > MAX_SCROLL_EXTRAPOLATION_MS) return null;
  return dxLast + rate * gap;
}
