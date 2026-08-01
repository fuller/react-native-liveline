import {
  MIN_FRAME_INTERVAL_MS,
  MAX_SCROLL_EXTRAPOLATION_MS,
} from '../constants';
import { observeScrollRate, extrapolateScrollDx } from '../scrollExtrapolate';

/**
 * The frame-pacing interval and the scroll-extrapolation window interact, and
 * nothing else in the codebase would fail if a future tuning broke that
 * relationship: the symptom is judder on 120Hz hardware, which neither jest
 * nor the simulator can show. These assert the two inequalities documented in
 * `constants.ts` directly, so the regression is red instead of silent.
 */
describe('frame-pacing / extrapolation constants', () => {
  it('paces frames faster than the extrapolation window (else the transform freezes)', () => {
    // A vsync skipped by pacing can land up to one pacing interval after the
    // last recorded frame. If that could exceed the extrapolation window,
    // `extrapolateScrollDx` would return null on exactly the frames the
    // high-refresh scroll layer exists for.
    expect(MIN_FRAME_INTERVAL_MS).toBeLessThan(MAX_SCROLL_EXTRAPOLATION_MS);
  });

  it('keeps the extrapolation window under twice the pacing interval', () => {
    // `observeScrollRate`'s stale-gap bound is MAX_SCROLL_EXTRAPOLATION_MS*2;
    // an ordinary paced interval must sit comfortably inside it.
    expect(MAX_SCROLL_EXTRAPOLATION_MS).toBeLessThan(MIN_FRAME_INTERVAL_MS * 2);
  });

  it('a vsync one pacing interval after a record still gets an extrapolated dx', () => {
    // The inequalities restated as the behaviour they protect, end to end:
    // observe a rate across a paced interval, then extrapolate across another.
    const rate = observeScrollRate(0, 0, -1, MIN_FRAME_INTERVAL_MS, false);
    expect(rate).not.toBe(0);
    const dx = extrapolateScrollDx(
      -1,
      MIN_FRAME_INTERVAL_MS,
      rate,
      MIN_FRAME_INTERVAL_MS * 2
    );
    expect(dx).not.toBeNull();
  });
});
