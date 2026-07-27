/* eslint-disable react-native/no-inline-styles -- control styles are theme/prop-derived, mirrors upstream web demo controls */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Liveline } from '@ajfuller/react-native-liveline';
import type {
  LivelinePoint,
  WindowStyle,
  BadgeVariant,
} from '@ajfuller/react-native-liveline';
import { useAppTheme } from '../AppTheme';
import {
  generatePoint,
  SIZE_VARIANTS,
  TIME_WINDOWS,
  TICK_RATES,
  VOLATILITIES,
  type Volatility,
} from '../demoData';
import {
  Btn,
  ChartFrame,
  Label,
  ScreenTitle,
  Section,
  Sep,
  StatusBar,
  Toggle,
} from '../ui';
import { fg } from '../uiStyle';

type Scenario = 'loading' | 'loading-hold' | 'live' | 'empty';

const DEGEN_SCALES = [0.5, 1, 2, 4];

interface DegenOptions {
  scale: number;
  downMomentum: boolean;
}

/**
 * "Features" + "Degen" toggle panels — pulled out of BasicLineSection to keep
 * it readable. Memoized: every prop here is a stable useState setter or a
 * boolean/enum that only changes on user input, never on the per-tick
 * setData/setValue calls driving the chart above, so this actually skips
 * re-rendering on ticks instead of just relocating the render.
 */
const FeatureControls = memo(function FeatureControlsImpl({
  grid,
  setGrid,
  fill,
  setFill,
  badge,
  setBadge,
  badgeVariant,
  setBadgeVariant,
  momentum,
  setMomentum,
  pulse,
  setPulse,
  scrub,
  setScrub,
  exaggerate,
  setExaggerate,
  degen,
  setDegen,
  degenDown,
  setDegenDown,
  degenScale,
  setDegenScale,
}: {
  grid: boolean;
  setGrid: (v: boolean) => void;
  fill: boolean;
  setFill: (v: boolean) => void;
  badge: boolean;
  setBadge: (v: boolean) => void;
  badgeVariant: BadgeVariant;
  setBadgeVariant: (v: BadgeVariant) => void;
  momentum: boolean;
  setMomentum: (v: boolean) => void;
  pulse: boolean;
  setPulse: (v: boolean) => void;
  scrub: boolean;
  setScrub: (v: boolean) => void;
  exaggerate: boolean;
  setExaggerate: (v: boolean) => void;
  degen: boolean;
  setDegen: (v: boolean) => void;
  degenDown: boolean;
  setDegenDown: (v: boolean) => void;
  degenScale: number;
  setDegenScale: (v: number) => void;
}) {
  return (
    <>
      <Section label="Features">
        <Toggle on={grid} onToggle={setGrid}>
          Grid
        </Toggle>
        <Toggle on={fill} onToggle={setFill}>
          Fill
        </Toggle>
        <Toggle on={badge} onToggle={setBadge}>
          Badge
        </Toggle>
        <Toggle on={momentum} onToggle={setMomentum}>
          Momentum
        </Toggle>
        <Toggle on={pulse} onToggle={setPulse}>
          Pulse
        </Toggle>
        <Toggle on={scrub} onToggle={setScrub}>
          Scrub
        </Toggle>
        <Toggle on={exaggerate} onToggle={setExaggerate}>
          Exaggerate
        </Toggle>
        <Sep />
        <Label text="Badge style">
          <Btn
            active={badgeVariant === 'default'}
            onPress={() => setBadgeVariant('default')}
          >
            Default
          </Btn>
          <Btn
            active={badgeVariant === 'minimal'}
            onPress={() => setBadgeVariant('minimal')}
          >
            Minimal
          </Btn>
        </Label>
      </Section>

      <Section label="Degen">
        <Toggle on={degen} onToggle={setDegen}>
          Enable
        </Toggle>
        {degen && (
          <>
            <Sep />
            <Toggle on={degenDown} onToggle={setDegenDown}>
              Down momentum
            </Toggle>
            <Sep />
            <Label text="Scale">
              {DEGEN_SCALES.map((s) => (
                <Btn
                  key={s}
                  active={degenScale === s}
                  onPress={() => setDegenScale(s)}
                >
                  {s}x
                </Btn>
              ))}
            </Label>
          </>
        )}
      </Section>
    </>
  );
});

/**
 * Mini-chart grid at several fixed sizes — ported from dev/main.tsx lines 285-326.
 * Deliberately NOT memoized: `data` and `value` change on every simulated
 * tick, so a React.memo wrapper here would fail its shallow comparison every
 * render anyway and just add a wasted check.
 */
