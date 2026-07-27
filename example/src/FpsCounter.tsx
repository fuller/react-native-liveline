/* eslint-disable react-native/no-inline-styles -- control styles are theme/prop-derived, mirrors upstream web demo controls */
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput } from 'react-native';
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
} from 'react-native-reanimated';
import { useAppTheme } from './AppTheme';
import { fg } from './uiStyle';

const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

// Redraw the displayed number at most this often — every frame would be
// unreadable jitter even though the underlying measurement is per-frame.
const DISPLAY_INTERVAL_MS = 250;
// Smoothing factor for the exponential moving average of instantaneous fps.
const EMA_ALPHA = 0.15;

/**
 * UI-thread-only FPS counter in the top bar, tap-to-toggle and DEFAULT OFF.
 * Deliberately mirrors the library's own "ReText" pattern (Liveline.tsx's
 * live-value display) — an editable TextInput driven via useAnimatedProps —
 * so the reading is honest while running: it keeps updating even while the
 * JS thread is fully blocked (see StressButton), since nothing in this path
 * touches JS/React.
 *
 * It defaults off because this library's headline optimization is engine
 * quiescence (src/engine/quiescence.ts) — the chart stops re-recording its
 * picture once everything settles. A permanently-active per-frame UI-thread
 * callback would keep the app rendering forever, making quiescence
 * unobservable and burning battery on device: the instrument would change
 * what it measures. Tap the pill to opt in when you actually want a reading.
 */
export function FpsCounter() {
  const { isDark } = useAppTheme();
  const [running, setRunning] = useState(false);

  const fpsText = useSharedValue('-- fps');
  const emaFps = useSharedValue(60);
  const lastDisplayMs = useSharedValue(0);

  // autostart=false: we always drive activity explicitly via setActive below
  // so toggling off mid-session genuinely stops the per-frame callback
  // rather than just leaving it running and ignoring the display.
  const frameCallback = useFrameCallback((info) => {
    'worklet';
    const dt = info.timeSincePreviousFrame;
    if (dt === null || dt <= 0) return;
    const instantFps = 1000 / dt;
    emaFps.value = emaFps.value + (instantFps - emaFps.value) * EMA_ALPHA;

    if (info.timestamp - lastDisplayMs.value >= DISPLAY_INTERVAL_MS) {
      lastDisplayMs.value = info.timestamp;
      fpsText.value = `${Math.round(emaFps.value)} fps`;
    }
  }, false);

  useEffect(() => {
    frameCallback.setActive(running);
    if (running) {
      // Reset so the first reading after re-enabling isn't a stale value
      // left over from before the counter was stopped.
      emaFps.value = 60;
      lastDisplayMs.value = 0;
      fpsText.value = '-- fps';
    }
    // frameCallback identity is stable across renders (Reanimated hook).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const textProps = useAnimatedProps(() => {
    return {
      text: fpsText.value,
      defaultValue: fpsText.value,
    } as any;
  });

  const textStyle = useAnimatedStyle(() => {
    const f = emaFps.value;
    return { color: f >= 55 ? '#22c55e' : f >= 30 ? '#f59e0b' : '#ef4444' };
  });

  return (
    <Pressable
      onPress={() => setRunning((r) => !r)}
      style={{
        height: 24,
        justifyContent: 'center',
        paddingHorizontal: 8,
        borderRadius: 5,
        borderWidth: 1,
        borderColor: fg(isDark, 0.08),
        backgroundColor: fg(isDark, 0.02),
      }}
    >
      {running ? (
        <AnimatedTextInput
          editable={false}
          animatedProps={textProps}
          style={[
            {
              fontSize: 12,
              fontWeight: '600',
              padding: 0,
              margin: 0,
              minWidth: 44,
              textAlign: 'right',
            },
            textStyle,
          ]}
        />
      ) : (
        <Text
          style={{
            fontSize: 12,
            fontWeight: '600',
            color: fg(isDark, 0.3),
            minWidth: 44,
            textAlign: 'right',
          }}
        >
          fps
        </Text>
      )}
    </Pressable>
  );
}
