/* eslint-disable react-native/no-inline-styles -- control styles are theme/prop-derived */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import {
  Canvas,
  Picture,
  Path,
  Line,
  RoundedRect,
  vec,
} from '@shopify/react-native-skia';
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { GestureDetector } from 'react-native-gesture-handler';
import type { LivelineProps, Momentum, DegenOptions } from './types';
import { resolveTheme, resolveSeriesPalettes, SERIES_COLORS } from './theme';
import { makeDefaultFonts } from './draw/fonts';
import { useLivelineEngine } from './useLivelineEngine';

const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

const defaultFormatValue = (v: number) => {
  'worklet';
  return v.toFixed(2);
};

const defaultFormatTime = (t: number) => {
  'worklet';
  const d = new Date(t * 1000);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
};

const INDICATOR_TIMING = {
  duration: 250,
  easing: Easing.bezier(0.4, 0, 0.2, 1),
};

interface BtnLayout {
  x: number;
  width: number;
}

/** Sliding indicator behind the active button in a pill bar. */
function SlidingIndicator({
  layout,
  rounded,
  isDark,
}: {
  layout: BtnLayout | undefined;
  rounded: boolean;
  isDark: boolean;
}) {
  const left = useSharedValue(0);
  const width = useSharedValue(0);
  const ready = useSharedValue(0);

  useEffect(() => {
    if (!layout) return;
    if (ready.value === 0) {
      left.value = layout.x;
      width.value = layout.width;
      ready.value = 1;
    } else {
      left.value = withTiming(layout.x, INDICATOR_TIMING);
      width.value = withTiming(layout.width, INDICATOR_TIMING);
    }
  }, [layout, left, width, ready]);

  const animStyle = useAnimatedStyle(() => ({
    left: left.value,
    width: width.value,
    opacity: ready.value,
  }));

  const inset = rounded ? 3 : 2;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.indicator,
        {
          top: inset,
          bottom: inset,
          borderRadius: rounded ? 999 : 4,
          backgroundColor: isDark
            ? 'rgba(255,255,255,0.06)'
            : 'rgba(0,0,0,0.035)',
        },
        animStyle,
      ]}
    />
  );
}

/** Line-chart mini icon (matches the web SVG). */
function LineIcon({ color, active }: { color: string; active: boolean }) {
  return (
    <Canvas style={styles.icon}>
      <Path
        path="M1 8.5C2.5 8.5 3 4 5.5 4S7.5 7 8.5 7C9.5 7 10 3.5 11 3.5"
        style="stroke"
        strokeWidth={active ? 1.5 : 1.2}
        strokeCap="round"
        color={color}
      />
    </Canvas>
  );
}

/** Candlestick mini icon (matches the web SVG). */
function CandleIcon({ color }: { color: string }) {
  return (
    <Canvas style={styles.icon}>
      <Line p1={vec(3.5, 1)} p2={vec(3.5, 11)} strokeWidth={1} color={color} />
      <RoundedRect x={2} y={3} width={3} height={5} r={0.5} color={color} />
      <Line p1={vec(8.5, 2)} p2={vec(8.5, 10)} strokeWidth={1} color={color} />
      <RoundedRect x={7} y={4} width={3} height={4} r={0.5} color={color} />
    </Canvas>
  );
}

