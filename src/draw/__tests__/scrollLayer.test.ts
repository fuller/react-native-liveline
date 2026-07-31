import {
  createScrollLayerSlot,
  setScrollLayerClip,
  scrollLayerBeginKey,
  scrollLayerPushNum,
  scrollLayerPushRef,
  scrollLayerKeyHits,
  scrollLayerCommitKey,
  scrollLayerBuilt,
  scrollLayerDx,
  scrollLayerUsable,
  type ScrollLayerSlot,
} from '../scrollLayer';
import type { ChartLayout, Padding } from '../../types';

// ── Fakes ──────────────────────────────────────────────────────────────────

/** Stand-in for SkPicture. `ScrollLayerSlot` takes Picture as a structural
 * type parameter precisely so this can be a bare object — no native binding,
 * same trick lineCache.test.ts uses for SkPath. */
interface FakePicture {
  id: number;
}
let pictureId = 0;
function makePicture(): FakePicture {
  pictureId++;
  return { id: pictureId };
}

const PAD: Required<Padding> = { top: 10, right: 20, bottom: 20, left: 10 };

/** Layout matching engineStep's construction (step.ts line-mode branch). */
function makeLayout(
  now: number,
  windowSecs = 60,
  w = 400,
  h = 200
): ChartLayout {
  const chartW = w - PAD.left - PAD.right;
  const chartH = h - PAD.top - PAD.bottom;
  const buffer = 0.05;
  const rightEdge = now + windowSecs * buffer;
  const leftEdge = rightEdge - windowSecs;
  const minVal = 90;
  const maxVal = 110;
  const valRange = maxVal - minVal;
  return {
    w,
    h,
    pad: PAD,
    chartW,
    chartH,
    leftEdge,
    rightEdge,
    minVal,
    maxVal,
    valRange,
    toX: (t: number) =>
      PAD.left + ((t - leftEdge) / (rightEdge - leftEdge)) * chartW,
    toY: (v: number) => PAD.top + (1 - (v - minVal) / valRange) * chartH,
  };
}

/**
 * A representative consumer's key writer. Real consumers keep their pushes in
 * one helper exactly like this so there is a single push order to read; the
 * order must be identical every frame, so nothing here is conditional.
 */
function writeKey(
  slot: ScrollLayerSlot<FakePicture>,
  opts: {
    dataRev?: number;
    len?: number;
    window?: number;
    lineColor?: string;
    formatter?: (v: number) => string;
  } = {}
): void {
  scrollLayerBeginKey(slot);
  scrollLayerPushNum(slot, opts.dataRev ?? 0);
  scrollLayerPushNum(slot, opts.len ?? 20);
  scrollLayerPushNum(slot, opts.window ?? 60);
  scrollLayerPushRef(slot, opts.lineColor ?? '#3b82f6');
  scrollLayerPushRef(slot, opts.formatter ?? FORMAT_A);
}

const FORMAT_A = (v: number) => `$${v}`;
const FORMAT_B = (v: number) => `$${v}`;

