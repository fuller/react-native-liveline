import { parseColorRgb, resolveTheme, resolveSeriesPalettes } from '../theme';

/**
 * `theme.ts` had no test coverage before this file, despite being pure and
 * despite `parseColorRgb` silently producing NaN channels on 4-digit hex
 * shorthand (`#rgba`) before that was fixed — a bad color would previously
 * flow into gradient/paint strings with no signal until something rendered
 * wrong on screen. These tests pin the parser's supported formats and the
 * fallback behavior for everything else.
 */

describe('parseColorRgb', () => {
  it('parses 3-digit hex shorthand', () => {
    expect(parseColorRgb('#f00')).toEqual([255, 0, 0]);
    expect(parseColorRgb('#0f0')).toEqual([0, 255, 0]);
  });

  it('parses 6-digit hex', () => {
    expect(parseColorRgb('#3b82f6')).toEqual([0x3b, 0x82, 0xf6]);
  });

  it('parses 4-digit hex shorthand (#rgba), ignoring alpha', () => {
    // This is the CSS Color 4 shorthand-with-alpha form that previously
    // produced NaN for the blue channel.
    expect(parseColorRgb('#38fc')).toEqual([0x33, 0x88, 0xff]);
  });

  it('parses 8-digit hex (#rrggbbaa), ignoring alpha', () => {
    expect(parseColorRgb('#3b82f680')).toEqual([0x3b, 0x82, 0xf6]);
  });

  it('is case-insensitive', () => {
    expect(parseColorRgb('#3B82F6')).toEqual([0x3b, 0x82, 0xf6]);
  });

  it('parses rgb()', () => {
    expect(parseColorRgb('rgb(59, 130, 246)')).toEqual([59, 130, 246]);
  });

  it('parses rgba(), ignoring alpha', () => {
    expect(parseColorRgb('rgba(59, 130, 246, 0.5)')).toEqual([59, 130, 246]);
  });

  it('never returns NaN for any supported hex length', () => {
    for (const c of ['#f00', '#f00f', '#3b82f6', '#3b82f680']) {
      const [r, g, b] = parseColorRgb(c);
      expect(Number.isNaN(r)).toBe(false);
      expect(Number.isNaN(g)).toBe(false);
      expect(Number.isNaN(b)).toBe(false);
    }
  });

  it('falls back to grey for an invalid hex length (not 3/4/6/8)', () => {
    expect(parseColorRgb('#12345')).toEqual([128, 128, 128]);
    expect(parseColorRgb('#1234567')).toEqual([128, 128, 128]);
  });

  it('falls back to grey for named CSS colors', () => {
    expect(parseColorRgb('red')).toEqual([128, 128, 128]);
  });

  it('falls back to grey for garbage input', () => {
    expect(parseColorRgb('not-a-color')).toEqual([128, 128, 128]);
    expect(parseColorRgb('')).toEqual([128, 128, 128]);
  });
});

describe('resolveTheme', () => {
  it('derives fill colors from the same rgb as the line', () => {
    // The scroll-layer z-order work depends on fillTop/fillBottom sharing the
    // exact r/g/b channels that `color` (and therefore `line`) resolves to —
    // this pins that invariant.
    const palette = resolveTheme('#3b82f6', 'light');
    const [r, g, b] = parseColorRgb('#3b82f6');
    expect(palette.line).toBe('#3b82f6');
    expect(palette.fillTop).toBe(`rgba(${r}, ${g}, ${b}, 0.08)`);
    expect(palette.fillBottom).toBe(`rgba(${r}, ${g}, ${b}, 0)`);
  });

  it('uses a stronger fill opacity in dark mode than light mode', () => {
    const light = resolveTheme('#3b82f6', 'light');
    const dark = resolveTheme('#3b82f6', 'dark');
    expect(light.fillTop).toContain('0.08');
    expect(dark.fillTop).toContain('0.12');
  });

  it('does not throw and falls back sanely for an unparseable color', () => {
    const palette = resolveTheme('not-a-color', 'light');
    expect(palette.fillTop).toBe('rgba(128, 128, 128, 0.08)');
  });
});

describe('resolveSeriesPalettes', () => {
  it('assigns each series its own color, falling back to the default cycle', () => {
    const palettes = resolveSeriesPalettes(
      [
        { id: 'a', data: [], value: 0, color: '#ff0000' },
        { id: 'b', data: [], value: 0, color: '' },
      ],
      'light'
    );
    expect(palettes.get('a')!.line).toBe('#ff0000');
    // Falls back to SERIES_COLORS[1] when no color is given.
    expect(palettes.get('b')!.line).toBe('#ef4444');
  });
});
