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
import type {
  LivelineProps,
  Momentum,
  DegenOptions,
  WindowOption,
} from './types';
import { resolveTheme, resolveSeriesPalettes, SERIES_COLORS } from './theme';
import { makeDefaultFonts } from './draw/fonts';
import { useLivelineEngine } from './useLivelineEngine';
import { resolveLiveValue } from './a11y/announce';
import {
  useAccessibleValue,
  useScreenReaderEnabled,
} from './a11y/useAccessibleValue';

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

/**
 * `useMemo` keyed by an explicit signature instead of a dependency array.
 *
 * A live chart re-renders on every tick, and consumers build most array props
 * inline, so those arrays are a new *identity* every tick even when nothing in
 * them changed. Projecting them through here gives the control bars props that
 * are referentially stable, which is what lets their `memo` actually bail out.
 */
function useStableValue<T>(signature: string, build: () => T): T {
  const ref = useRef<{ signature: string; value: T } | null>(null);
  if (ref.current === null || ref.current.signature !== signature) {
    ref.current = { signature, value: build() };
  }
  return ref.current.value;
}

/**
 * A referentially stable wrapper around an optional consumer callback. Same
 * reasoning as `useStableValue`: `onModeChange` &co. are typically inline
 * arrows, so they are a new function on every consumer render. The wrapper is
 * created once and always dispatches to the latest prop.
 */
function useStableHandler<A extends unknown[]>(
  fn: ((...args: A) => void) | undefined
) {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current?.(...args), []);
}

/**
 * State for the built-in window selector. Only meaningful when `windows` is
 * supplied; otherwise the `window` prop stays authoritative and this state
 * sits inert (kept mounted so it survives `windows` appearing later).
 */
function useActiveWindow(
  windows: WindowOption[] | undefined,
  windowSecs: number,
  onWindowChange: ((secs: number) => void) | undefined
) {
  const [activeWindowSecs, setActiveWindowSecs] = useState(
    windows && windows.length > 0 ? windows[0]!.secs : windowSecs
  );
  const notify = useStableHandler(onWindowChange);
  const selectWindow = useCallback(
    (secs: number) => {
      setActiveWindowSecs(secs);
      notify(secs);
    },
    [notify]
  );
  return {
    activeWindowSecs,
    effectiveWindowSecs: windows ? activeWindowSecs : windowSecs,
    selectWindow,
  };
}

/** Which series the user has toggled off, plus the engine-facing id list. */
function useHiddenSeries(
  seriesCount: number,
  onSeriesToggle: ((id: string, visible: boolean) => void) | undefined
) {
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());
  const notify = useStableHandler(onSeriesToggle);
  // Read through a ref so the toggle handler stays referentially stable as
  // series come and go — it crosses the `memo` boundary into the chip bar.
  const countRef = useRef(seriesCount);
  countRef.current = seriesCount;

  const toggleSeries = useCallback(
    (id: string) => {
      setHiddenSeries((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
          notify(id, true);
        } else {
          // Count visible series — don't hide last one
          const visibleCount = countRef.current - next.size;
          if (visibleCount <= 1) return prev;
          next.add(id);
          notify(id, false);
        }
        return next;
      });
    },
    [notify]
  );

  const hiddenSeriesIds = useMemo(() => [...hiddenSeries], [hiddenSeries]);

  return { hiddenSeries, hiddenSeriesIds, toggleSeries };
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
      // A faded bar is invisible and untappable but still mounted, so it must
      // also be invisible to a screen reader — otherwise the reader offers
      // controls the sighted user cannot see and nobody can activate.
      accessibilityElementsHidden={faded}
      importantForAccessibility={faded ? 'no-hide-descendants' : 'auto'}
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

