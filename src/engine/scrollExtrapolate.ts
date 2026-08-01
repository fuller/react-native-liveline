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
 * `layerChanged` is the second, subtler guard, and the gap bound does NOT
 * subsume it. `dx` is an offset *of a particular recorded picture* — it is
 * meaningful only relative to the prefix that was built when `xRefAtBuild`
 * was captured. Two consecutive recorded frames 16ms apart can therefore
 * report `dx = -35` then `dx = 0` with the on-screen line perfectly
 * continuous, because the prefix was rebuilt in between and the new one
 * already bakes in that 35px. Differencing those two numbers yields a rate
 * of +2.1 px/ms that describes nothing physical; the next paced-out vsync
 * would then shove the `<Group transform>` ~35px to the right, and the
 * following recorded frame would snap it back — a flick, once per line-cache
 * rebuild, on high-refresh hardware only. The same applies when the layer
 * stops or starts compositing: `dx` is 0 on every frame the layer is not
 * live, so either edge of that toggle differences two unrelated quantities.
 *
 * So: no rate is observable across a frame whose layer identity moved. Pass
 * `true` and this returns 0 — one paced-out vsync leaves the transform
 * exactly where it was (`extrapolateScrollDx` returns null on rate 0), and
 * the next recorded frame supplies both an exact dx and an honest rate.
 *
 * `tPrev < 0` means no previous recorded frame.
 */
export function observeScrollRate(
  dxPrev: number,
  tPrev: number,
  dx: number,
  now: number,
  layerChanged: boolean
): number {
  'worklet';
  if (tPrev < 0 || layerChanged) return 0;
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
