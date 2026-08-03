import type { ThemeMode, LivelinePalette, LivelineSeries } from './types';

/**
 * Dev-only warning for an unparseable colour, deduped by last value.
 *
 * `parseColorRgb` is called from the frame path (`draw/dot.ts` parses
 * `palette.line` and `palette.badgeOuterBg` while scrub-dimming), so an
 * unconditional warning would fire up to 60 times a second for as long as a
 * bad colour is set. The dedupe flag lives on `globalThis`, NOT in a
 * module-level `let`: this runs as a worklet on the UI runtime, where the
 * plugin captures module bindings per-runtime — a captured `let` is at best
 * a stale per-runtime copy and at worst not writable at all. The global is
 * per-runtime too (so a bad colour can warn once on each runtime that parses
 * it), which is the acceptable cost of not mutating captured state.
 */
function warnUnrecognizedColor(color: string): void {
  'worklet';
  const g = globalThis as { __livelineWarnedColor?: string };
  if (g.__livelineWarnedColor === color) return;
  g.__livelineWarnedColor = color;
  console.warn(
    `[react-native-liveline] parseColorRgb: unrecognized color "${color}" — ` +
      'expected #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), or rgba(). Falling back to grey.'
  );
}

/**
 * Parse any CSS color string to [r, g, b].
 *
 * Supported formats: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`.
 * Named CSS colors (e.g. `"red"`) are NOT supported and fall back to grey —
 * pass a hex or rgb()/rgba() string instead.
 *
 * Unparseable input falls back to mid-grey `[128, 128, 128]` rather than
 * throwing, so a bad color never crashes rendering; in development this logs
 * a warning naming the offending value.
 */
export function parseColorRgb(color: string): [number, number, number] {
  'worklet';
  const hex = color.match(/^#([0-9a-f]+)$/i);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) {
      // Expand shorthand: #rgb -> #rrggbb, #rgba -> #rrggbbaa (alpha ignored).
      h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
    }
    if (h.length === 6 || h.length === 8) {
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
      ];
    }
    // Invalid digit count (not 3/4/6/8) — fall through to the grey fallback
    // below rather than silently mangling a partial parse.
  } else {
    const rgb = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgb) return [+rgb[1]!, +rgb[2]!, +rgb[3]!];
  }
  if (__DEV__) {
    warnUnrecognizedColor(color);
  }
  return [128, 128, 128];
}

function rgba(r: number, g: number, b: number, a: number): string {
  'worklet';
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Derive a full palette from a single accent color + theme mode.
 *
 * Note: `dotUp`/`dotDown`/`dotFlat`/`glowUp`/`glowDown`/`glowFlat`/`badgeBg`/
 * `badgeText` are computed here but not read by the current renderer (see
 * comments below) — the dot and badge paint from `line`/`badgeOuterBg`/
 * `tooltipText` instead. Momentum is not currently expressed as dot color.
 */
export function resolveTheme(color: string, mode: ThemeMode): LivelinePalette {
  'worklet';
  const [r, g, b] = parseColorRgb(color);
  const isDark = mode === 'dark';

  return {
    // Line
    line: color,
    lineWidth: 2,

    // Fill gradient
    fillTop: rgba(r, g, b, isDark ? 0.12 : 0.08),
    fillBottom: rgba(r, g, b, 0),

    // Grid
    gridLine: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.06)',
    gridLabel: isDark ? 'rgba(255, 255, 255, 0.4)' : 'rgba(0, 0, 0, 0.35)',

    // Dot — NOT currently read by the renderer. `src/draw/dot.ts` paints the
    // live dot unconditionally from `palette.line`; these fields are kept
    // (rather than removed) only because `LivelinePalette` is a shared type
    // consumed by src/draw/* and src/engine/*, and the surface required to
    // safely drop them is out of this file's scope. Do not treat these as
    // "the dot's momentum color" — that behavior does not exist today.
    dotUp: '#22c55e',
    dotDown: '#ef4444',
    dotFlat: color,
    glowUp: 'rgba(34, 197, 94, 0.18)',
    glowDown: 'rgba(239, 68, 68, 0.18)',
    glowFlat: rgba(r, g, b, 0.12),

    // Badge — `badgeBg`/`badgeText` below are likewise unused by the
    // renderer; `src/engine/badge.ts` sources its fill/text colors from
    // `badgeOuterBg`, `line`, and `tooltipText` instead. Kept for the same
    // reason as the dot fields above.
    badgeOuterBg: isDark
      ? 'rgba(40, 40, 40, 0.95)'
      : 'rgba(255, 255, 255, 0.95)',
    badgeOuterShadow: isDark ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0.15)',
    badgeBg: color,
    badgeText: '#ffffff',

    // Dash line
    dashLine: rgba(r, g, b, 0.4),

    // Reference line
    refLine: isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.12)',
    refLabel: isDark ? 'rgba(255, 255, 255, 0.45)' : 'rgba(0, 0, 0, 0.4)',

    // Time axis
    timeLabel: isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.3)',

    // Crosshair
    crosshairLine: isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.12)',
    tooltipBg: isDark ? 'rgba(30, 30, 30, 0.95)' : 'rgba(255, 255, 255, 0.95)',
    tooltipText: isDark ? '#e5e5e5' : '#1a1a1a',
    tooltipBorder: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)',

    // Background
    bgRgb: isDark
      ? ([10, 10, 10] as [number, number, number])
      : ([255, 255, 255] as [number, number, number]),
  };
}

/** Default color palette for multi-series when no colors specified. */
export const SERIES_COLORS = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#22c55e', // green
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
];

/** Derive per-series palettes from series definitions. */
export function resolveSeriesPalettes(
  series: LivelineSeries[],
  mode: ThemeMode
): Map<string, LivelinePalette> {
  const map = new Map<string, LivelinePalette>();
  for (let i = 0; i < series.length; i++) {
    const s = series[i]!;
    const color = s.color || SERIES_COLORS[i % SERIES_COLORS.length]!;
    map.set(s.id, resolveTheme(color, mode));
  }
  return map;
}
