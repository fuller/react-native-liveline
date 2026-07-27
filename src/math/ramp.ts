/**
 * Smoothstep-shaped reveal ramp: 0 below `start`, 1 above `end`, smoothstep
 * in between. Shared by `drawFrame`, `drawMultiFrame`, and `drawCandleFrame`
 * (src/draw/index.ts) to stagger sub-elements (grid, time axis, arrows,
 * close-price line) in across the chart's reveal/morph animation — each of
 * them previously redefined an identical `revealRamp` closure inline, so a
 * tweak to the curve in one draw path could silently leave the other two on
 * the old shape. Also avoids allocating a fresh closure every frame in all
 * three hot per-frame draw paths.
 */
export function smoothstepRamp(
  reveal: number,
  start: number,
  end: number
): number {
  'worklet';
  const t = Math.max(0, Math.min(1, (reveal - start) / (end - start)));
  return t * t * (3 - 2 * t);
}
