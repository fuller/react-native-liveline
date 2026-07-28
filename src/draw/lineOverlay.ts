/**
 * The candle-mode line overlay's presence gate, in one place.
 *
 * Candle mode can draw a line on top of the candles in two situations: the
 * user is transitioning to/from line mode (`lineModeProg`), or the reveal
 * morph is still running and the line is what the loading squiggly morphs
 * out of (`chartReveal`). Two different modules need to agree about this:
 *
 * - `drawCandleFrame` (draw/index.ts) decides whether to *draw* it, from
 *   `lineOverlayPresence` — which is also the alpha the overlay is drawn at.
 * - `engineStep` (engine/step.ts) decides whether to *build* the point array
 *   the drawer would consume, from `shouldBuildLineOverlay`.
 *
 * They were previously separate inline expressions sharing a hardcoded
 * `0.01`, which is exactly the kind of coupling that rots: if the drawer's
 * threshold moved and the builder's didn't, the builder would start
 * skipping frames the drawer still wanted, and the overlay would vanish
 * during a transition. Both live here now, and `lineOverlay.test.ts`
 * asserts the invariant that keeps them safe — see `shouldBuildLineOverlay`.
 *
 * Deliberately free of Skia imports so jest can exercise it directly:
 * `draw/index.ts` pulls in the native binding at import time, which the
 * draw-layer unit tests can't load (same reasoning as `draw/pathCache.ts`,
 * and the local `DASH_4_4` in `draw/line.ts`).
 */

/** Below this presence the overlay contributes nothing and isn't drawn. */
export const LINE_OVERLAY_MIN_PRESENCE = 0.01;

/**
 * How present the line overlay is this frame, in [0, 1] — used directly as
 * its draw alpha. The reveal contribution is cubed in candle mode so the
 * candles become dominant early and the morphing line never reads as a
 * "line chart"; in full line mode it's linear, because there the line *is*
 * the chart.
 */
export function lineOverlayPresence(
  lineModeProg: number,
  chartReveal: number
): number {
  'worklet';
  const fullLineMode = lineModeProg >= 0.99;
  const inv = 1 - chartReveal;
  const revealLine = fullLineMode ? inv : inv * inv * inv;
  return Math.max(lineModeProg, revealLine);
}

/**
 * Whether `engineStep` should build the overlay's point array this frame.
 *
 * **Invariant:** this must be true whenever `lineOverlayPresence(...) >
 * LINE_OVERLAY_MIN_PRESENCE` — i.e. it may only ever skip work the drawer
 * was going to ignore anyway, never the reverse. It is deliberately
 * *broader* than the drawer's test rather than an exact mirror of it:
 * `chartReveal < 1` covers the entire reveal, including the tail where the
 * cubed reveal term has already decayed under the threshold. Building a
 * handful of unnecessary frames at the end of a reveal is free; skipping
 * one the drawer wanted is a visible dropout.
 *
 * `lineOverlay.test.ts` asserts this over a dense grid of both inputs, so a
 * future change to either function that breaks the relationship fails a
 * test instead of shipping.
 */
export function shouldBuildLineOverlay(
  lineModeProg: number,
  chartReveal: number
): boolean {
  'worklet';
  return lineModeProg > LINE_OVERLAY_MIN_PRESENCE || chartReveal < 1;
}
