import { mixColorInto } from '../orderbook';
import type { SkColor } from '@shopify/react-native-skia';

// ── Fakes ──────────────────────────────────────────────────────────────────

/** Stand-in for SkColor — a bare Float32Array(4), same pool shape as
 * OrderbookState.colorPool. No Skia binding needed since mixColorInto only
 * writes normalized floats into it. */
function makeColor(): SkColor {
  return new Float32Array(4) as unknown as SkColor;
}

const FROM: [number, number, number] = [34, 197, 94]; // GREEN
const TO: [number, number, number] = [239, 68, 68]; // RED

describe('mixColorInto', () => {
  it('t=0 writes `from` normalized to 0-1, alpha 1', () => {
    const out = mixColorInto(makeColor(), FROM, TO, 0);
    const o = out as unknown as Float32Array;
    expect(o[0]).toBeCloseTo(34 / 255);
    expect(o[1]).toBeCloseTo(197 / 255);
    expect(o[2]).toBeCloseTo(94 / 255);
    expect(o[3]).toBe(1);
  });

  it('t=1 writes `to` normalized to 0-1, alpha 1', () => {
    const out = mixColorInto(makeColor(), FROM, TO, 1);
    const o = out as unknown as Float32Array;
    expect(o[0]).toBeCloseTo(239 / 255);
    expect(o[1]).toBeCloseTo(68 / 255);
    expect(o[2]).toBeCloseTo(68 / 255);
    expect(o[3]).toBe(1);
  });

  it('mid t blends and rounds each channel to an int before normalizing', () => {
    const out = mixColorInto(makeColor(), FROM, TO, 0.5);
    const o = out as unknown as Float32Array;
    // r: 34 + (239-34)*0.5 = 136.5 -> round 137
    expect(o[0]).toBeCloseTo(137 / 255);
    // g: 197 + (68-197)*0.5 = 132.5 -> round 133
    expect(o[1]).toBeCloseTo(133 / 255);
    // b: 94 + (68-94)*0.5 = 81 -> round 81
    expect(o[2]).toBeCloseTo(81 / 255);
    expect(o[3]).toBe(1);
  });

  it('returns the same `out` reference it was given (in-place write, no alloc)', () => {
    const out = makeColor();
    const result = mixColorInto(out, FROM, TO, 0.5);
    expect(result).toBe(out);
  });
});
