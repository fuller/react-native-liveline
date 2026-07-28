import {
  lineOverlayPresence,
  shouldBuildLineOverlay,
  LINE_OVERLAY_MIN_PRESENCE,
} from '../lineOverlay';

// A dense grid over both inputs, including every threshold either function
// mentions and the values immediately on each side of them.
const GRID = [
  0, 0.0001, 0.005, 0.00999, 0.01, 0.01001, 0.02, 0.05, 0.1, 0.2, 0.2154,
  0.2155, 0.3, 0.5, 0.7, 0.78, 0.7846, 0.79, 0.9, 0.98, 0.98999, 0.99, 0.99001,
  0.999, 1,
];

describe('lineOverlayPresence', () => {
  it('is 0 in steady candle mode (no line mode, reveal complete)', () => {
    expect(lineOverlayPresence(0, 1)).toBe(0);
  });

  it('is 1 in full line mode', () => {
    expect(lineOverlayPresence(1, 1)).toBe(1);
  });

  it('tracks lineModeProg once the reveal has finished', () => {
    for (const p of GRID) expect(lineOverlayPresence(p, 1)).toBeCloseTo(p);
  });

  it('cubes the reveal contribution in candle mode', () => {
    // reveal=0.5 => inv=0.5 => 0.5^3 = 0.125, not 0.5.
    expect(lineOverlayPresence(0, 0.5)).toBeCloseTo(0.125);
  });

  it('uses a linear reveal contribution in full line mode', () => {
    // At lineModeProg >= 0.99 the reveal term is 1 - reveal, but the max with
    // lineModeProg dominates unless reveal is very low.
    expect(lineOverlayPresence(0.99, 0)).toBeCloseTo(1);
    expect(lineOverlayPresence(0.99, 1)).toBeCloseTo(0.99);
  });

  it('stays within [0, 1] across the grid', () => {
    for (const p of GRID) {
      for (const r of GRID) {
        const lp = lineOverlayPresence(p, r);
        expect(lp).toBeGreaterThanOrEqual(0);
        expect(lp).toBeLessThanOrEqual(1);
      }
    }
  });

  it('never decreases as lineModeProg rises at a fixed reveal', () => {
    for (const r of GRID) {
      let prev = -Infinity;
      for (const p of GRID) {
        const lp = lineOverlayPresence(p, r);
        expect(lp).toBeGreaterThanOrEqual(prev);
        prev = lp;
      }
    }
  });
});

describe('shouldBuildLineOverlay', () => {
  it('skips the build in steady candle mode', () => {
    expect(shouldBuildLineOverlay(0, 1)).toBe(false);
  });

  it('builds while any line-mode transition is in progress', () => {
    expect(shouldBuildLineOverlay(0.5, 1)).toBe(true);
    expect(shouldBuildLineOverlay(1, 1)).toBe(true);
  });

  it('builds for the whole reveal, including its tail', () => {
    expect(shouldBuildLineOverlay(0, 0)).toBe(true);
    expect(shouldBuildLineOverlay(0, 0.5)).toBe(true);
    expect(shouldBuildLineOverlay(0, 0.999)).toBe(true);
  });

  // THE load-bearing test. If either function is changed such that the
  // engine could skip building an array the drawer still wants, the overlay
  // silently disappears mid-transition — a bug with no test failure and no
  // crash, visible only on a device, only during an animation. This asserts
  // the one relationship that makes the optimization safe.
  it('is true wherever the drawer would draw (never skips a wanted frame)', () => {
    for (const p of GRID) {
      for (const r of GRID) {
        const drawerWouldDraw =
          lineOverlayPresence(p, r) > LINE_OVERLAY_MIN_PRESENCE;
        if (drawerWouldDraw) {
          expect({
            lineModeProg: p,
            chartReveal: r,
            builds: shouldBuildLineOverlay(p, r),
          }).toEqual({ lineModeProg: p, chartReveal: r, builds: true });
        }
      }
    }
  });

  // Guards the other direction: the gate has to actually skip something, or
  // the optimization is a no-op and the complexity isn't paying for itself.
  it('does skip real frames — steady candle mode is entirely excluded', () => {
    const skipped = GRID.flatMap((p) =>
      GRID.filter((r) => !shouldBuildLineOverlay(p, r)).map((r) => [p, r])
    );
    expect(skipped.length).toBeGreaterThan(0);
    // Everything skipped must be reveal-complete and out of line mode.
    for (const [p, r] of skipped) {
      expect(r).toBe(1);
      expect(p).toBeLessThanOrEqual(LINE_OVERLAY_MIN_PRESENCE);
    }
  });
});