export function Liveline({
  data,
  value,
  series: seriesProp,
  theme = 'dark',
  color = '#3b82f6',
  window: windowSecs = 30,
  grid = true,
  badge = true,
  momentum = true,
  fill = true,
  scrub = true,
  scrubActivationDelay,
  active = true,
  loading = false,
  paused = false,
  emptyText,
  exaggerate = false,
  degen: degenProp,
  badgeTail = true,
  badgeVariant = 'default',
  showValue = false,
  valueMomentumColor = false,
  windows,
  onWindowChange,
  windowStyle,
  tooltipY = 14,
  tooltipOutline = true,
  orderbook,
  referenceLine,
  formatValue = defaultFormatValue,
  formatTime = defaultFormatTime,
  lerpSpeed = 0.08,
  padding: paddingOverride,
  onHover,
  pulse = true,
  mode = 'line',
  candles,
  candleWidth,
  liveCandle,
  lineMode,
  lineData,
  lineValue,
  onModeChange,
  onSeriesToggle,
  seriesToggleCompact = false,
  lineWidth,
  fonts: fontsOverride,
  style,
}: LivelineProps) {
  const [windowBtnLayouts, setWindowBtnLayouts] = useState<
    Record<number, BtnLayout>
  >({});
  const [modeBtnLayouts, setModeBtnLayouts] = useState<
    Record<string, BtnLayout>
  >({});
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());
  const lastSeriesPropRef = useRef(seriesProp);
  if (seriesProp && seriesProp.length > 0)
    lastSeriesPropRef.current = seriesProp;

  const palette = useMemo(() => {
    const p = resolveTheme(color, theme);
    if (lineWidth != null) p.lineWidth = lineWidth;
    return p;
  }, [color, theme, lineWidth]);
  const isDark = theme === 'dark';
  const isMultiSeries = seriesProp != null && seriesProp.length > 0;
  const showSeriesToggle = (lastSeriesPropRef.current?.length ?? 0) > 1;

  // Skia fonts — stable object (the engine captures it in the frame worklet)
  const fonts = useMemo(
    () => ({ ...makeDefaultFonts(), ...fontsOverride }),
    [fontsOverride]
  );

  // Per-series palettes (memoized on series ids + colors + theme)
  const seriesPalettes = useMemo(() => {
    if (!seriesProp || seriesProp.length === 0) return null;
    return resolveSeriesPalettes(seriesProp, theme);
  }, [seriesProp, theme]);

  // Normalized multi-series config for the engine
  const multiSeries = useMemo(() => {
    if (!seriesProp || !seriesPalettes) return undefined;
    return seriesProp.map((s, i) => ({
      id: s.id,
      data: s.data,
      value: s.value,
      palette:
        seriesPalettes.get(s.id) ??
        resolveTheme(
          s.color || SERIES_COLORS[i % SERIES_COLORS.length]!,
          theme
        ),
      label: s.label,
    }));
  }, [seriesProp, seriesPalettes, theme]);

  // Resolve momentum prop: boolean enables auto-detect, string overrides
  const showMomentum = momentum !== false;
  const momentumOverride: Momentum | undefined =
    typeof momentum === 'string' ? momentum : undefined;

  const defaultRight = badge ? 80 : grid ? 54 : 12;
  const pad = {
    top: paddingOverride?.top ?? 12,
    right: paddingOverride?.right ?? defaultRight,
    bottom: paddingOverride?.bottom ?? 28,
    left: paddingOverride?.left ?? 12,
  };

  // Degen mode: explicit prop wins
  const degenEnabled = degenProp != null ? degenProp !== false : false;
  const degenOptions: DegenOptions | undefined = degenEnabled
    ? typeof degenProp === 'object'
      ? degenProp
      : {}
    : undefined;

  // Window buttons state
  const [activeWindowSecs, setActiveWindowSecs] = useState(
    windows && windows.length > 0 ? windows[0]!.secs : windowSecs
  );
  const effectiveWindowSecs = windows ? activeWindowSecs : windowSecs;

  // Series toggle handler — prevent hiding the last visible series
  const handleSeriesToggle = useCallback(
    (id: string) => {
      setHiddenSeries((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
          onSeriesToggle?.(id, true);
        } else {
          // Count visible series — don't hide last one
          const totalSeries = seriesProp?.length ?? 0;
          const visibleCount = totalSeries - next.size;
          if (visibleCount <= 1) return prev;
          next.add(id);
          onSeriesToggle?.(id, false);
        }
        return next;
      });
    },
    [seriesProp?.length, onSeriesToggle]
  );

  const ws = windowStyle ?? 'default';

  const hiddenSeriesIds = useMemo(() => [...hiddenSeries], [hiddenSeries]);

  const engine = useLivelineEngine(
    {
      data,
      value,
      palette,
      windowSecs: effectiveWindowSecs,
      lerpSpeed,
      showGrid: grid,
      showBadge: isMultiSeries ? false : badge,
      showMomentum: isMultiSeries ? false : showMomentum,
      momentumOverride,
      showFill: isMultiSeries ? false : fill,
      referenceLine,
      formatValue,
      formatTime,
      padding: pad,
      showPulse: pulse,
      scrub,
      scrubActivationDelay,
      active,
      exaggerate,
      degenOptions: isMultiSeries ? undefined : degenOptions,
      badgeTail,
      badgeVariant,
      tooltipY,
      tooltipOutline,
      valueMomentumColor,
      showValue,
      orderbookData: orderbook,
      loading,
      paused,
      emptyText,
      mode,
      candles,
      candleWidth,
      liveCandle,
      lineMode,
      lineData,
      lineValue,
      multiSeries,
      isMultiSeries,
      hiddenSeriesIds,
    },
    fonts,
    onHover
  );

  // Live value display — ReText pattern: TextInput driven from the UI thread
  const defaultValueColor = isDark ? 'rgba(255,255,255,0.85)' : '#111111';
  const valueProps = useAnimatedProps(() => {
    return {
      text: engine.valueText.value,
      defaultValue: engine.valueText.value,
    } as any;
  });
  const valueStyle = useAnimatedStyle(() => ({
    color:
      engine.valueColor.value !== ''
        ? engine.valueColor.value
        : defaultValueColor,
  }));

  const activeColor = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)';
  const inactiveColor = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.22)';
  const barBg =
    ws === 'text'
      ? 'transparent'
      : isDark
        ? 'rgba(255,255,255,0.03)'
        : 'rgba(0,0,0,0.02)';
  const barRadius = ws === 'rounded' ? 999 : 6;
  const barPadding = ws === 'text' ? 0 : ws === 'rounded' ? 3 : 2;
  const barGap = ws === 'text' ? 4 : 2;
  const btnRadius = ws === 'rounded' ? 999 : 4;

  const activeMode = lineMode ? 'line' : 'candle';

  const onWindowBtnLayout = useCallback(
    (secs: number, e: LayoutChangeEvent) => {
      const { x, width } = e.nativeEvent.layout;
      setWindowBtnLayouts((prev) => {
        const cur = prev[secs];
        if (cur && cur.x === x && cur.width === width) return prev;
        return { ...prev, [secs]: { x, width } };
      });
    },
    []
  );

  const onModeBtnLayout = useCallback((key: string, e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    setModeBtnLayouts((prev) => {
      const cur = prev[key];
      if (cur && cur.x === x && cur.width === width) return prev;
      return { ...prev, [key]: { x, width } };
    });
  }, []);

  return (
    <>
      {/* Live value display — above the chart */}
      {showValue && (
        <AnimatedTextInput
          editable={false}
          animatedProps={valueProps}
          style={[styles.valueDisplay, { paddingLeft: pad.left }, valueStyle]}
        />
      )}

      {/* Control bars row — window pills + mode toggle + series chips side by side */}
      {((windows && windows.length > 0) ||
        onModeChange ||
        showSeriesToggle) && (
        <View style={[styles.controlsRow, { marginLeft: pad.left }]}>
          {/* Time window controls */}
          {windows && windows.length > 0 && (
            <View
              style={[
                styles.bar,
                {
                  gap: barGap,
                  backgroundColor: barBg,
                  borderRadius: barRadius,
                  padding: barPadding,
                },
              ]}
            >
              {ws !== 'text' && (
                <SlidingIndicator
                  layout={windowBtnLayouts[activeWindowSecs]}
                  rounded={ws === 'rounded'}
                  isDark={isDark}
                />
              )}
              {windows.map((w) => {
                const isActive = w.secs === activeWindowSecs;
                return (
                  <Pressable
                    key={w.secs}
                    onLayout={(e) => onWindowBtnLayout(w.secs, e)}
                    onPress={() => {
                      setActiveWindowSecs(w.secs);
                      onWindowChange?.(w.secs);
                    }}
                    style={{
                      paddingVertical: ws === 'text' ? 2 : 3,
                      paddingHorizontal: ws === 'text' ? 6 : 10,
                      borderRadius: btnRadius,
                    }}
                  >
                    <Animated.Text
                      style={{
                        fontSize: 11,
                        lineHeight: 16,
                        fontWeight: isActive ? '600' : '400',
                        color: isActive ? activeColor : inactiveColor,
                      }}
                    >
                      {w.label}
                    </Animated.Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* Mode toggle — separate bar with its own sliding indicator */}
          {onModeChange && (
            <View
              style={[
                styles.bar,
                {
                  gap: barGap,
                  backgroundColor: barBg,
                  borderRadius: barRadius,
                  padding: barPadding,
                },
              ]}
            >
              {ws !== 'text' && (
                <SlidingIndicator
                  layout={modeBtnLayouts[activeMode]}
                  rounded={ws === 'rounded'}
                  isDark={isDark}
                />
              )}
              <Pressable
                onLayout={(e) => onModeBtnLayout('line', e)}
                onPress={() => onModeChange('line')}
                style={[styles.iconBtn, { borderRadius: btnRadius }]}
              >
                <LineIcon
                  color={activeMode === 'line' ? activeColor : inactiveColor}
                  active={activeMode === 'line'}
                />
              </Pressable>
              <Pressable
                onLayout={(e) => onModeBtnLayout('candle', e)}
                onPress={() => onModeChange('candle')}
                style={[styles.iconBtn, { borderRadius: btnRadius }]}
              >
                <CandleIcon
                  color={activeMode === 'candle' ? activeColor : inactiveColor}
                />
              </Pressable>
            </View>
          )}

          {/* Series toggle chips */}
          {showSeriesToggle && (
            <View
              pointerEvents={isMultiSeries ? 'auto' : 'none'}
              style={[
                styles.bar,
                {
                  gap: barGap,
                  backgroundColor: barBg,
                  borderRadius: barRadius,
                  padding: barPadding,
                  opacity: isMultiSeries ? 1 : 0,
                },
              ]}
            >
              {(lastSeriesPropRef.current ?? []).map((s, si) => {
                const isHidden = hiddenSeries.has(s.id);
                const seriesColor =
                  s.color || SERIES_COLORS[si % SERIES_COLORS.length]!;
                return (
                  <Pressable
                    key={s.id}
                    onPress={() => handleSeriesToggle(s.id)}
                    style={{
                      paddingVertical: seriesToggleCompact
                        ? ws === 'text'
                          ? 2
                          : 5
                        : ws === 'text'
                          ? 2
                          : 3,
                      paddingHorizontal: seriesToggleCompact
                        ? ws === 'text'
                          ? 4
                          : 7
                        : ws === 'text'
                          ? 6
                          : 8,
                      borderRadius: btnRadius,
                      backgroundColor: isHidden
                        ? 'transparent'
                        : ws === 'text'
                          ? 'transparent'
                          : isDark
                            ? 'rgba(255,255,255,0.06)'
                            : 'rgba(0,0,0,0.035)',
                      opacity: isHidden ? 0.4 : 1,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: seriesToggleCompact ? 0 : 4,
                    }}
                  >
                    <View
                      style={{
                        width: seriesToggleCompact ? 8 : 6,
                        height: seriesToggleCompact ? 8 : 6,
                        borderRadius: 999,
                        backgroundColor: seriesColor,
                        opacity: isHidden ? 0.4 : 1,
                      }}
                    />
                    {!seriesToggleCompact && (
                      <Animated.Text
                        style={{
                          fontSize: 11,
                          lineHeight: 16,
                          fontWeight: '500',
                          color: isHidden ? inactiveColor : activeColor,
                        }}
                      >
                        {s.label ?? s.id}
                      </Animated.Text>
                    )}
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>
      )}

      <GestureDetector gesture={engine.gesture}>
        <View
          onLayout={engine.onLayout}
          style={[styles.container, style]}
          collapsable={false}
        >
          <Canvas style={styles.canvas}>
            <Picture picture={engine.picture} />
          </Canvas>
        </View>
      </GestureDetector>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: '100%',
    position: 'relative',
  },
  canvas: {
    flex: 1,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  bar: {
    position: 'relative',
    flexDirection: 'row',
    alignSelf: 'flex-start',
  },
  indicator: {
    position: 'absolute',
  },
  iconBtn: {
    paddingVertical: 5,
    paddingHorizontal: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    width: 12,
    height: 12,
  },
  valueDisplay: {
    fontSize: 20,
    fontWeight: '500',
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    letterSpacing: -0.2,
    marginBottom: 8,
    paddingTop: 4,
    paddingBottom: 0,
    paddingHorizontal: 0,
  },
});
