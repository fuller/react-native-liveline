import { MAX_DELTA_MS } from './constants';

/**
 * Time-debt accrual for the frames `engineStep` never sees.
 *
 * `s.timeDebt` is how far behind wall-clock the chart is deliberately
 * running: `now = Date.now()/1000 - timeDebt`. While a chart is paused it
 * grows at exactly one second per second (`engineStep` does
 * `timeDebt += dt/1000 * pauseProgress`), which is what keeps the frozen
 * window frozen instead of sliding left. Get the rate wrong in either
 * direction and the error is not a glitch, it is a position: over-accrue and
 * the chart is further into the past than it ever was; under-accrue and it
 * has silently advanced while "paused".
 *
 * Two paths bypass `engineStep` entirely and so must do their own accrual:
 * the quiescence skip (chart provably static, picture not re-recorded) and
 * the suspended frame loop (`frame.setActive(false)` on background or
 * `active={false}`). Both live in `useLivelineEngine.ts`, which imports the
 * native Skia binding and cannot be unit-tested — and both are wrong only
 * after ten seconds of nothing happening, which is precisely the class of
 * bug a manual check does not catch. Hence this Skia-free module, mirroring
 * `scrollExtrapolate.ts`.
 */

/**
 * Milliseconds of real time to credit on a frame that skips `engineStep`.
 *
 * The whole point is that `lastAccrualT` is a *separate* clock from
 * `EngineState.lastFrameTimestamp`, advanced on every frame that credits
 * debt rather than only on frames that record. Measuring accrual against
 * `lastFrameTimestamp` instead is the bug this replaces: that field does not
 * move while frames are being skipped, so consecutive skipped frames measure
 * 16.7ms, then 33.3ms, then 50, 50, 50… against the same fixed origin and
 * accrue roughly three seconds of debt per second of real time at 60Hz (and
 * six at 120Hz). With a clock that advances every credited frame, each frame
 * contributes exactly its own inter-frame interval, so the sum telescopes to
 * the elapsed wall-clock regardless of refresh rate.
 *
 * Clamped to `MAX_DELTA_MS` for the same reason `dt` is: a single stalled
 * interval should nudge the chart forward slightly rather than let one
 * pathological gap dominate the debt. Returns 0 for a null origin (no frame
 * has recorded yet, so there is no interval to credit) and for a
 * non-advancing clock.
 */
export function accrualDeltaMs(
  lastAccrualT: number | null,
  now: number
): number {
  'worklet';
  if (lastAccrualT === null) return 0;
  const raw = now - lastAccrualT;
  if (raw <= 0) return 0;
  return raw > MAX_DELTA_MS ? MAX_DELTA_MS : raw;
}

/**
 * Seconds of debt to credit on the first frame after the frame loop resumes,
 * given the wall-clock milliseconds it was suspended for.
 *
 * Scaled by `pauseProgress` — the same factor `engineStep` applies every
 * frame — so this needs no notion of "was it paused" of its own, and unpaused
 * charts (`pauseProgress === 0`) get exactly zero, preserving their current,
 * correct behaviour of simply advancing to the new wall-clock. A chart
 * mid-pause-transition when it was backgrounded gets the proportional credit
 * that continuing to run would have given it.
 *
 * `pauseProgress` is read from state frozen at suspend time, so it is the
 * value that governed the whole absence, not a post-hoc guess.
 */
export function suspendedDebtSec(
  pendingMs: number,
  pauseProgress: number
): number {
  'worklet';
  if (pendingMs <= 0 || pauseProgress <= 0) return 0;
  const p = pauseProgress > 1 ? 1 : pauseProgress;
  return (pendingMs / 1000) * p;
}
