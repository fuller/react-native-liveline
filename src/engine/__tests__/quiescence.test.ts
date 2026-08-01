import { isQuiescentCandidate } from '../quiescence';
import type { EngineState } from '../state';
import type { EngineConfigStep } from '../types';

// ── Fixtures ───────────────────────────────────────────────────────────────
//
// `isQuiescentCandidate` is a pure predicate over a handful of fields, so the
// fixtures are deliberately narrow casts rather than full engine objects —
// building a real `EngineState` would drag in the Skia binding and defeat the
// point of this module being testable at all.

type QuiescentConfigFields = Pick<
  EngineConfigStep,
  | 'paused'
  | 'loading'
  | 'degenOptions'
  | 'isMultiSeries'
  | 'multiSeries'
  | 'showPulse'
  | 'showMomentum'
  | 'orderbookData'
>;

type QuiescentStateFields = Pick<
  EngineState,
  'pauseProgress' | 'scrubAmount' | 'loadingAlpha' | 'chartReveal'
>;

/** The all-static baseline: every condition satisfied. */
const cfg = (over: Partial<QuiescentConfigFields> = {}): EngineConfigStep =>
  ({
    paused: true,
    loading: false,
    ...over,
  }) as EngineConfigStep;

const state = (over: Partial<QuiescentStateFields> = {}): EngineState =>
  ({
    pauseProgress: 1,
    scrubAmount: 0,
    loadingAlpha: 0,
    chartReveal: 1,
    ...over,
  }) as EngineState;

describe('isQuiescentCandidate — the all-static baseline', () => {
  it('returns true when every animatable feature is at rest', () => {
    expect(isQuiescentCandidate(cfg(), state(), null)).toBe(true);
  });
});

describe('isQuiescentCandidate — pause is mandatory', () => {
  // The most important single assertion in this file: a *live* chart must
  // never quiesce, however settled every other field looks. Per the module's
  // own docblock this is deliberate — every other condition below describes a
  // transient animation, but `paused` describes whether new data can arrive.

  it('returns false when paused is undefined (a live chart)', () => {
    expect(
      isQuiescentCandidate(cfg({ paused: undefined }), state(), null)
    ).toBe(false);
  });

  it('returns false when paused is explicitly false', () => {
    expect(isQuiescentCandidate(cfg({ paused: false }), state(), null)).toBe(
      false
    );
  });

  it('requires the pause settle animation to have finished, not merely started', () => {
    // pauseProgress drives badge alpha, the pulse ring gate and the candle
    // glow cut-off; anything short of exactly 1 still has motion in it.
    expect(
      isQuiescentCandidate(cfg(), state({ pauseProgress: 0.999 }), null)
    ).toBe(false);
    expect(isQuiescentCandidate(cfg(), state({ pauseProgress: 1 }), null)).toBe(
      true
    );
  });
});

describe('isQuiescentCandidate — each break condition independently', () => {
  it('hover: an active hover at pixel x=0 breaks quiescence', () => {
    // x=0 is a legitimate hover position at the very left of the canvas. A
    // falsy check (`!hoverPixelX`) instead of `=== null` would wrongly report
    // this frame as static and freeze the crosshair mid-drag.
    expect(isQuiescentCandidate(cfg(), state(), 0)).toBe(false);
  });

  it('hover: any non-null hover pixel breaks quiescence', () => {
    expect(isQuiescentCandidate(cfg(), state(), 120)).toBe(false);
  });

  it('scrub: a partially faded scrub overlay breaks quiescence', () => {
    expect(
      isQuiescentCandidate(cfg(), state({ scrubAmount: 0.001 }), null)
    ).toBe(false);
  });

  it('loading: cfg.loading breaks quiescence even once its alpha settled', () => {
    expect(
      isQuiescentCandidate(
        cfg({ loading: true }),
        state({ loadingAlpha: 1 }),
        null
      )
    ).toBe(false);
  });

  it('loading: a mid-crossfade alpha breaks quiescence even once cfg.loading cleared', () => {
    // The two loading conditions are not redundant: cfg.loading goes false on
    // the commit that supplies data, but loadingAlpha keeps fading for ~1s
    // afterwards. Dropping either check alone leaks a visible crossfade.
    expect(
      isQuiescentCandidate(
        cfg({ loading: false }),
        state({ loadingAlpha: 0.5 }),
        null
      )
    ).toBe(false);
  });

  it('reveal: an incomplete chart reveal morph breaks quiescence', () => {
    expect(
      isQuiescentCandidate(cfg(), state({ chartReveal: 0.999 }), null)
    ).toBe(false);
  });

  it('degen: an empty-but-present degenOptions object breaks quiescence', () => {
    // degenOptions gates particles and chart shake, both driven by
    // Math.random() every frame. Presence is what matters, not contents.
    expect(isQuiescentCandidate(cfg({ degenOptions: {} }), state(), null)).toBe(
      false
    );
  });
});

describe('isQuiescentCandidate — multi-series needs all three sub-conditions', () => {
  const series = [{ id: 'a', value: 1, palette: {} as never }];

  it('breaks quiescence only when the flag, the array and a non-empty array all hold', () => {
    expect(
      isQuiescentCandidate(
        cfg({ isMultiSeries: true, multiSeries: series }),
        state(),
        null
      )
    ).toBe(false);
  });

  it('stays quiescent when the flag is off even though a series array is present', () => {
    // Single-series charts carry a stale multiSeries array across a mode
    // switch; keying off the array alone would permanently disable quiescence
    // for them.
    expect(
      isQuiescentCandidate(
        cfg({ isMultiSeries: false, multiSeries: series }),
        state(),
        null
      )
    ).toBe(true);
  });

  it('stays quiescent when the flag is on but the series array is empty', () => {
    expect(
      isQuiescentCandidate(
        cfg({ isMultiSeries: true, multiSeries: [] }),
        state(),
        null
      )
    ).toBe(true);
  });

  it('stays quiescent when the flag is on but the series array is absent', () => {
    expect(
      isQuiescentCandidate(
        cfg({ isMultiSeries: true, multiSeries: undefined }),
        state(),
        null
      )
    ).toBe(true);
  });
});

describe('isQuiescentCandidate — deliberate non-conditions', () => {
  // These three are documented in quiescence.ts as intentionally absent.
  // Adding any of them as a condition would silently disable quiescence for
  // the majority of charts (pulse defaults to true), which is exactly the
  // "perf cliff with no visual symptom" this module exists to avoid.

  it('showPulse does not break quiescence (the ring is already gated off at full pause)', () => {
    expect(isQuiescentCandidate(cfg({ showPulse: true }), state(), null)).toBe(
      true
    );
  });

  it('showMomentum does not break quiescence (arrow alpha is forced to 0 at full pause)', () => {
    expect(
      isQuiescentCandidate(cfg({ showMomentum: true }), state(), null)
    ).toBe(true);
  });

  it('orderbookData does not break quiescence (its labels now run on pausedDt)', () => {
    expect(
      isQuiescentCandidate(
        cfg({ orderbookData: { bids: [], asks: [] } as never }),
        state(),
        null
      )
    ).toBe(true);
  });
});

describe('isQuiescentCandidate — purity', () => {
  it('mutates neither the config nor the state', () => {
    const c = cfg({ isMultiSeries: true, multiSeries: [] });
    const s = state();
    const cBefore = JSON.stringify(c);
    const sBefore = JSON.stringify(s);
    isQuiescentCandidate(c, s, 42);
    expect(JSON.stringify(c)).toBe(cBefore);
    expect(JSON.stringify(s)).toBe(sBefore);
  });
});
