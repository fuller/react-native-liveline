/**
 * Cosine ease-in-out: maps linear progress `t` (0-1) to a smoothed 0-1
 * curve that starts and ends at zero velocity. Shared by every transition
 * that morphs over a fixed duration — window resize, candle width morph,
 * and the line/candle mode morph — so retuning the curve for one of them
 * can't silently leave the others on a different (copy-pasted) curve.
 */
export function easeInOutCos(t: number): number {
  'worklet';
  return (1 - Math.cos(t * Math.PI)) / 2;
}

/**
 * Interpolates between two positive sizes in log space, eased by a
 * pre-computed 0-1 progress value `t` (typically `easeInOutCos(rawT)`).
 * Log-space interpolation makes a size doubling and a size halving feel
 * like equal-magnitude changes — used wherever a "window span" or "candle
 * width" morphs between two values, so a plain linear lerp doesn't look
 * lopsided for large ratio changes. Shared so the two sites that need it
 * (window transition, candle width transition) can't drift onto a linear
 * lerp by accident during a future edit.
 */
export function logLerp(from: number, to: number, t: number): number {
  'worklet';
  return Math.exp(Math.log(from) + (Math.log(to) - Math.log(from)) * t);
}