function SizeVariants({
  isDark,
  data,
  value,
  theme,
  accent,
  windowSecs,
  loading,
  paused,
  badge,
  badgeVariant,
  momentum,
  fill,
  grid,
  scrub,
  pulse,
  exaggerate,
  degenOpts,
}: {
  isDark: boolean;
  data: LivelinePoint[];
  value: number;
  theme: 'dark' | 'light';
  accent: string;
  windowSecs: number;
  loading: boolean;
  paused: boolean;
  badge: boolean;
  badgeVariant: BadgeVariant;
  momentum: boolean;
  fill: boolean;
  grid: boolean;
  scrub: boolean;
  pulse: boolean;
  exaggerate: boolean;
  degenOpts: DegenOptions | undefined;
}) {
  return (
    <>
      <Text
        style={{
          fontSize: 12,
          color: fg(isDark, 0.3),
          marginTop: 24,
          marginBottom: 8,
        }}
      >
        Size variants
      </Text>
      <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
        {SIZE_VARIANTS.map((size) => (
          <View key={size.label}>
            <Text
              style={{
                fontSize: 12,
                color: fg(isDark, 0.25),
                marginBottom: 4,
              }}
            >
              {size.label}
            </Text>
            <View
              style={{
                width: size.w,
                height: size.h,
                backgroundColor: fg(isDark, 0.02),
                borderRadius: 8,
                borderWidth: 1,
                borderColor: fg(isDark, 0.06),
                overflow: 'hidden',
              }}
            >
              <Liveline
                data={data}
                value={value}
                theme={theme}
                color={accent}
                window={windowSecs}
                loading={loading}
                paused={paused}
                badge={badge && size.w >= 200}
                badgeVariant={badgeVariant}
                momentum={momentum && size.w >= 200}
                fill={fill}
                grid={grid && size.w >= 200}
                scrub={scrub}
                pulse={pulse}
                exaggerate={exaggerate}
                degen={degenOpts}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        ))}
      </View>
    </>
  );
}

