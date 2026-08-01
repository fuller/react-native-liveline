import {
  createScrollLayerSlot,
  scrollLayerBeginKey,
  scrollLayerPushNum,
  scrollLayerPushRef,
  scrollLayerKeyHits,
  scrollLayerCommitKey,
  scrollLayerBuilt,
  scrollLayerUsable,
  type ScrollLayerSlot,
} from '../scrollLayer';

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

/** Build a slot into the "just rebuilt" state, keyed with `opts`. */
function build(opts: Parameters<typeof writeKey>[1] = {}): {
  slot: ScrollLayerSlot<FakePicture>;
} {
  const slot = createScrollLayerSlot<FakePicture>();
  writeKey(slot, opts);
  scrollLayerBuilt(slot, makePicture());
  return { slot };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('createScrollLayerSlot', () => {
  it('starts empty: no picture, no committed key', () => {
    const slot = createScrollLayerSlot<FakePicture>();
    expect(slot.picture).toBeNull();
    expect(slot.kNumLen).toBe(0);
    expect(slot.kRefLen).toBe(0);
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
    const { slot } = build();
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
      const { slot } = build();
      writeKey(slot, change);
      expect(scrollLayerKeyHits(slot)).toBe(false);
    }
  });

  it('misses when a palette color changes (pictures bake paint)', () => {
    const { slot } = build();
    writeKey(slot, { lineColor: '#ef4444' });
    expect(scrollLayerKeyHits(slot)).toBe(false);
  });

  it('misses when a formatter changes reference, even if behaviourally identical', () => {
    const { slot } = build();
    writeKey(slot, { formatter: FORMAT_B });
    expect(scrollLayerKeyHits(slot)).toBe(false);
  });

  it('hits for every dimension held at its committed value (no false miss)', () => {
    const { slot } = build({
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
    const { slot } = build();
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
    const { slot } = build();
    const pic = slot.picture;
    writeKey(slot, { dataRev: 1 });
    expect(scrollLayerKeyHits(slot)).toBe(false);
    expect(scrollLayerKeyHits(slot)).toBe(false);
    expect(slot.picture).toBe(pic);
    expect(slot.kNum[0]).toBe(0); // committed key untouched
  });

  it('reuses its arrays across frames — no per-frame allocation', () => {
    const { slot } = build();
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
  it('stores the picture and commits the key together', () => {
    const slot = createScrollLayerSlot<FakePicture>();
    const pic = makePicture();
    writeKey(slot, { dataRev: 4 });
    expect(scrollLayerKeyHits(slot)).toBe(false);

    scrollLayerBuilt(slot, pic);

    expect(slot.picture).toBe(pic);
    writeKey(slot, { dataRev: 4 });
    expect(scrollLayerKeyHits(slot)).toBe(true);
  });

  it('a rebuild replaces the picture', () => {
    const { slot } = build();
    const first = slot.picture;
    const pic2 = makePicture();
    writeKey(slot, { dataRev: 1 });
    scrollLayerBuilt(slot, pic2);

    expect(slot.picture).toBe(pic2);
    expect(slot.picture).not.toBe(first);
  });
});

describe('scrollLayerUsable', () => {
  it('is false without a picture, whatever the alpha', () => {
    const slot = createScrollLayerSlot<FakePicture>();
    expect(scrollLayerUsable(slot, 1)).toBe(false);
  });

  it('is false below alpha 1 — drawPicture ignores globalAlpha', () => {
    const { slot } = build();
    expect(scrollLayerUsable(slot, 0)).toBe(false);
    expect(scrollLayerUsable(slot, 0.5)).toBe(false);
    expect(scrollLayerUsable(slot, 0.999)).toBe(false);
  });

  it('is true at exactly 1, and tolerates a lerp overshoot', () => {
    const { slot } = build();
    expect(scrollLayerUsable(slot, 1)).toBe(true);
    expect(scrollLayerUsable(slot, 1.0001)).toBe(true);
  });
});
