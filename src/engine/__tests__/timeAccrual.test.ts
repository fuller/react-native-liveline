import { accrualDeltaMs, suspendedDebtSec } from '../timeAccrual';
import { MAX_DELTA_MS, QUIESCENT_FRAME_THRESHOLD } from '../constants';

/**
 * The call site (useLivelineEngine's frame callback) imports the native Skia
 * binding and cannot be unit-tested, and the failure mode here — a paused
 * chart that jumps somewhere it never was — only becomes visible after ten
 * seconds of a chart doing nothing, which no manual pass reliably catches.
 * So the accrual arithmetic is exercised here instead, by replaying the frame
 * loop's skip paths against a fake vsync clock.
 */

/**
 * Replays the quiescent branch of the frame callback: one credit per vsync,
 * measured against the accrual clock, which advances every time.
 */
function runQuiescent(seconds: number, hz: number): number {
  const interval = 1000 / hz;
  let timeDebt = 0;
  let lastAccrual: number | null = 0;
  for (let i = 1; i <= seconds * hz; i++) {
    const now = i * interval;
    timeDebt += accrualDeltaMs(lastAccrual, now) / 1000;
    lastAccrual = now;
  }
  return timeDebt;
}

/**
 * The pre-fix behaviour, kept as an executable statement of the bug: debt was
 * measured from `lastFrameTimestamp`, which does NOT move while frames are
 * skipped, so every skipped frame re-credited the whole span since the last
 * recorded frame.
 */
function runQuiescentAgainstFixedOrigin(seconds: number, hz: number): number {
  const interval = 1000 / hz;
  const lastRecorded = 0;
  let timeDebt = 0;
  for (let i = 1; i <= seconds * hz; i++) {
    const now = i * interval;
    timeDebt += Math.min(now - lastRecorded, MAX_DELTA_MS) / 1000;
  }
  return timeDebt;
}

describe('accrualDeltaMs', () => {
  it('credits exactly the interval since the last credited frame', () => {
    expect(accrualDeltaMs(100, 116.7)).toBeCloseTo(16.7, 10);
    expect(accrualDeltaMs(100, 108.33)).toBeCloseTo(8.33, 10);
  });

  it('credits nothing before the first frame has recorded', () => {
    expect(accrualDeltaMs(null, 16.7)).toBe(0);
  });

  it('credits nothing for a non-advancing or backwards clock', () => {
    expect(accrualDeltaMs(100, 100)).toBe(0);
    expect(accrualDeltaMs(100, 90)).toBe(0);
  });

  it('clamps a stalled interval to MAX_DELTA_MS', () => {
    expect(accrualDeltaMs(100, 100 + MAX_DELTA_MS + 1)).toBe(MAX_DELTA_MS);
    expect(accrualDeltaMs(100, 5100)).toBe(MAX_DELTA_MS);
  });
});

describe('quiescent accrual accrues real time, not a multiple of it', () => {
  it('accrues 1s of debt per 1s of quiescence at 60Hz', () => {
    expect(runQuiescent(10, 60)).toBeCloseTo(10, 6);
  });

  it('accrues the same at 120Hz — the rate cannot depend on refresh rate', () => {
    expect(runQuiescent(10, 120)).toBeCloseTo(10, 6);
    expect(runQuiescent(10, 120)).toBeCloseTo(runQuiescent(10, 60), 6);
  });

  it('holds over a long pause: 60s of quiescence is 60s of debt', () => {
    expect(runQuiescent(60, 60)).toBeCloseTo(60, 5);
  });

  it('is the regression: the fixed-origin version over-accrued ~3x', () => {
    // 10s paused accrued ~28s of debt, so `Date.now()/1000 - timeDebt` put
    // the chart ~18s further into the past than when it was paused: the
    // window snapped right on resume, then ripped forward under
    // PAUSE_CATCHUP_SPEED_FAST (which the >10s debt threshold selects).
    const bad = runQuiescentAgainstFixedOrigin(10, 60);
    expect(bad).toBeGreaterThan(27);
    expect(bad).toBeLessThan(30);
    expect(bad / runQuiescent(10, 60)).toBeGreaterThan(2.5);
    // ...and got worse, not better, on high-refresh hardware.
    expect(runQuiescentAgainstFixedOrigin(10, 120)).toBeGreaterThan(bad * 1.9);
  });

  it('credits the quiescence ramp-up too (frames before the threshold)', () => {
    // Frames below QUIESCENT_FRAME_THRESHOLD still record, so engineStep
    // credits them off `dt`; this only asserts the constant is a frame count
    // small enough that the skip path owns the bulk of a long pause.
    const rampSecs = QUIESCENT_FRAME_THRESHOLD / 60;
    expect(rampSecs).toBeLessThan(2);
  });
});

describe('suspendedDebtSec', () => {
  it('credits the full absence to a fully paused chart', () => {
    // 60s backgrounded while paused. Without this the clamped dt contributed
    // 0.05s and the frozen window jumped ~60s left on foreground.
    expect(suspendedDebtSec(60_000, 1)).toBe(60);
  });

  it('credits nothing to an unpaused chart, preserving current behaviour', () => {
    // pauseProgress 0 is exactly the set of charts that SHOULD advance to
    // the new wall-clock on resume.
    expect(suspendedDebtSec(60_000, 0)).toBe(0);
  });

  it('credits proportionally mid pause-transition', () => {
    expect(suspendedDebtSec(60_000, 0.5)).toBe(30);
  });

  it('credits nothing for a zero, negative or backwards interval', () => {
    expect(suspendedDebtSec(0, 1)).toBe(0);
    expect(suspendedDebtSec(-5000, 1)).toBe(0);
  });

  it('never credits more than the elapsed time', () => {
    // pauseProgress is a 0..1 lerp; a value above 1 must not scale debt up.
    expect(suspendedDebtSec(60_000, 1.5)).toBe(60);
  });

  it('leaves a paused chart at the same displayed instant across a suspend', () => {
    // The property that matters: `now = wallClock - timeDebt` must be
    // unchanged by an absence, for a paused chart.
    const wallAtSuspend = 1_700_000_000;
    let timeDebt = 4; // already paused a while
    const displayedBefore = wallAtSuspend - timeDebt;

    const awaySecs = 137;
    timeDebt += suspendedDebtSec(awaySecs * 1000, 1);
    const displayedAfter = wallAtSuspend + awaySecs - timeDebt;

    expect(displayedAfter).toBeCloseTo(displayedBefore, 10);
  });

  it('leaves an unpaused chart advanced by exactly the absence', () => {
    const wallAtSuspend = 1_700_000_000;
    let timeDebt = 0;
    const awaySecs = 137;
    timeDebt += suspendedDebtSec(awaySecs * 1000, 0);
    const displayedAfter = wallAtSuspend + awaySecs - timeDebt;
    expect(displayedAfter - wallAtSuspend).toBe(awaySecs);
  });
});

describe('the two skip paths compose', () => {
  it('a chart paused, left quiescent, backgrounded and resumed holds still', () => {
    // Timeline: paused, 10s on screen going quiescent, 60s backgrounded,
    // then foregrounded. The displayed instant must not move across ANY of
    // it — that is the whole contract of `paused`.
    const wallStart = 1_700_000_000;
    let timeDebt = 0;
    const displayedAtPause = wallStart - timeDebt;

    timeDebt += runQuiescent(10, 60);
    timeDebt += suspendedDebtSec(60_000, 1);

    const wallEnd = wallStart + 10 + 60;
    expect(wallEnd - timeDebt).toBeCloseTo(displayedAtPause, 4);
  });
});
