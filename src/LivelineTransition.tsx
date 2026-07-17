import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

export interface LivelineTransitionProps {
  /** Key of the active child to display. Must match a child's `key` prop. */
  active: string;
  /** Chart elements with unique `key` props */
  children: ReactElement | ReactElement[];
  /** Cross-fade duration in ms (default 300) */
  duration?: number;
  style?: StyleProp<ViewStyle>;
}

function Fade({
  visible,
  duration,
  children,
}: {
  visible: boolean;
  duration: number;
  children: ReactNode;
}) {
  const opacity = useSharedValue(visible ? 0 : 1);

  useEffect(() => {
    opacity.value = withTiming(visible ? 1 : 0, { duration });
  }, [visible, duration, opacity]);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      pointerEvents={visible ? 'auto' : 'none'}
      style={[StyleSheet.absoluteFill, animStyle]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * Cross-fade between chart components (e.g. line ↔ candlestick).
 * Children must have unique `key` props matching possible `active` values.
 *
 * @example
 * ```tsx
 * <LivelineTransition active={chartType}>
 *   <Liveline key="line" data={data} value={value} />
 *   <Liveline key="candle" mode="candle" candles={candles} candleWidth={5} data={data} value={value} />
 * </LivelineTransition>
 * ```
 */
export function LivelineTransition({
  active,
  children,
  duration = 300,
  style,
}: LivelineTransitionProps) {
  const childArray = Array.isArray(children) ? children : [children];

  const [mounted, setMounted] = useState<Set<string>>(() => new Set([active]));
  const [visible, setVisible] = useState(active);
  const prevRef = useRef(active);

  useEffect(() => {
    if (active === prevRef.current) return () => {};
    const oldKey = prevRef.current;
    prevRef.current = active;

    // Mount the incoming child
    setMounted((prev) => new Set([...prev, active]));

    // Flip visibility on the next frame so the fade-in animates from 0
    const raf = requestAnimationFrame(() => setVisible(active));

    // Unmount the outgoing child after transition completes
    const timer = setTimeout(() => {
      setMounted((prev) => {
        const next = new Set(prev);
        next.delete(oldKey);
        return next;
      });
    }, duration + 50);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [active, duration]);

  return (
    <View style={[styles.container, style]}>
      {childArray.map((child) => {
        const key = String(child.key ?? '');
        if (!mounted.has(key)) return null;
        return (
          <Fade key={key} visible={key === visible} duration={duration}>
            {child}
          </Fade>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    width: '100%',
    height: '100%',
  },
});