/** Time-window selector. Owns the button layouts its indicator tracks. */
const WindowBar = memo(function WindowBarComponent({
  bar,
  isDark,
  windows,
  activeSecs,
  onSelect,
  testID,
}: {
  bar: BarStyle;
  isDark: boolean;
  windows: WindowOption[];
  activeSecs: number;
  onSelect: (secs: number) => void;
  testID: string | undefined;
}) {
  const [layouts, setLayouts] = useState<Record<number, BtnLayout>>({});
  const onBtnLayout = useCallback((secs: number, e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    setLayouts((prev) => {
      const cur = prev[secs];
      if (cur && cur.x === x && cur.width === width) return prev;
      return { ...prev, [secs]: { x, width } };
    });
  }, []);

  return (
    <PillBar
      bar={bar}
      isDark={isDark}
      indicator
      indicatorLayout={layouts[activeSecs]}
    >
      {windows.map((w) => {
        const isActive = w.secs === activeSecs;
        return (
          <Pressable
            key={w.secs}
            onLayout={(e) => onBtnLayout(w.secs, e)}
            onPress={() => onSelect(w.secs)}
            accessibilityRole="button"
            accessibilityLabel={`${w.label} time window`}
            accessibilityState={{ selected: isActive }}
            testID={testID ? `${testID}-window-${w.secs}` : undefined}
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
  );
});

/** Line/candle mode toggle — its own bar with its own sliding indicator. */
const ModeBar = memo(function ModeBarComponent({
  bar,
  isDark,
  activeMode,
  onSelect,
  testID,
}: {
  bar: BarStyle;
  isDark: boolean;
  activeMode: 'line' | 'candle';
  onSelect: (mode: 'line' | 'candle') => void;
  testID: string | undefined;
}) {
  const [layouts, setLayouts] = useState<Record<string, BtnLayout>>({});
  const onBtnLayout = useCallback((key: string, e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    setLayouts((prev) => {
      const cur = prev[key];
      if (cur && cur.x === x && cur.width === width) return prev;
      return { ...prev, [key]: { x, width } };
    });
  }, []);

  return (
    <PillBar
      bar={bar}
      isDark={isDark}
      indicator
      indicatorLayout={layouts[activeMode]}
    >
      {/*
        Icon-only buttons: there is no text child for a screen reader to fall
        back on, so an explicit label is the only thing standing between a
        reader user and an unnamed button.
      */}
      <Pressable
        onLayout={(e) => onBtnLayout('line', e)}
        onPress={() => onSelect('line')}
        accessibilityRole="button"
        accessibilityLabel="Line chart"
        accessibilityState={{ selected: activeMode === 'line' }}
        testID={testID ? `${testID}-mode-line` : undefined}
        style={[styles.iconBtn, bar.iconBtn]}
      >
        <LineIcon
          color={activeMode === 'line' ? bar.activeColor : bar.inactiveColor}
          active={activeMode === 'line'}
        />
      </Pressable>
      <Pressable
        onLayout={(e) => onBtnLayout('candle', e)}
        onPress={() => onSelect('candle')}
        accessibilityRole="button"
        accessibilityLabel="Candlestick chart"
        accessibilityState={{ selected: activeMode === 'candle' }}
        testID={testID ? `${testID}-mode-candle` : undefined}
        style={[styles.iconBtn, bar.iconBtn]}
      >
        <CandleIcon
          color={activeMode === 'candle' ? bar.activeColor : bar.inactiveColor}
        />
      </Pressable>
    </PillBar>
  );
});

/**
 * What a series chip needs to draw itself — deliberately *not* the series
 * itself, whose `data`/`value` change on every tick.
 */
interface SeriesChip {
  id: string;
  label: string;
  color: string;
}

/**
 * Series toggle chips. No sliding indicator — chips toggle independently, so
 * there is no single "active" one to track.
 */
const SeriesChipBar = memo(function SeriesChipBarComponent({
  bar,
  chip,
  isDark,
  chips,
  hidden,
  compact,
  faded,
  onToggle,
  testID,
}: {
  bar: BarStyle;
  chip: ReturnType<typeof useChipStyle>;
  isDark: boolean;
  chips: SeriesChip[];
  hidden: Set<string>;
  compact: boolean;
  /** Keep the chips mounted but invisible (chart left multi-series mode). */
  faded: boolean;
  onToggle: (id: string) => void;
  testID: string | undefined;
}) {
  return (
    <PillBar bar={bar} isDark={isDark} faded={faded}>
      {chips.map((s) => {
        const isHidden = hidden.has(s.id);
        return (
          <Pressable
            key={s.id}
            onPress={() => onToggle(s.id)}
            // A chip is a toggle, and in compact mode it is a bare coloured
            // dot with no text at all — so it always carries its own label.
            accessibilityRole="checkbox"
            accessibilityLabel={s.label}
            accessibilityState={{ checked: !isHidden }}
            testID={testID ? `${testID}-series-${s.id}` : undefined}
            style={[chip.base, isHidden && chip.off]}
          >
            <View
              style={[
                chip.dot,
                { backgroundColor: s.color },
                isHidden && styles.dimmed,
              ]}
            />
            {!compact && (
              <Animated.Text style={isHidden ? chip.labelOff : chip.label}>
                {s.label}
              </Animated.Text>
            )}
          </Pressable>
        );
      })}
    </PillBar>
  );
});

/**
 * The whole controls row, above the chart.
 *
 * Memoized, and this is the point of the whole file's shape: a live tick hands
 * `Liveline` a new `data` array every frame, so `Liveline` itself re-renders
 * constantly. None of the props below change on a tick, so React bails out
 * here and the three bars, their style hooks and their `<Canvas>` icons are
 * skipped entirely. Nothing tick-varying may be added to this prop list.
 */
const LivelineControls = memo(function LivelineControlsComponent({
  windowStyle,
  isDark,
  padLeft,
  windows,
  activeWindowSecs,
  onWindowSelect,
  showModeToggle,
  activeMode,
  onModeSelect,
  showSeriesToggle,
  seriesChips,
  seriesFaded,
  hiddenSeries,
  seriesToggleCompact,
  onSeriesToggle,
  testID,
}: {
  windowStyle: WindowStyle;
  isDark: boolean;
  padLeft: number;
  windows: WindowOption[] | undefined;
  activeWindowSecs: number;
  onWindowSelect: (secs: number) => void;
  showModeToggle: boolean;
  activeMode: 'line' | 'candle';
  onModeSelect: (mode: 'line' | 'candle') => void;
  showSeriesToggle: boolean;
  seriesChips: SeriesChip[];
  seriesFaded: boolean;
  hiddenSeries: Set<string>;
  seriesToggleCompact: boolean;
  onSeriesToggle: (id: string) => void;
  /** Base id the per-control test ids are derived from (see `Liveline`). */
  testID: string | undefined;
}) {
  const bar = useBarStyle(windowStyle, isDark);
  const chip = useChipStyle(bar, isDark, seriesToggleCompact);

  const showWindows = windows != null && windows.length > 0;
  if (!showWindows && !showModeToggle && !showSeriesToggle) return null;

  return (
    <View style={[styles.controlsRow, { marginLeft: padLeft }]}>
      {showWindows && (
        <WindowBar
          bar={bar}
          isDark={isDark}
          windows={windows}
          activeSecs={activeWindowSecs}
          onSelect={onWindowSelect}
          testID={testID}
        />
      )}

      {showModeToggle && (
        <ModeBar
          bar={bar}
          isDark={isDark}
          activeMode={activeMode}
          onSelect={onModeSelect}
          testID={testID}
        />
      )}

      {showSeriesToggle && (
        <SeriesChipBar
          bar={bar}
          chip={chip}
          isDark={isDark}
          chips={seriesChips}
          hidden={hiddenSeries}
          compact={seriesToggleCompact}
          faded={seriesFaded}
          onToggle={onSeriesToggle}
          testID={testID}
        />
      )}
    </View>
  );
});

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
  accessibilityLabel,
  testID,
  style,
}: LivelineProps) {
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

  const { activeWindowSecs, effectiveWindowSecs, selectWindow } =
    useActiveWindow(windows, windowSecs, onWindowChange);

  const { hiddenSeries, hiddenSeriesIds, toggleSeries } = useHiddenSeries(
    seriesProp?.length ?? 0,
    onSeriesToggle
  );

  const ws = windowStyle ?? 'default';

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

  const activeMode = lineMode ? 'line' : 'candle';

  // --- Controls-row props ---------------------------------------------------
  // Everything below exists to keep <LivelineControls/> memo-stable across a
  // tick: consumers rebuild `windows`/`series` inline and pass inline arrow
  // callbacks, so those identities churn even when their contents do not.
  const windowsSignature = windows
    ? `${windows.length}|${windows.map((w) => `${w.secs} ${w.label}`).join('')}`
    : '';
  const stableWindows = useStableValue(windowsSignature, () => windows);

  const chipSource = lastSeriesPropRef.current;
  const chipSignature = chipSource
    ? `${chipSource.length}|${chipSource
        .map((s) => `${s.id} ${s.label ?? ''} ${s.color ?? ''}`)
        .join('')}`
    : '';
  const seriesChips = useStableValue(chipSignature, () =>
    (chipSource ?? []).map((s, si) => ({
      id: s.id,
      label: s.label ?? s.id,
      color: s.color || SERIES_COLORS[si % SERIES_COLORS.length]!,
    }))
  );

  const selectMode = useStableHandler(onModeChange);

  // --- Accessibility --------------------------------------------------------
  // The chart is a Skia surface: without this a screen reader finds an
  // unlabelled blank rectangle. The live number is a UI-thread shared value
  // updated at frame rate, and accessibility props are JS-thread React props,
  // so there is deliberately no per-frame bridge between them. Instead the
  // reading is taken from the props already on this thread (`value` &co.) and
  // sampled at a speakable ~1Hz — and only while a reader is actually running.
  //
  // With no reader (the overwhelmingly common case) `screenReader` is false,
  // `resolveLiveValue` is never called, no timer exists, no state is committed
  // and `chartA11yValue` is a stable `undefined`: the cost is one boolean test
  // per render. Nothing here can make the chart re-render on tick.
  const screenReader = useScreenReaderEnabled();
  const chartA11yValue = useAccessibleValue(
    screenReader,
    screenReader
      ? resolveLiveValue({
          value,
          mode,
          lineMode,
          lineValue,
          liveCandle,
          candles,
        })
      : null,
    formatValue
  );

  return (
    <>
      {/* Live value display — above the chart */}
      {showValue && (
        <AnimatedTextInput
          editable={false}
          // Hidden from assistive tech on purpose. It is a TextInput driven
          // from the UI thread at frame rate, so a reader would announce it as
          // a text field whose contents change 60 times a second. The same
          // number reaches the reader through the chart's accessibilityValue,
          // at a cadence a person can actually follow.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          animatedProps={valueProps}
          style={[styles.valueDisplay, { paddingLeft: pad.left }, valueStyle]}
        />
      )}

      {/*
        Control bars row — window pills + mode toggle + series chips side by
        side. The chips are driven by lastSeriesPropRef (not seriesProp) and
        merely faded out when the chart leaves multi-series mode: unmounting
        the bar would reflow the controls row and drop the hidden-series state.
      */}
      <LivelineControls
        windowStyle={ws}
        isDark={isDark}
        padLeft={pad.left}
        windows={stableWindows}
        activeWindowSecs={activeWindowSecs}
        onWindowSelect={selectWindow}
        showModeToggle={onModeChange != null}
        activeMode={activeMode}
        onModeSelect={selectMode}
        showSeriesToggle={showSeriesToggle}
        seriesChips={seriesChips}
        seriesFaded={!isMultiSeries}
        hiddenSeries={hiddenSeries}
        seriesToggleCompact={seriesToggleCompact}
        onSeriesToggle={toggleSeries}
        testID={testID}
      />

      <GestureDetector gesture={engine.gesture}>
        <View
          onLayout={engine.onLayout}
          style={[styles.container, style]}
          collapsable={false}
          // Accessibility lives out here, on the container — never inside the
          // Skia subtree below, whose node structure must stay fixed.
          // `image` is React Native's conventional role for a rendered
          // graphic; there is no chart role.
          accessible
          accessibilityRole="image"
          accessibilityLabel={accessibilityLabel ?? 'Live chart'}
          accessibilityValue={chartA11yValue}
          testID={testID}
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
