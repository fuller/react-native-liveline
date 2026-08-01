import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
  Group,
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

  const chrome = useMemo(() => {
    const inset = rounded ? 3 : 2;
    return {
      top: inset,
      bottom: inset,
      borderRadius: rounded ? 999 : 4,
      backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.035)',
    };
  }, [rounded, isDark]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.indicator, chrome, animStyle]}
    />
  );
}

type WindowStyle = NonNullable<LivelineProps['windowStyle']>;

/**
 * The style scalars every control bar shares, derived from `windowStyle` and
 * the theme. Memoized on those two inputs so the style objects handed to the
 * bars are referentially stable across renders (a live chart re-renders on
 * every tick; these do not change with it).
 */
function useBarStyle(ws: WindowStyle, isDark: boolean) {
  return useMemo(() => {
    const isText = ws === 'text';
    const isRounded = ws === 'rounded';
    const activeColor = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)';
    const inactiveColor = isDark
      ? 'rgba(255,255,255,0.25)'
      : 'rgba(0,0,0,0.22)';
    const btnRadius = isRounded ? 999 : 4;
    return {
      isText,
      isRounded,
      activeColor,
      inactiveColor,
      btnRadius,
      /** The computed half of the bar `<View>` style (see `styles.bar`). */
      chrome: {
        gap: isText ? 4 : 2,
        backgroundColor: isText
          ? 'transparent'
          : isDark
            ? 'rgba(255,255,255,0.03)'
            : 'rgba(0,0,0,0.02)',
        borderRadius: isRounded ? 999 : 6,
        padding: isText ? 0 : isRounded ? 3 : 2,
      },
      /** Window-selector pill hit area. */
      pill: {
        paddingVertical: isText ? 2 : 3,
        paddingHorizontal: isText ? 6 : 10,
        borderRadius: btnRadius,
      },
      /** Mode-toggle icon button (pairs with `styles.iconBtn`). */
      iconBtn: { borderRadius: btnRadius },
      labelActive: {
        fontSize: 11,
        lineHeight: 16,
        fontWeight: '600' as const,
        color: activeColor,
      },
      labelInactive: {
        fontSize: 11,
        lineHeight: 16,
        fontWeight: '400' as const,
        color: inactiveColor,
      },
    };
  }, [ws, isDark]);
}

type BarStyle = ReturnType<typeof useBarStyle>;

/**
 * Series-chip styles. Separate from `useBarStyle` because they additionally
 * branch on `seriesToggleCompact`, which the other two bars know nothing about.
 */
function useChipStyle(bar: BarStyle, isDark: boolean, compact: boolean) {
  return useMemo(() => {
    const { isText, btnRadius, activeColor, inactiveColor } = bar;
    const labelBase = {
      fontSize: 11,
      lineHeight: 16,
      fontWeight: '500' as const,
    };
    return {
      base: {
        paddingVertical: compact ? (isText ? 2 : 5) : isText ? 2 : 3,
        paddingHorizontal: compact ? (isText ? 4 : 7) : isText ? 6 : 8,
        borderRadius: btnRadius,
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: compact ? 0 : 4,
        backgroundColor: isText
          ? 'transparent'
          : isDark
            ? 'rgba(255,255,255,0.06)'
            : 'rgba(0,0,0,0.035)',
      },
      /** Applied on top of `base` for a toggled-off series. */
      off: { backgroundColor: 'transparent', opacity: 0.4 },
      dot: {
        width: compact ? 8 : 6,
        height: compact ? 8 : 6,
        borderRadius: 999,
      },
      label: { ...labelBase, color: activeColor },
      labelOff: { ...labelBase, color: inactiveColor },
    };
  }, [bar, isDark, compact]);
}

/**
 * The chrome shared by all three control bars: a self-sizing row with the
 * theme/`windowStyle`-derived background, radius, padding and gap, optionally
 * hosting the sliding indicator that tracks the active button.
 *
 * Note this lives entirely *above* the `<Canvas>` — see the comment on the
 * Skia subtree below, whose node structure must stay fixed.
 */