/** Build a slot into the "just rebuilt at `now`" state, keyed with `opts`. */
function build(
  now: number,
  tRef: number,
  opts: Parameters<typeof writeKey>[1] = {}
): { slot: ScrollLayerSlot<FakePicture>; layout: ChartLayout } {
  const slot = createScrollLayerSlot<FakePicture>();
  const layout = makeLayout(now);
  writeKey(slot, opts);
  scrollLayerBuilt(slot, makePicture(), tRef, layout.toX(tRef));
  return { slot, layout };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('createScrollLayerSlot', () => {
  it('starts empty: no picture, no committed key, zero clip', () => {
    const slot = createScrollLayerSlot<FakePicture>();
    expect(slot.picture).toBeNull();
    expect(slot.tRef).toBe(0);
    expect(slot.xRefAtBuild).toBe(0);
    expect(slot.kNumLen).toBe(0);
    expect(slot.kRefLen).toBe(0);
    expect(slot.clipX).toBe(0);
    expect(slot.clipY).toBe(0);
    expect(slot.clipW).toBe(0);
    expect(slot.clipH).toBe(0);
  });
});

describe('scrollLayerKeyHits', () => {
  it('a fresh slot never hits, even with a matching key pushed', () => {
    const slot = createScrollLayerSlot<FakePicture>();
    writeKey(slot);
    scrollLayerCommitKey(slot);
    writeKey(slot);
    // Key matches, but there is no picture to composite — validity is
    // `picture !== null`, same as LineCacheSlot.prefix / GridLayerSlot.picture.
    expect(scrollLayerKeyHits(slot)).toBe(false);
  });

  it('hits right after a build with the same inputs', () => {
    const { slot } = build(1000, 970);
    writeKey(slot);
    expect(scrollLayerKeyHits(slot)).toBe(true);
  });

  it('misses on any single numeric dimension changing', () => {
    const cases: Parameters<typeof writeKey>[1][] = [
      { dataRev: 1 },
      { len: 21 },
      { window: 120 },
    ];
    for (const change of cases) {
      const { slot } = build(1000, 970);
      writeKey(slot, change);
      expect(scrollLayerKeyHits(slot)).toBe(false);
    }
  });

  it('misses when a palette color changes (pictures bake paint)', () => {
    const { slot } = build(1000, 970);
    writeKey(slot, { lineColor: '#ef4444' });
    expect(scrollLayerKeyHits(slot)).toBe(false);
  });

  it('misses when a formatter changes reference, even if behaviourally identical', () => {
    const { slot } = build(1000, 970);
    writeKey(slot, { formatter: FORMAT_B });
    expect(scrollLayerKeyHits(slot)).toBe(false);
  });

  it('hits for every dimension held at its committed value (no false miss)', () => {
    const { slot } = build(1000, 970, {
      dataRev: 7,
      len: 33,
      window: 120,
      lineColor: '#ef4444',
      formatter: FORMAT_B,
    });
    writeKey(slot, {
      dataRev: 7,
      len: 33,
      window: 120,
      lineColor: '#ef4444',
      formatter: FORMAT_B,
    });
    expect(scrollLayerKeyHits(slot)).toBe(true);
  });

  it('misses when the key arity changes rather than matching a prefix', () => {
    const { slot } = build(1000, 970);
    // Same first three numbers, but a consumer that grew its key.
    scrollLayerBeginKey(slot);
    scrollLayerPushNum(slot, 0);
    scrollLayerPushNum(slot, 20);
    scrollLayerPushNum(slot, 60);
    scrollLayerPushNum(slot, 999); // new dimension
    scrollLayerPushRef(slot, '#3b82f6');
    scrollLayerPushRef(slot, FORMAT_A);
    expect(scrollLayerKeyHits(slot)).toBe(false);

    // ...and when it shrinks, including on the ref array.
    scrollLayerBeginKey(slot);
    scrollLayerPushNum(slot, 0);
    scrollLayerPushNum(slot, 20);
    scrollLayerPushNum(slot, 60);
    scrollLayerPushRef(slot, '#3b82f6');
    expect(scrollLayerKeyHits(slot)).toBe(false);
  });

  it('is read-only: does not commit, so a repeated miss stays a miss', () => {
    const { slot } = build(1000, 970);
    const pic = slot.picture;
    writeKey(slot, { dataRev: 1 });
    expect(scrollLayerKeyHits(slot)).toBe(false);
    expect(scrollLayerKeyHits(slot)).toBe(false);
    expect(slot.picture).toBe(pic);
    expect(slot.kNum[0]).toBe(0); // committed key untouched
  });

  it('reuses its arrays across frames — no per-frame allocation', () => {
    const { slot } = build(1000, 970);
    const nNum = slot.nNum;
    const nRef = slot.nRef;
    const kNum = slot.kNum;
    for (let i = 0; i < 100; i++) {
      writeKey(slot, { dataRev: i });
      scrollLayerKeyHits(slot);
      scrollLayerCommitKey(slot);
    }
    expect(slot.nNum).toBe(nNum);
    expect(slot.nRef).toBe(nRef);
    expect(slot.kNum).toBe(kNum);
    // Arrays grew to the key arity once and stopped there.
    expect(slot.nNum.length).toBe(3);
    expect(slot.nRef.length).toBe(2);
  });
});

describe('scrollLayerBuilt', () => {
  it('stores the picture, the reference pair, and commits the key together', () => {
    const slot = createScrollLayerSlot<FakePicture>();
    const layout = makeLayout(1000);
    const pic = makePicture();
    writeKey(slot, { dataRev: 4 });
    expect(scrollLayerKeyHits(slot)).toBe(false);

    scrollLayerBuilt(slot, pic, 970, layout.toX(970));

    expect(slot.picture).toBe(pic);
    expect(slot.tRef).toBe(970);
    expect(slot.xRefAtBuild).toBe(layout.toX(970));
    writeKey(slot, { dataRev: 4 });
    expect(scrollLayerKeyHits(slot)).toBe(true);
  });

  it('a rebuild replaces the picture and re-anchors the reference', () => {
    const { slot } = build(1000, 970);
    const first = slot.picture;
    const later = makeLayout(1030);
    const pic2 = makePicture();
    writeKey(slot, { dataRev: 1 });
    scrollLayerBuilt(slot, pic2, 1000, later.toX(1000));

    expect(slot.picture).not.toBe(first);
    expect(slot.tRef).toBe(1000);
    expect(scrollLayerDx(slot, later)).toBe(0);
  });
});

describe('scrollLayerDx', () => {
  it('is exactly zero on the frame of the build', () => {
    const { slot, layout } = build(1000, 970);
    // Not "close to" zero — tRef/xRefAtBuild come from the same toX, so the
    // subtraction is exactly 0 and consumers can skip the translate entirely.
    expect(scrollLayerDx(slot, layout)).toBe(0);
  });

  it('is exactly zero for every tRef, not just a lucky one', () => {
    for (const tRef of [0, 970, 1000, -500, 1234.5678]) {
      const { slot, layout } = build(1000, tRef);
      expect(scrollLayerDx(slot, layout)).toBe(0);
    }
  });

  it('moves content left as `now` advances', () => {
    const { slot } = build(1000, 970);
    const dx = scrollLayerDx(slot, makeLayout(1005));
    expect(dx).toBeLessThan(0);
    // 5s of a 60s window across chartW = 370px.
    expect(dx).toBeCloseTo((-5 / 60) * 370, 9);
  });

  it('equals the translation a fresh build at the later time would need', () => {
    // Ground truth: where tRef sits at the later time, minus where it sat at
    // build time. The cached picture must land exactly there.
    const tRef = 970;
    const buildLayout = makeLayout(1000);
    const laterLayout = makeLayout(1017.3);
    const { slot } = build(1000, tRef);
    expect(scrollLayerDx(slot, laterLayout)).toBeCloseTo(
      laterLayout.toX(tRef) - buildLayout.toX(tRef),
      9
    );
  });

  it('does not drift over many frames — recomputed, never accumulated', () => {
    const tRef = 970;
    const { slot } = build(1000, tRef);
    const PX_PER_SEC = 370 / 60; // chartW / windowSecs

    // 6,000 frames of *jittered* frame times — the realistic case, since a
    // real frame callback never gets a clean 1/60s. `naive` models the
    // tempting `dx += nominalStep` implementation this module forbids.
    let now = 1000;
    let naive = 0;
    let rng = 12345;
    for (let i = 0; i < 6000; i++) {
      rng = (rng * 1103515245 + 12345) % 2147483648;
      // Real frames overrun the nominal interval more often than they beat
      // it, so the jitter is deliberately biased rather than symmetric.
      const step = (1 / 60) * (1 + (rng / 2147483648) * 0.5);
      now += step;
      naive -= (1 / 60) * PX_PER_SEC; // nominal, not actual

      // The recomputed value is a pure function of this frame's layout, with
      // no dependence on how many frames preceded it or how long they were.
      if (i % 250 === 0) {
        const layout = makeLayout(now);
        expect(scrollLayerDx(slot, layout)).toBe(
          layout.toX(tRef) - slot.xRefAtBuild
        );
      }
    }

    const finalLayout = makeLayout(now);
    const dx = scrollLayerDx(slot, finalLayout);
    // Exact against a first-principles calculation after 6,000 frames.
    expect(dx).toBeCloseTo(-(now - 1000) * PX_PER_SEC, 9);
    // The accumulating version is off by whole pixels — a visibly misaligned
    // axis. This is the failure mode the doc comment on scrollLayerDx warns
    // about, and it is why dx takes no per-frame delta parameter.
    expect(Math.abs(naive - dx)).toBeGreaterThan(1);
  });

  it('is unaffected by the order frames are evaluated in (pure function of layout)', () => {
    const { slot } = build(1000, 970);
    const forward = [1001, 1002, 1003].map((t) =>
      scrollLayerDx(slot, makeLayout(t))
    );
    const backward = [1003, 1002, 1001]
      .map((t) => scrollLayerDx(slot, makeLayout(t)))
      .reverse();
    expect(forward).toEqual(backward);
  });

  it('absorbs a pad.left shift, which is why pad.left need not be keyed', () => {
    // dx is a difference of two toX values; a constant x-offset cancels.
    const { slot, layout } = build(1000, 970);
    const later = makeLayout(1005);
    const shifted: ChartLayout = {
      ...later,
      toX: (t: number) => later.toX(t) + 25,
    };
    const unshifted = scrollLayerDx(slot, later);
    expect(scrollLayerDx(slot, shifted)).toBeCloseTo(unshifted + 25, 9);
    expect(scrollLayerDx(slot, layout)).toBe(0);
  });
});

describe('clip regions', () => {
  it('each slot carries its own region — a plot slot and an axis slot differ', () => {
    const layout = makeLayout(1000);
    const plot = createScrollLayerSlot<FakePicture>();
    const axis = createScrollLayerSlot<FakePicture>();

    // Plot area: the chart body.
    setScrollLayerClip(
      plot,
      layout.pad.left,
      layout.pad.top,
      layout.chartW,
      layout.chartH
    );
    // Axis strip: `h - pad.bottom` downward. A shared plot-area clip would
    // erase this entirely, which is the whole reason clips are per-slot.
    const axisTop = layout.h - layout.pad.bottom;
    setScrollLayerClip(
      axis,
      layout.pad.left,
      axisTop,
      layout.chartW,
      layout.pad.bottom
    );

    expect(plot.clipY).toBe(10);
    expect(plot.clipH).toBe(170);
    expect(axis.clipY).toBe(180);
    expect(axis.clipH).toBe(20);
    // Disjoint vertically: the plot clip ends exactly where the axis begins.
    expect(plot.clipY + plot.clipH).toBe(axis.clipY);
  });

  it('is not part of the invalidation key — re-clipping keeps the picture', () => {
    const { slot } = build(1000, 970);
    const pic = slot.picture;
    setScrollLayerClip(slot, 10, 10, 370, 170);
    writeKey(slot);
    expect(scrollLayerKeyHits(slot)).toBe(true);
    expect(slot.picture).toBe(pic);
    setScrollLayerClip(slot, 0, 0, 400, 200);
    writeKey(slot);
    expect(scrollLayerKeyHits(slot)).toBe(true);
  });

  it('bounds a translated picture: content scrolled past the left edge is clipped away', () => {
    // The clip is the guard against a picture's cull rect being translated
    // somewhere it was never meant to cover.
    const layout = makeLayout(1000);
    const slot = createScrollLayerSlot<FakePicture>();
    setScrollLayerClip(
      slot,
      layout.pad.left,
      layout.pad.top,
      layout.chartW,
      layout.chartH
    );
    writeKey(slot);
    scrollLayerBuilt(slot, makePicture(), 970, layout.toX(970));

    // Content recorded at tRef, composited 30s later.
    const later = makeLayout(1030);
    const dx = scrollLayerDx(slot, later);
    const contentX = slot.xRefAtBuild + dx;
    expect(contentX).toBeLessThan(slot.clipX); // outside the clip on the left
    expect(contentX).toBeCloseTo(later.toX(970), 9); // and at the right place
  });
});

describe('scrollLayerUsable', () => {
  it('is false without a picture, whatever the alpha', () => {
    const slot = createScrollLayerSlot<FakePicture>();
    expect(scrollLayerUsable(slot, 1)).toBe(false);
  });

  it('is false below alpha 1 — drawPicture ignores globalAlpha', () => {
    const { slot } = build(1000, 970);
    expect(scrollLayerUsable(slot, 0)).toBe(false);
    expect(scrollLayerUsable(slot, 0.5)).toBe(false);
    expect(scrollLayerUsable(slot, 0.999)).toBe(false);
  });

  it('is true at exactly 1, and tolerates a lerp overshoot', () => {
    const { slot } = build(1000, 970);
    expect(scrollLayerUsable(slot, 1)).toBe(true);
    expect(scrollLayerUsable(slot, 1.0001)).toBe(true);
  });
});
