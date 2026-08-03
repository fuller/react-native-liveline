import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, type AccessibilityValue } from 'react-native';
import {
  ANNOUNCE_INTERVAL_MS,
  nextAnnouncement,
  type Announcement,
} from './announce';

/**
 * Whether a screen reader (VoiceOver / TalkBack) is currently running.
 *
 * This is the gate the whole accessibility path hangs off: it costs one
 * promise and one listener subscription at mount, and nothing at all per
 * render or per frame. Everything downstream of it is skipped entirely while
 * it reads `false`, which is the overwhelmingly common case.
 */
export function useScreenReaderEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((value) => {
        if (mounted) setEnabled(value);
      })
      .catch(() => {
        // A platform that cannot answer is treated as "no reader" — the
        // chart then behaves exactly as it did before this existed.
      });
    const sub = AccessibilityInfo.addEventListener(
      'screenReaderChanged',
      (value) => setEnabled(value)
    );
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  return enabled;
}

/**
 * A referentially stable `accessibilityValue` carrying the chart's current
 * reading, or `undefined` when no screen reader is running.
 *
 * `value` is read through a ref rather than an effect dependency, and the
 * sampling timer is only created while `enabled` — so with the reader off this
 * hook does one boolean test and one ref write per render, allocates nothing,
 * and registers no timer, no listener and no UI-thread work.
 *
 * With the reader on, the timer samples at {@link ANNOUNCE_INTERVAL_MS} and
 * only commits state when the formatted text actually changed, so a live chart
 * costs at most one extra React render per second and a still one costs none.
 * Crucially it does *not* re-render on tick: the chart's ~60Hz updates flow
 * into a ref, never into state.
 */
export function useAccessibleValue(
  enabled: boolean,
  value: number | null,
  format: (v: number) => string
): AccessibilityValue | undefined {
  const latest = useRef<number | null>(null);
  latest.current = enabled ? value : null;

  // `formatValue` is typically an inline arrow on the consumer's side, so its
  // identity churns every tick. Reading it through a ref keeps it out of the
  // effect's dependency list — otherwise the sampling timer would be torn
  // down and rebuilt on every frame.
  const formatRef = useRef(format);
  formatRef.current = format;

  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setText(null);
      return;
    }
    let prev: Announcement | null = null;
    const sample = () => {
      const next = nextAnnouncement(prev, latest.current, formatRef.current);
      if (next === null) return;
      prev = next;
      setText(next.text);
    };
    sample();
    const id = setInterval(sample, ANNOUNCE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled]);

  // Memoized so the prop identity only changes when the spoken text does —
  // a fresh object every render would push an accessibility update to the
  // host view on every tick, which is the exact thing this hook exists to
  // avoid.
  return useMemo(() => (text === null ? undefined : { text }), [text]);
}