function PillBar({
  bar,
  isDark,
  indicator = false,
  indicatorLayout,
  faded = false,
  children,
}: {
  bar: BarStyle;
  isDark: boolean;
  /** Render a sliding indicator behind the active button. */
  indicator?: boolean;
  /** Layout of the currently active button; `undefined` until first measured. */
  indicatorLayout?: BtnLayout;
  /** Keep the bar mounted but invisible and untappable. */
  faded?: boolean;
  children: ReactNode;
}) {
  return (
    <View
      pointerEvents={faded ? 'none' : 'auto'}
      style={[styles.bar, bar.chrome, faded && styles.barFaded]}
    >
      {indicator && !bar.isText && (
        <SlidingIndicator
          layout={indicatorLayout}
          rounded={bar.isRounded}
          isDark={isDark}
        />
      )}
      {children}
    </View>
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

/**
 * Memoized: in a list of charts (the `active`-prop scenario), unrelated
 * parent re-renders must not re-render every row. Live ticks still pass
 * through — a tick produces a new `data` array, which fails the shallow
 * compare for that chart only.
 */
export const Liveline = memo(function LivelineComponent({
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

  const bar = useBarStyle(ws, isDark);
  const chip = useChipStyle(bar, isDark, seriesToggleCompact);

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
            <PillBar
              bar={bar}
              isDark={isDark}
              indicator
              indicatorLayout={windowBtnLayouts[activeWindowSecs]}
            >
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
                    style={bar.pill}
                  >
                    <Animated.Text
                      style={isActive ? bar.labelActive : bar.labelInactive}
                    >
                      {w.label}
                    </Animated.Text>
                  </Pressable>
                );
              })}
            </PillBar>
          )}

          {/* Mode toggle — separate bar with its own sliding indicator */}
          {onModeChange && (
            <PillBar
              bar={bar}
              isDark={isDark}
              indicator
              indicatorLayout={modeBtnLayouts[activeMode]}
            >
              <Pressable
                onLayout={(e) => onModeBtnLayout('line', e)}
                onPress={() => onModeChange('line')}
                style={[styles.iconBtn, bar.iconBtn]}
              >
                <LineIcon
                  color={
                    activeMode === 'line' ? bar.activeColor : bar.inactiveColor
                  }
                  active={activeMode === 'line'}
                />
              </Pressable>
              <Pressable
                onLayout={(e) => onModeBtnLayout('candle', e)}
                onPress={() => onModeChange('candle')}
                style={[styles.iconBtn, bar.iconBtn]}
              >
                <CandleIcon
                  color={
                    activeMode === 'candle'
                      ? bar.activeColor
                      : bar.inactiveColor
                  }
                />
              </Pressable>
            </PillBar>
          )}

          {/*
            Series toggle chips. No sliding indicator — chips toggle
            independently, so there is no single "active" one to track.
            Rendered from lastSeriesPropRef (not seriesProp) and merely faded
            out when the chart leaves multi-series mode: unmounting the bar
            would reflow the controls row and drop the hidden-series state.
          */}
          {showSeriesToggle && (
            <PillBar bar={bar} isDark={isDark} faded={!isMultiSeries}>
              {(lastSeriesPropRef.current ?? []).map((s, si) => {
                const isHidden = hiddenSeries.has(s.id);
                const seriesColor =
                  s.color || SERIES_COLORS[si % SERIES_COLORS.length]!;
                return (
                  <Pressable
                    key={s.id}
                    onPress={() => handleSeriesToggle(s.id)}
                    style={[chip.base, isHidden && chip.off]}
                  >
                    <View
                      style={[
                        chip.dot,
                        { backgroundColor: seriesColor },
                        isHidden && styles.dimmed,
                      ]}
                    />
                    {!seriesToggleCompact && (
                      <Animated.Text
                        style={isHidden ? chip.labelOff : chip.label}
                      >
                        {s.label ?? s.id}
                      </Animated.Text>
                    )}
                  </Pressable>
                );
              })}
            </PillBar>
          )}
        </View>
      )}

      <GestureDetector gesture={engine.gesture}>
        <View
          onLayout={engine.onLayout}
          style={[styles.container, style]}
          collapsable={false}
        >
          {/*
            Fixed 4-node tree — never reconciled after mount. Every per-frame
            update is a shared-value *prop* change, which Skia's
            NativeReanimatedContainer applies from a Reanimated mapper on the
            UI thread; only a *structural* change would force a JS-thread
            redraw(). Keep it that way: no conditionals, no .map(), nothing
            that can add or remove a node, or the chart stops animating while
            the JS thread is blocked.

            Two <Canvas> props are deliberately NOT set here:

            - `androidWarmup` — do not enable. It exists to hide a first-frame
              flash, but SkiaPictureView.java implements it as a GPU→CPU pixel
              readback inside onDraw (getBitmap -> int[] -> Bitmap.createBitmap
              -> drawBitmap). On a view that invalidates continuously, as this
              one does, that is catastrophic.
            - `opaque` — leaving it false is what makes react-native-skia back
              this view with a TextureView rather than a SurfaceView (see
              SkiaBaseView.setOpaque). SurfaceView would very likely composite
              cheaper on Android, but an opaque surface has no destination
              alpha, and both drawEdgeFade and drawEmpty composite with
              `destination-out` — on an opaque surface those erase to black
              instead of to transparent. Exposing `opaque` as an opt-in for
              consumers who sit the chart on a solid background is a real
              option; flipping it by default is not.
          */}
          <Canvas style={styles.canvas}>
            <Group transform={engine.scrollTransform}>
              <Picture picture={engine.scrollPicture} />
            </Group>
            <Picture picture={engine.screenPicture} />
          </Canvas>
        </View>
      </GestureDetector>
    </>
  );
});

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
  barFaded: {
    opacity: 0,
  },
  dimmed: {
    opacity: 0.4,
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