export function BasicLineSection() {
  const { isDark, accent } = useAppTheme();
  const theme = isDark ? 'dark' : 'light';

  const [data, setData] = useState<LivelinePoint[]>([]);
  const [value, setValue] = useState(100);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [scenario, setScenario] = useState<Scenario>('loading');

  const [windowSecs, setWindowSecs] = useState(30);
  const [degen, setDegen] = useState(false);
  const [degenScale, setDegenScale] = useState(1);
  const [degenDown, setDegenDown] = useState(false);
  const [fill, setFill] = useState(true);
  const [grid, setGrid] = useState(true);
  const [badge, setBadge] = useState(true);
  const [badgeVariant, setBadgeVariant] = useState<BadgeVariant>('default');
  const [momentum, setMomentum] = useState(true);
  const [pulse, setPulse] = useState(true);
  const [scrub, setScrub] = useState(true);
  const [exaggerate, setExaggerate] = useState(false);
  const [windowStyle, setWindowStyle] = useState<WindowStyle>('default');
  const [lineMode, setLineMode] = useState(true);

  const [volatility, setVolatility] = useState<Volatility>('normal');
  const [tickRate, setTickRate] = useState(300);

  const intervalRef = useRef<ReturnType<typeof setInterval>>(0);
  const volatilityRef = useRef(volatility);
  useEffect(() => {
    volatilityRef.current = volatility;
  }, [volatility]);
  const lastValueRef = useRef(100);

  const startLive = useCallback(() => {
    clearInterval(intervalRef.current);
    setLoading(false);

    const now = Date.now() / 1000;
    const seed: LivelinePoint[] = [];
    let v = 100;
    for (let i = 60; i >= 0; i--) {
      const pt = generatePoint(v, now - i * 0.5, volatilityRef.current);
      seed.push(pt);
      v = pt.value;
    }
    setData(seed);
    setValue(v);
    lastValueRef.current = v;

    intervalRef.current = setInterval(() => {
      const now2 = Date.now() / 1000;
      const pt = generatePoint(
        lastValueRef.current,
        now2,
        volatilityRef.current
      );
      lastValueRef.current = pt.value;
      setValue(pt.value);
      setData((prev) => {
        const next = [...prev, pt];
        return next.length > 500 ? next.slice(-500) : next;
      });
    }, tickRate);
  }, [tickRate]);

  useEffect(() => {
    if (scenario === 'loading') {
      setLoading(true);
      setData([]);
      clearInterval(intervalRef.current);
      const timer = setTimeout(() => setScenario('live'), 3000);
      return () => clearTimeout(timer);
    }

    if (scenario === 'loading-hold') {
      setLoading(true);
      setData([]);
      clearInterval(intervalRef.current);
      return;
    }

    if (scenario === 'empty') {
      setLoading(false);
      setData([]);
      clearInterval(intervalRef.current);
      return;
    }

    startLive();
    return () => clearInterval(intervalRef.current);
  }, [scenario, startLive]);

  // Restart interval when tick rate changes while live
  useEffect(() => {
    if (scenario !== 'live') return;
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      const now = Date.now() / 1000;
      const pt = generatePoint(
        lastValueRef.current,
        now,
        volatilityRef.current
      );
      lastValueRef.current = pt.value;
      setValue(pt.value);
      setData((prev) => {
        const next = [...prev, pt];
        return next.length > 500 ? next.slice(-500) : next;
      });
    }, tickRate);
    return () => clearInterval(intervalRef.current);
  }, [tickRate, scenario]);

  const degenOpts = degen
    ? { scale: degenScale, downMomentum: degenDown }
    : undefined;

  return (
    <View>
      <ScreenTitle title="Basic Line" subtitle="Streaming random-walk data" />

      <Section label="State">
        <Btn
          active={scenario === 'loading'}
          onPress={() => setScenario('loading')}
        >
          Loading → Live
        </Btn>
        <Btn
          active={scenario === 'loading-hold'}
          onPress={() => setScenario('loading-hold')}
        >
          Loading
        </Btn>
        <Btn active={scenario === 'live'} onPress={() => setScenario('live')}>
          Live
        </Btn>
        <Btn active={scenario === 'empty'} onPress={() => setScenario('empty')}>
          No Data
        </Btn>
        <Sep />
        <Btn active={paused} onPress={() => setPaused((p) => !p)}>
          {paused ? '▶ Play' : '⏸ Pause'}
        </Btn>
      </Section>

      <Section label="Data">
        <Label text="Volatility">
          {VOLATILITIES.map((v) => (
            <Btn
              key={v}
              active={volatility === v}
              onPress={() => setVolatility(v)}
            >
              {v}
            </Btn>
          ))}
        </Label>
        <Sep />
        <Label text="Tick rate">
          {TICK_RATES.map((t) => (
            <Btn
              key={t.ms}
              active={tickRate === t.ms}
              onPress={() => setTickRate(t.ms)}
            >
              {t.label}
            </Btn>
          ))}
        </Label>
      </Section>

      <Section label="Window">
        {TIME_WINDOWS.map((w) => (
          <Btn
            key={w.secs}
            active={windowSecs === w.secs}
            onPress={() => setWindowSecs(w.secs)}
          >
            {w.label}
          </Btn>
        ))}
        <Sep />
        <Label text="Style">
          <Btn
            active={windowStyle === 'default'}
            onPress={() => setWindowStyle('default')}
          >
            Default
          </Btn>
          <Btn
            active={windowStyle === 'rounded'}
            onPress={() => setWindowStyle('rounded')}
          >
            Rounded
          </Btn>
          <Btn
            active={windowStyle === 'text'}
            onPress={() => setWindowStyle('text')}
          >
            Text
          </Btn>
        </Label>
      </Section>

      <FeatureControls
        grid={grid}
        setGrid={setGrid}
        fill={fill}
        setFill={setFill}
        badge={badge}
        setBadge={setBadge}
        badgeVariant={badgeVariant}
        setBadgeVariant={setBadgeVariant}
        momentum={momentum}
        setMomentum={setMomentum}
        pulse={pulse}
        setPulse={setPulse}
        scrub={scrub}
        setScrub={setScrub}
        exaggerate={exaggerate}
        setExaggerate={setExaggerate}
        degen={degen}
        setDegen={setDegen}
        degenDown={degenDown}
        setDegenDown={setDegenDown}
        degenScale={degenScale}
        setDegenScale={setDegenScale}
      />

      <ChartFrame height={320}>
        <Liveline
          data={data}
          value={value}
          theme={theme}
          color={accent}
          window={windowSecs}
          loading={loading}
          paused={paused}
          badge={badge}
          badgeVariant={badgeVariant}
          momentum={momentum}
          fill={fill}
          grid={grid}
          scrub={scrub}
          pulse={pulse}
          exaggerate={exaggerate}
          degen={degenOpts}
          windows={TIME_WINDOWS}
          onWindowChange={setWindowSecs}
          windowStyle={windowStyle}
          lineMode={lineMode}
          onModeChange={(m) => setLineMode(m === 'line')}
          style={{ flex: 1 }}
        />
      </ChartFrame>

      <SizeVariants
        isDark={isDark}
        data={data}
        value={value}
        theme={theme}
        accent={accent}
        windowSecs={windowSecs}
        loading={loading}
        paused={paused}
        badge={badge}
        badgeVariant={badgeVariant}
        momentum={momentum}
        fill={fill}
        grid={grid}
        scrub={scrub}
        pulse={pulse}
        exaggerate={exaggerate}
        degenOpts={degenOpts}
      />

      <StatusBar
        items={[
          `points: ${data.length}`,
          `loading: ${String(loading)}`,
          `paused: ${String(paused)}`,
          `value: ${value.toFixed(2)}`,
          `window: ${windowSecs}s`,
          `tick: ${tickRate}ms`,
          `volatility: ${volatility}`,
        ]}
      />
    </View>
  );
}
