/* eslint-disable react-native/no-inline-styles -- control styles are theme/prop-derived, mirrors upstream web demo controls */
import { useCallback, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { useAppTheme } from './AppTheme';

/**
 * Blocks the JS thread synchronously for ~2s. The chart engine runs entirely
 * on the UI thread (Reanimated `useFrameCallback` + Skia picture recording),
 * so it must keep animating smoothly while this runs — that's the whole
 * point of this button.
 */
export function StressButton() {
  const { isDark } = useAppTheme();
  const [blocking, setBlocking] = useState(false);

  const handlePress = useCallback(() => {
    setBlocking(true);
    // Let the "blocking..." label paint before we freeze the JS thread.
    requestAnimationFrame(() => {
      const end = Date.now() + 2000;
      while (Date.now() < end) {
        // Intentionally synchronous — blocks the JS thread for ~2s.
      }
      setBlocking(false);
    });
  }, []);

  return (
    <Pressable
      onPress={handlePress}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: 'rgba(239,68,68,0.5)',
        backgroundColor: 'rgba(239,68,68,0.12)',
      }}
    >
      <Text
        style={{
          fontSize: 11,
          fontWeight: '600',
          color: isDark ? '#ff8080' : '#c81e1e',
        }}
      >
        {blocking ? 'Blocking JS…' : 'Block JS 2s'}
      </Text>
    </Pressable>
  );
}
