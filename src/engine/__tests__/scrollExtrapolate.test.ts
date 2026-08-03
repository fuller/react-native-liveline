import { observeScrollRate, extrapolateScrollDx } from '../scrollExtrapolate';
import { MAX_SCROLL_EXTRAPOLATION_MS } from '../constants';

/**
 * The call site (useLivelineEngine's frame callback) can't be unit-tested —
 * it pulls in the native Skia binding — and the simulator renders at 60Hz, so
 * the paced-out branch this logic serves barely executes there. A sign error
 * would ship silently and only appear on real ProMotion hardware. Hence these.
 */

describe('observeScrollRate', () => {
  it('returns 0 when there is no previous recorded frame', () => {
    expect(observeScrollRate(0, -1, -5, 16, false)).toBe(0);
  });

  it('measures the observed per-ms rate over a normal paced interval', () => {
    // Chart scrolls left, so dx decreases: -10 -> -20 over 16ms.
    expect(observeScrollRate(-10, 100, -20, 116, false)).toBeCloseTo(
      -10 / 16,
      10
    );
  });

  it('is negative for leftward scroll and positive for rightward', () => {
    expect(observeScrollRate(-10, 100, -20, 116, false)).toBeLessThan(0);
    expect(observeScrollRate(-20, 100, -10, 116, false)).toBeGreaterThan(0);
  });

  it('rejects a non-advancing or backwards clock', () => {
    expect(observeScrollRate(-10, 100, -20, 100, false)).toBe(0);
    expect(observeScrollRate(-10, 100, -20, 90, false)).toBe(0);
  });

  it('rejects a gap too long to be a paced interval', () => {
    // A quiescence resume or return from background: large dx change over a
    // large gap would otherwise bake in a meaningless rate.
    const long = MAX_SCROLL_EXTRAPOLATION_MS * 2 + 1;
    expect(observeScrollRate(-10, 100, -5000, 100 + long, false)).toBe(0);
  });

  it('accepts a gap exactly at the bound', () => {
    const at = MAX_SCROLL_EXTRAPOLATION_MS * 2;
    expect(observeScrollRate(-10, 100, -20, 100 + at, false)).not.toBe(0);
  });

  // --- Layer identity ---------------------------------------------------
  //
  // The gap bound cannot catch these: a prefix rebuild happens on an
  // ordinary 16ms recorded frame, well inside every timing guard.

  it('refuses to observe a rate across a prefix rebuild', () => {
    // 35px of scroll accumulated since the last build, then the prefix is
    // rebuilt: dx snaps to 0 while the rendered line does not move at all.
    // Unguarded this reads as +2.1 px/ms, which a paced-out vsync would then
    // apply as a ~35px rightward flick.
    expect(observeScrollRate(-35, 100, 0, 116.7, false)).toBeCloseTo(
      35 / 16.7,
      10
    );
    expect(observeScrollRate(-35, 100, 0, 116.7, true)).toBe(0);
  });

  it('refuses to observe a rate across a compositing toggle', () => {
    // Layer goes live: last frame's dx was 0 because nothing was compositing.
    expect(observeScrollRate(0, 100, -35, 116.7, true)).toBe(0);
    // ...and stops compositing: this frame's dx is 0 for the same reason.
    expect(observeScrollRate(-35, 100, 0, 116.7, true)).toBe(0);
  });

  it('suppresses for exactly one frame, then resumes normally', () => {
    // The guard must not latch: the frame after a rebuild is measured
    // against the new prefix on both ends, so it is a valid pair again.
    expect(observeScrollRate(-35, 100, 0, 116.7, true)).toBe(0);
    expect(observeScrollRate(0, 116.7, -10, 133.4, false)).toBeCloseTo(
      -10 / 16.7,
      10
    );
  });

  it('a suppressed rate freezes rather than flings the transform', () => {
    // rate 0 makes extrapolateScrollDx return null, whose contract is
    // "leave the transform exactly where it is" — the correct behaviour for
    // the one paced-out vsync following a rebuild.
    const rate = observeScrollRate(-35, 100, 0, 116.7, true);
    expect(extrapolateScrollDx(0, 116.7, rate, 125)).toBeNull();
    // Without the guard it would have shoved the layer ~17px right of a
    // position the line never occupied.
    const bogus = observeScrollRate(-35, 100, 0, 116.7, false);
    expect(extrapolateScrollDx(0, 116.7, bogus, 125)!).toBeGreaterThan(15);
  });
});

describe('extrapolateScrollDx', () => {
  it('returns null before any recorded frame', () => {
    expect(extrapolateScrollDx(0, -1, -0.5, 16)).toBeNull();
  });

  it('returns null when no rate has been observed', () => {
    expect(extrapolateScrollDx(-10, 100, 0, 108)).toBeNull();
  });

  it('advances dx in the direction of travel', () => {
    // -0.6 px/ms leftward, 8ms after the last record (a 120Hz vsync landing
    // between two 60Hz records).
    expect(extrapolateScrollDx(-10, 100, -0.6, 108)).toBeCloseTo(-14.8, 10);
  });

  it('returns null once the gap outruns the extrapolation window', () => {
    const past = 100 + MAX_SCROLL_EXTRAPOLATION_MS + 1;
    expect(extrapolateScrollDx(-10, 100, -0.6, past)).toBeNull();
  });

  it('accepts a gap exactly at the window bound', () => {
    const at = 100 + MAX_SCROLL_EXTRAPOLATION_MS;
    expect(extrapolateScrollDx(-10, 100, -0.6, at)).not.toBeNull();
  });

  it('rejects a non-advancing or backwards clock', () => {
    expect(extrapolateScrollDx(-10, 100, -0.6, 100)).toBeNull();
    expect(extrapolateScrollDx(-10, 100, -0.6, 95)).toBeNull();
  });

  it('never accumulates: error is bounded by one vsync, not the run', () => {
    // Simulate 120Hz vsyncs against 60Hz records over 2 seconds of steady
    // scroll, with the extrapolation deliberately using a slightly stale rate.
    // Because every record overwrites with the exact value, divergence must
    // stay within one frame's worth of motion forever.
    const TRUE_RATE = -0.6; // px/ms
    const RECORD_MS = 16.67;
    const VSYNC_MS = 8.33;
    let dxLast = 0;
    let tLast = 0;
    let rate = TRUE_RATE * 0.9; // 10% stale on purpose
    let worst = 0;

    for (let i = 1; i * VSYNC_MS < 2000; i++) {
      const now = i * VSYNC_MS;
      const trueDx = TRUE_RATE * now;
      const isRecord = now - tLast >= RECORD_MS;

      if (isRecord) {
        rate = observeScrollRate(dxLast, tLast, trueDx, now, false);
        dxLast = trueDx;
        tLast = now;
      } else {
        const dxEx = extrapolateScrollDx(dxLast, tLast, rate, now);
        if (dxEx !== null) worst = Math.max(worst, Math.abs(dxEx - trueDx));
      }
    }

    // One 120Hz frame of motion is 0.6 * 8.33 = 5px; the stale-rate error is a
    // fraction of that and must never grow beyond it.
    expect(worst).toBeLessThan(5);
  });
});
