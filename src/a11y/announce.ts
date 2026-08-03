/**
 * Screen-reader announcement logic — deliberately free of React, React Native
 * and Skia imports so it is unit-testable and so nothing here can be pulled
 * into the render path by accident.
 *
 * The chart itself is a Skia surface: to a screen reader it is an unlabelled
 * blank rectangle. The container `<View>` therefore carries the semantics, and
 * the live number is surfaced through `accessibilityValue.text`.
 *
 * Cadence matters. The displayed value is a UI-thread shared value updated at
 * frame rate; a screen reader cannot consume 60 readings a second and is
 * actively worse for being handed them (VoiceOver/TalkBack restart their
 * utterance on every value change, so a per-frame feed reads as an infinite
 * stutter and never finishes a number). One update per second is the target.
 */

/** Minimum wall-clock gap between two announced values. */
export const ANNOUNCE_INTERVAL_MS = 1000;

export type AnnounceDirection = 'rising' | 'falling' | 'steady';

/** One settled reading, as handed to `accessibilityValue.text`. */
export interface Announcement {
  /** The raw number this reading was built from. */
  value: number;
  /** `value` run through the consumer's `formatValue`. */
  formatted: string;
  /** What the screen reader says — `formatted` plus the direction. */
  text: string;
}

/**
 * Everything `resolveLiveValue` may read. A structural subset of
 * `LivelineProps` rather than the type itself, to keep this module free of the
 * Skia-flavoured type graph.
 */
export interface LiveValueSource {
  value?: number;
  mode?: 'line' | 'candle';
  lineMode?: boolean;
  lineValue?: number;
  liveCandle?: { close: number } | undefined;
  candles?: readonly { close: number }[] | undefined;
}

const isNum = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/**
 * The number a screen reader should hear, picked from whichever prop is
 * authoritative for the chart's current mode.
 *
 * Note this reads the *props*, not the engine's interpolated shared value. The
 * engine lerps toward the incoming value over several frames for visual
 * smoothness; a spoken reading of an in-between frame would be wrong, and the
 * props are already on the JS thread, so this needs no UI→JS crossing at all.
 */
export function resolveLiveValue(src: LiveValueSource): number | null {
  if (src.mode === 'candle' && !src.lineMode) {
    const live = src.liveCandle;
    if (live && isNum(live.close)) return live.close;
    const candles = src.candles;
    if (candles && candles.length > 0) {
      const last = candles[candles.length - 1];
      if (last && isNum(last.close)) return last.close;
    }
  }
  if (src.lineMode && isNum(src.lineValue)) return src.lineValue;
  return isNum(src.value) ? src.value : null;
}

/** Which way the value moved since the previous reading. */
export function announceDirection(
  prev: number | null,
  next: number
): AnnounceDirection {
  if (prev === null || prev === next) return 'steady';
  return next > prev ? 'rising' : 'falling';
}

/**
 * The next reading, or `null` when nothing should be announced — either
 * because there is no value yet, or because the number is unchanged *at the
 * consumer's display precision* since the last reading.
 *
 * The unchanged test is deliberately on the formatted string, not the raw
 * number: a live feed jitters below the formatter's precision constantly, and
 * comparing raw numbers would re-announce an apparently identical reading
 * every second forever. Direction is only computed once the formatted text has
 * moved, so "rising" always corresponds to a change the listener can hear.
 */
export function nextAnnouncement(
  prev: Announcement | null,
  value: number | null,
  format: (v: number) => string
): Announcement | null {
  if (value === null) return null;
  const formatted = format(value);
  if (prev !== null && prev.formatted === formatted) return null;
  const direction = announceDirection(prev === null ? null : prev.value, value);
  const text =
    direction === 'steady' ? formatted : `${formatted}, ${direction}`;
  return { value, formatted, text };
}
