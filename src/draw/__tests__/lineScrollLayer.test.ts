import { canCompositeLineScroll, writeLineScrollKey } from '../lineScrollLayer';
import {
  createScrollLayerSlot,
  scrollLayerBuilt,
  scrollLayerKeyHits,
  type ScrollLayerSlot,
} from '../scrollLayer';
import { createLineCacheSlot, type LineCacheSlot } from '../lineCache';
import type { LivelinePalette } from '../../types';

// Stand-in for SkPicture — `ScrollLayerSlot` takes Picture as a structural
// type parameter so no native binding is needed (same trick as
// scrollLayer.test.ts).
interface FakePicture {
  id: number;
}
const PICTURE: FakePicture = { id: 1 };

function makePalette(overrides: Partial<LivelinePalette> = {}) {
  return {
    line: '#3b82f6',
    lineWidth: 2,
    fillTop: 'rgba(59,130,246,0.12)',
    fillBottom: 'rgba(59,130,246,0)',
    gridLine: '#222',
    gridLabel: '#888',
    dashLine: '#444',
    ...overrides,
  } as LivelinePalette;
}

/** A line cache slot that looks like it has a built prefix. `buildRev` is
 * the only field `writeLineScrollKey` reads off it. */
function makeLineSlot(): LineCacheSlot {
  const slot = createLineCacheSlot();
  slot.prefix = {} as LineCacheSlot['prefix'];
  slot.buildRev = 7;
  return slot;
}

/** Writes the key and commits it against `PICTURE`, i.e. simulates a record. */
function record(
  slot: ScrollLayerSlot<FakePicture>,
  lineSlot: LineCacheSlot,
  padLeft: number,
  palette: LivelinePalette
) {
  writeLineScrollKey(slot, lineSlot, padLeft, palette);
  scrollLayerBuilt(slot, PICTURE);
}

describe('canCompositeLineScroll', () => {
  it('is true only when fully revealed, not scrubbing and not shaking', () => {
    expect(canCompositeLineScroll(1, 0, 0)).toBe(true);
  });

  it('is false during the reveal morph', () => {
    expect(canCompositeLineScroll(0, 0, 0)).toBe(false);
    expect(canCompositeLineScroll(0.999, 0, 0)).toBe(false);
  });

  it('tolerates a reveal lerp that overshoots its target', () => {
    // Mirrors scrollLayerUsable's `>= 1` rather than `=== 1`.
    expect(canCompositeLineScroll(1.0001, 0, 0)).toBe(true);
  });

  it('is false for any non-zero scrub, and true again once scrub snaps to 0', () => {
    expect(canCompositeLineScroll(1, 0.4, 0)).toBe(false);
    // updateHoverState snaps scrubAmount to exactly 0 below 0.01, which is
    // what makes the gate re-enable rather than asymptote.
    expect(canCompositeLineScroll(1, 0, 0)).toBe(true);
  });

  it('is false while the degen shake is translating the frame', () => {
    // A transform condition, not an opacity one — which is why this predicate
    // is a boolean rather than an alpha.
    expect(canCompositeLineScroll(1, 0, 0.2)).toBe(false);
    expect(canCompositeLineScroll(1, 0, 12)).toBe(false);
  });
});

