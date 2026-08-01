import { lineScrollLayerAlpha, writeLineScrollKey } from '../lineScrollLayer';
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

/** A line cache slot with a plausible committed key (the fields
 * `writeLineScrollKey` reads). `prefix` is set so the slot looks built. */
function makeLineSlot(): LineCacheSlot {
  const slot = createLineCacheSlot();
  slot.prefix = {} as LineCacheSlot['prefix'];
  slot.tRef = 1000;
  slot.xRefAtBuild = 10;
  slot.kDataRev = 7;
  slot.kDataSource = 0;
  slot.kLen = 120;
  slot.kFirstT = 1000;
  slot.kLastT = 1060;
  slot.kLastV = 101.5;
  slot.kMin = 90;
  slot.kMax = 110;
  slot.kWindow = 60;
  slot.kH = 200;
  slot.kPadTop = 10;
  slot.kPadBottom = 20;
  slot.kChartW = 370;
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
  scrollLayerBuilt(slot, PICTURE, lineSlot.tRef, lineSlot.xRefAtBuild);
}

describe('lineScrollLayerAlpha', () => {
  it('is 1 only when fully revealed, not scrubbing and not shaking', () => {
    expect(lineScrollLayerAlpha(1, 0, 0)).toBe(1);
  });

  it('is 0 during the reveal morph', () => {
    expect(lineScrollLayerAlpha(0, 0, 0)).toBe(0);
    expect(lineScrollLayerAlpha(0.999, 0, 0)).toBe(0);
  });

  it('tolerates a reveal lerp that overshoots its target', () => {
    // Mirrors scrollLayerUsable's `>= 1` rather than `=== 1`.
    expect(lineScrollLayerAlpha(1.0001, 0, 0)).toBe(1);
  });

  it('is 0 for any non-zero scrub, and 1 again once scrub snaps to 0', () => {
    expect(lineScrollLayerAlpha(1, 0.4, 0)).toBe(0);
    // updateHoverState snaps scrubAmount to exactly 0 below 0.01, which is
    // what makes the gate re-enable rather than asymptote.
    expect(lineScrollLayerAlpha(1, 0, 0)).toBe(1);
  });

  it('is 0 while the degen shake is translating the frame', () => {
    expect(lineScrollLayerAlpha(1, 0, 0.2)).toBe(0);
    expect(lineScrollLayerAlpha(1, 0, 12)).toBe(0);
  });

  it('never returns a partial alpha — drawPicture cannot fade', () => {
    const values = [
      lineScrollLayerAlpha(0.5, 0, 0),
      lineScrollLayerAlpha(1, 0.5, 0),
      lineScrollLayerAlpha(1, 0, 1),
      lineScrollLayerAlpha(1, 0, 0),
    ];
    for (const v of values) expect(v === 0 || v === 1).toBe(true);
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

  it.each([
    ['kDataRev', (s: LineCacheSlot) => (s.kDataRev = 8)],
    ['kDataSource', (s: LineCacheSlot) => (s.kDataSource = 1)],
    ['kLen', (s: LineCacheSlot) => (s.kLen = 121)],
    ['kFirstT', (s: LineCacheSlot) => (s.kFirstT = 1001)],
    ['kLastT', (s: LineCacheSlot) => (s.kLastT = 1061)],
    ['kLastV', (s: LineCacheSlot) => (s.kLastV = 101.6)],
    ['kMin', (s: LineCacheSlot) => (s.kMin = 89)],
    ['kMax', (s: LineCacheSlot) => (s.kMax = 111)],
    ['kWindow', (s: LineCacheSlot) => (s.kWindow = 300)],
    ['kH', (s: LineCacheSlot) => (s.kH = 201)],
    ['kPadTop', (s: LineCacheSlot) => (s.kPadTop = 11)],
    ['kPadBottom', (s: LineCacheSlot) => (s.kPadBottom = 21)],
    ['kChartW', (s: LineCacheSlot) => (s.kChartW = 371)],
  ])('misses when the line cache key changes: %s', (_name, mutate) => {
    const slot = createScrollLayerSlot<FakePicture>();
    const lineSlot = makeLineSlot();
    const palette = makePalette();
    record(slot, lineSlot, 10, palette);

    mutate(lineSlot);
    writeLineScrollKey(slot, lineSlot, 10, palette);
    expect(scrollLayerKeyHits(slot)).toBe(false);
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
    other.kDataSource = 2;
    other.kLastV = 0;
    writeLineScrollKey(slot, other, 0, makePalette({ line: '#000' }));
    expect(slot.nNumLen).toBe(numLen);
    expect(slot.nRefLen).toBe(refLen);
  });
});
