import { buildBadgePillPath } from '../badge';
import type { CachePath } from '../pathCache';

interface Verb {
  op: 'M' | 'L' | 'C' | 'A' | 'Z';
  c: number[];
}

class RecordingPath implements CachePath {
  verbs: Verb[] = [];
  moveTo(x: number, y: number) {
    this.verbs.push({ op: 'M', c: [x, y] });
  }
  lineTo(x: number, y: number) {
    this.verbs.push({ op: 'L', c: [x, y] });
  }
  cubicTo(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number
  ) {
    this.verbs.push({ op: 'C', c: [x1, y1, x2, y2, x3, y3] });
  }
  arcToTangent(x1: number, y1: number, x2: number, y2: number, r: number) {
    this.verbs.push({ op: 'A', c: [x1, y1, x2, y2, r] });
  }
  close() {
    this.verbs.push({ op: 'Z', c: [] });
  }
  rewind() {
    this.verbs.length = 0;
  }
  addPath() {}
  offset() {}
}

// The point each verb's on-curve endpoint ends at (last two coords, except
// arcToTangent whose actual arc endpoint isn't (x2,y2) — Skia computes the
// true tangent point internally — so arcToTangent verbs are checked by their
// two tangent-line coordinates instead, matching what roundedRect relies on).
function endpoints(verbs: Verb[]): [number, number][] {
  return verbs
    .filter((v) => v.op !== 'Z')
    .map((v): [number, number] => {
      if (v.op === 'A') return [v.c[2]!, v.c[3]!]; // (x2,y2) tangent target
      const c = v.c;
      return [c[c.length - 2]!, c[c.length - 1]!];
    });
}

describe('buildBadgePillPath', () => {
  const pillW = 60;
  const pillH = 16; // r = 8
  const r = pillH / 2;
  const tailLen = 5;
  const tailSpread = 2.5;

  it('no-tail: traces a stadium (rounded-rect with radius = height/2)', () => {
    const path = new RecordingPath();
    buildBadgePillPath(path, pillW, pillH, tailLen, tailSpread, false);

    expect(path.verbs[0]).toEqual({ op: 'M', c: [r, 0] });
    expect(path.verbs[path.verbs.length - 1]!.op).toBe('Z');
    // 4 corners via arcToTangent, no cubics, closes back near the start
    const ops = path.verbs.map((v) => v.op);
    expect(ops.filter((o) => o === 'A').length).toBe(4);
    expect(ops.filter((o) => o === 'C').length).toBe(0);

    // Landmark points: top edge, right corner tangent targets, bottom edge,
    // left corner tangent targets — matches the original SVG's M/L/A/L/A/Z.
    const pts = endpoints(path.verbs);
    expect(pts).toContainEqual([pillW - r, 0]); // before top-right corner
    expect(pts).toContainEqual([pillW, r]); // top-right corner tangent target
    expect(pts).toContainEqual([pillW, pillH - r]); // before bottom-right corner
    expect(pts).toContainEqual([pillW - r, pillH]); // bottom-right corner tangent target
    expect(pts).toContainEqual([r, pillH]); // before bottom-left corner
    expect(pts).toContainEqual([0, pillH - r]); // bottom-left corner tangent target
    expect(pts).toContainEqual([0, r]); // before top-left corner
    expect(pts).toContainEqual([r, 0]); // top-left corner tangent target — back to start
  });

  it('tail: right side matches the no-tail stadium, offset by tailLen; left side routes through the tail tip instead of two corners', () => {
    const path = new RecordingPath();
    buildBadgePillPath(path, pillW, pillH, tailLen, tailSpread, true);

    const rightX = tailLen + pillW;
    expect(path.verbs[0]).toEqual({ op: 'M', c: [tailLen + r, 0] });

    const ops = path.verbs.map((v) => v.op);
    // Only the two right corners are arcs now — the left side is cubics.
    expect(ops.filter((o) => o === 'A').length).toBe(2);
    expect(ops.filter((o) => o === 'C').length).toBe(2);

    const pts = endpoints(path.verbs);
    expect(pts).toContainEqual([rightX - r, 0]);
    expect(pts).toContainEqual([rightX, r]); // top-right corner tangent target
    expect(pts).toContainEqual([rightX, pillH - r]);
    expect(pts).toContainEqual([rightX - r, pillH]); // bottom-right corner tangent target
    expect(pts).toContainEqual([tailLen + r, pillH]); // before the tail

    // The tail's two cubics: first ends at the tip (0, r), second ends back
    // at the path's start point (tailLen + r, 0) — ported verbatim from the
    // original SVG's two `C` commands.
    const cubics = path.verbs.filter((v) => v.op === 'C');
    expect(cubics[0]!.c.slice(4)).toEqual([0, r]);
    expect(cubics[1]!.c.slice(4)).toEqual([tailLen + r, 0]);
    // Control points match the SVG generator's formulas exactly.
    expect(cubics[0]!.c).toEqual([tailLen + 2, pillH, 3, r + tailSpread, 0, r]);
    expect(cubics[1]!.c).toEqual([
      3,
      r - tailSpread,
      tailLen + 2,
      0,
      tailLen + r,
      0,
    ]);

    expect(path.verbs[path.verbs.length - 1]!.op).toBe('Z');
  });

  it('tail geometry is pillW-independent past the right edge (only the right corners shift with pillW)', () => {
    const a = new RecordingPath();
    const b = new RecordingPath();
    buildBadgePillPath(a, 60, pillH, tailLen, tailSpread, true);
    buildBadgePillPath(b, 90, pillH, tailLen, tailSpread, true);

    const tailCubicsA = a.verbs.filter((v) => v.op === 'C');
    const tailCubicsB = b.verbs.filter((v) => v.op === 'C');
    // The tail shape itself (independent of pillW) is identical.
    expect(tailCubicsA).toEqual(tailCubicsB);
  });
});