describe('writeLineScrollKey', () => {
  it('hits when nothing has changed since the record', () => {
    const slot = createScrollLayerSlot<FakePicture>();
    const lineSlot = makeLineSlot();
    const palette = makePalette();
    record(slot, lineSlot, 10, palette);

    writeLineScrollKey(slot, lineSlot, 10, palette);
    expect(scrollLayerKeyHits(slot)).toBe(true);
  });

  it('misses before anything has been recorded', () => {
    const slot = createScrollLayerSlot<FakePicture>();
    writeLineScrollKey(slot, makeLineSlot(), 10, makePalette());
    expect(scrollLayerKeyHits(slot)).toBe(false);
  });

  it('misses when the prefix has been rebuilt (buildRev moved)', () => {
    // The one dimension that matters: the picture is a rendering of
    // `prefix`, so it is stale exactly when `prefix` was rebuilt. One counter
    // stands in for all 13 of `lineCacheHits`' dimensions, and cannot go
    // stale when a 14th is added there.
    const slot = createScrollLayerSlot<FakePicture>();
    const lineSlot = makeLineSlot();
    const palette = makePalette();
    record(slot, lineSlot, 10, palette);

    lineSlot.buildRev++;
    writeLineScrollKey(slot, lineSlot, 10, palette);
    expect(scrollLayerKeyHits(slot)).toBe(false);
  });

  it('hits across changes to the line cache key that did NOT rebuild the prefix', () => {
    // The scroll key deliberately does not mirror `lineCacheHits`. A cache
    // key field moving without a rebuild is not a state `updateLinePaths`
    // produces (a changed key IS a miss IS a rebuild), so tracking it here
    // would only ever throw away a valid picture.
    const slot = createScrollLayerSlot<FakePicture>();
    const lineSlot = makeLineSlot();
    const palette = makePalette();
    record(slot, lineSlot, 10, palette);

    lineSlot.kDataRev = 99;
    lineSlot.kLastV = 0;
    writeLineScrollKey(slot, lineSlot, 10, palette);
    expect(scrollLayerKeyHits(slot)).toBe(true);
  });

  it('misses on a pad.left change — the clip is baked into the picture', () => {
    // pad.left is deliberately NOT part of the line cache's own key (it is
    // absorbed by dx), so this dimension can only come from here.
    const slot = createScrollLayerSlot<FakePicture>();
    const lineSlot = makeLineSlot();
    const palette = makePalette();
    record(slot, lineSlot, 10, palette);

    writeLineScrollKey(slot, lineSlot, 24, palette);
    expect(scrollLayerKeyHits(slot)).toBe(false);
  });

  it('misses on a stroke color change — a picture bakes color', () => {
    const slot = createScrollLayerSlot<FakePicture>();
    const lineSlot = makeLineSlot();
    record(slot, lineSlot, 10, makePalette());

    writeLineScrollKey(slot, lineSlot, 10, makePalette({ line: '#ef4444' }));
    expect(scrollLayerKeyHits(slot)).toBe(false);
  });

  it('misses on a stroke width change', () => {
    const slot = createScrollLayerSlot<FakePicture>();
    const lineSlot = makeLineSlot();
    record(slot, lineSlot, 10, makePalette());

    writeLineScrollKey(slot, lineSlot, 10, makePalette({ lineWidth: 3 }));
    expect(scrollLayerKeyHits(slot)).toBe(false);
  });

  it('ignores palette dimensions the prefix stroke does not bake', () => {
    // Only `line`/`lineWidth` reach the recording; a grid or fill color
    // change must not throw the picture away.
    const slot = createScrollLayerSlot<FakePicture>();
    const lineSlot = makeLineSlot();
    record(slot, lineSlot, 10, makePalette());

    writeLineScrollKey(
      slot,
      lineSlot,
      10,
      makePalette({ gridLine: '#fff', fillTop: 'rgba(0,0,0,0.5)' })
    );
    expect(scrollLayerKeyHits(slot)).toBe(true);
  });

  it('pushes the same number of dimensions every call', () => {
    // Push order/arity is the field identity for a ScrollLayerSlot key —
    // a conditional push would silently misalign the comparison.
    const slot = createScrollLayerSlot<FakePicture>();
    writeLineScrollKey(slot, makeLineSlot(), 10, makePalette());
    const numLen = slot.nNumLen;
    const refLen = slot.nRefLen;

    const other = makeLineSlot();
    other.buildRev = 99;
    writeLineScrollKey(slot, other, 0, makePalette({ line: '#000' }));
    expect(slot.nNumLen).toBe(numLen);
    expect(slot.nRefLen).toBe(refLen);
  });
});
