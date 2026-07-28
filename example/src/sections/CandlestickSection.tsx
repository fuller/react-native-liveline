/* eslint-disable react-native/no-inline-styles -- control styles are theme/prop-derived, mirrors upstream web demo controls */
import {
  memo,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Text, View } from 'react-native';
import { Liveline } from '@ajfuller/react-native-liveline';
import type {
  CandlePoint,
  LivelinePoint,
} from '@ajfuller/react-native-liveline';
import { useAppTheme } from '../AppTheme';
import {
  CANDLE_WIDTHS,
  CRYPTO_WINDOWS,
  SIZE_VARIANTS,
  TICK_RATES,
  TIME_WINDOWS,
  VOLATILITIES,
  aggregateCandles,
  formatCrypto,
  generatePoint,
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

type Preset = 'dev' | 'crypto';
type Scenario = 'loading' | 'loading-hold' | 'live' | 'empty';
type ChartType = 'line' | 'candle';

const CRYPTO_COLOR = '#f7931a';

// Candle array retention — independent of the tick/`data` buffer size below.
// The widest window either preset actually displays is crypto's 3600s at
// 60s candles (60 candles) or dev's 300s at 2s candles (150 candles); 400
// gives generous headroom without dragging the full 1200/4000-tick buffer
// size across the delta-mirror boundary and re-filtering it every frame.
const MAX_CANDLES = 400;

/** The subset of settings that always reset together on a preset switch. */
interface ConfigState {
  startValue: number;
  tickRate: number;
  candleSecs: number;
  windowSecs: number;
  volatility: Volatility;
  chartType: ChartType;
}

const PRESET_CONFIG: Record<Preset, ConfigState> = {
  dev: {
    startValue: 100,
    tickRate: 300,
    candleSecs: 2,
    windowSecs: 30,
    volatility: 'normal',
    chartType: 'candle',
  },
  crypto: {
    startValue: 65000,
    tickRate: 1000,
    candleSecs: 60,
    windowSecs: 300,
    volatility: 'calm',
    chartType: 'candle',
  },
};

type ConfigAction =
  | { type: 'preset'; preset: Preset }
  | { type: 'set'; patch: Partial<ConfigState> };

function configReducer(state: ConfigState, action: ConfigAction): ConfigState {
  switch (action.type) {
    case 'preset':
      return PRESET_CONFIG[action.preset];
    case 'set':
      return { ...state, ...action.patch };
  }
}

/**
 * Simulated live tick + OHLC candle feed for the Candlestick demo.
 * Encapsulates the setInterval-driven generator, its scenario/preset
 * lifecycle, and the refs that let the interval callback read fresh
 * config without restarting the interval every render.
 */
function useCandlestickFeed() {
  const [config, dispatchConfig] = useReducer(configReducer, PRESET_CONFIG.dev);
  const { startValue, tickRate, candleSecs, volatility } = config;

  const [data, setData] = useState<LivelinePoint[]>([]);
  const [value, setValue] = useState(100);
  const [loading, setLoading] = useState(true);
  const [scenario, setScenario] = useState<Scenario>('loading');
  const [candles, setCandles] = useState<CandlePoint[]>([]);
  const [liveCandle, setLiveCandle] = useState<CandlePoint | null>(null);

  const candleSecsRef = useRef(candleSecs);
  const lastValueRef = useRef(100);
  const liveCandleRef = useRef<CandlePoint | null>(null);
  const dataRef = useRef<LivelinePoint[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(0);
  const volatilityRef = useRef(volatility);
  const startValueRef = useRef(startValue);
  // Tick buffer covers widest window: crypto 1h=3600 ticks, dev 5m≈1000 ticks
  const maxTicksRef = useRef(1200);

  useEffect(() => {
    candleSecsRef.current = candleSecs;
  }, [candleSecs]);
  useEffect(() => {
    volatilityRef.current = volatility;
  }, [volatility]);
  useEffect(() => {
    startValueRef.current = startValue;
  }, [startValue]);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const tickAndAggregate = (pt: LivelinePoint) => {
    const width = candleSecsRef.current;
    const lc = liveCandleRef.current;
    if (!lc) {
      const slot = Math.floor(pt.time / width) * width;
      liveCandleRef.current = {
        time: slot,
        open: pt.value,
        high: pt.value,
        low: pt.value,
        close: pt.value,
      };
      setLiveCandle({ ...liveCandleRef.current });
    } else if (pt.time >= lc.time + width) {
      const committed = { ...lc };
      setCandles((prev) => {
        const next = [...prev, committed];
        return next.length > MAX_CANDLES ? next.slice(-MAX_CANDLES) : next;
      });
      const slot = Math.floor(pt.time / width) * width;
      liveCandleRef.current = {
        time: slot,
        open: pt.value,
        high: pt.value,
        low: pt.value,
        close: pt.value,
      };
      setLiveCandle({ ...liveCandleRef.current });
    } else {
      lc.close = pt.value;
      if (pt.value > lc.high) lc.high = pt.value;
      if (pt.value < lc.low) lc.low = pt.value;
      setLiveCandle({ ...lc });
    }
  };

  const startLive = useCallback(() => {
    clearInterval(intervalRef.current);
    setLoading(false);

    const now = Date.now() / 1000;
    const base = startValueRef.current;
    const isCrypto = base > 1000;
    const seedTickInterval = isCrypto ? 1 : 0.3;
    // Cover the widest time window with margin: crypto 1h=3600s, dev 5m=300s
    const seedCount = isCrypto ? 3800 : 500;
    const seed: LivelinePoint[] = [];
    let v = base;
    for (let i = seedCount; i >= 0; i--) {
      const pt = generatePoint(
        v,
        now - i * seedTickInterval,
        volatilityRef.current,
        base
      );
      seed.push(pt);
      v = pt.value;
    }
    setData(seed);
    dataRef.current = seed;
    setValue(v);
    lastValueRef.current = v;

    const agg = aggregateCandles(seed, candleSecsRef.current);
    setCandles(agg.candles);
    setLiveCandle(agg.live);
    liveCandleRef.current = agg.live ? { ...agg.live } : null;

    intervalRef.current = setInterval(() => {
      const now2 = Date.now() / 1000;
      const pt = generatePoint(
        lastValueRef.current,
        now2,
        volatilityRef.current,
        startValueRef.current
      );
      lastValueRef.current = pt.value;
      setValue(pt.value);
      setData((prev) => {
        const next = [...prev, pt];
        return next.length > maxTicksRef.current
          ? next.slice(-maxTicksRef.current)
          : next;
      });
      tickAndAggregate(pt);
    }, tickRate);
  }, [tickRate]);

  useEffect(() => {
    if (scenario === 'loading') {
      setLoading(true);
      setData([]);
      dataRef.current = [];
      setCandles([]);
      setLiveCandle(null);
      liveCandleRef.current = null;
      clearInterval(intervalRef.current);
      const timer = setTimeout(() => setScenario('live'), 3000);
      return () => clearTimeout(timer);
    }

    if (scenario === 'loading-hold') {
      setLoading(true);
      setData([]);
      dataRef.current = [];
      setCandles([]);
      setLiveCandle(null);
      liveCandleRef.current = null;
      clearInterval(intervalRef.current);
      return;
    }

    if (scenario === 'empty') {
      setLoading(false);
      setData([]);
      dataRef.current = [];
      setCandles([]);
      setLiveCandle(null);
      liveCandleRef.current = null;
      clearInterval(intervalRef.current);
      return;
    }

    startLive();
    return () => clearInterval(intervalRef.current);
  }, [scenario, startLive]);

  useEffect(() => {
    if (scenario !== 'live') return;
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      const now = Date.now() / 1000;
      const pt = generatePoint(
        lastValueRef.current,
        now,
        volatilityRef.current,
        startValueRef.current
      );
      lastValueRef.current = pt.value;
      setValue(pt.value);
      setData((prev) => {
        const next = [...prev, pt];
        return next.length > maxTicksRef.current
          ? next.slice(-maxTicksRef.current)
          : next;
      });
      tickAndAggregate(pt);
    }, tickRate);
    return () => clearInterval(intervalRef.current);
  }, [tickRate, scenario]);

  useEffect(() => {
    if (scenario !== 'live' || dataRef.current.length === 0) return;
    const agg = aggregateCandles(dataRef.current, candleSecs);
    setCandles(agg.candles);
    setLiveCandle(agg.live);
    liveCandleRef.current = agg.live ? { ...agg.live } : null;
  }, [candleSecs, scenario]);

  // Preset switch — reset all dependent state. Called directly from the
  // event handler that changes preset (not a useEffect keyed on it) so the
  // reset applies in the same commit as the switch, with no stale-frame
  // flash of the previous preset's data.
  const applyPreset = useCallback((preset: Preset) => {
    dispatchConfig({ type: 'preset', preset });
    setData([]);
    dataRef.current = [];
    setCandles([]);
    setLiveCandle(null);
    liveCandleRef.current = null;
    lastValueRef.current = preset === 'crypto' ? 65000 : 100;
    maxTicksRef.current = preset === 'crypto' ? 4000 : 1200;
    clearInterval(intervalRef.current);
    setLoading(true);
    setScenario('loading');
  }, []);

  return {
    config,
    dispatchConfig,
    applyPreset,
    data,
    value,
    loading,
    scenario,
    setScenario,
    candles,
    liveCandle,
  };
}

/**
 * Preset + State + Chart + Data + Window + Features control panels.
 * Memoized: every prop is a stable state/reducer setter or a value that only
 * changes on user input, never on the per-tick setData/setValue calls inside
 * useCandlestickFeed's interval — see the `onPresetChange` call site below
 * for the one prop that needed a useCallback to actually earn this.
 */
const CandlestickControls = memo(function CandlestickControlsImpl({
  preset,
  onPresetChange,
  scenario,
  setScenario,
  paused,
  setPaused,
  config,
  dispatchConfig,
  windows,
  grid,
  setGrid,
  scrub,
  setScrub,
}: {
  preset: Preset;
  onPresetChange: (v: Preset) => void;
  scenario: Scenario;
  setScenario: (v: Scenario) => void;
  paused: boolean;
  setPaused: (fn: (p: boolean) => boolean) => void;
  config: ConfigState;
  dispatchConfig: (action: ConfigAction) => void;
  windows: { label: string; secs: number }[];
  grid: boolean;
  setGrid: (v: boolean) => void;
  scrub: boolean;
  setScrub: (v: boolean) => void;
}) {
  return (
    <>
      <Section label="Preset">
        <Btn active={preset === 'dev'} onPress={() => onPresetChange('dev')}>
          Dev
        </Btn>
        <Btn
          active={preset === 'crypto'}
          onPress={() => onPresetChange('crypto')}
        >
          Crypto
        </Btn>
      </Section>

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

      <Section label="Chart">
        <Btn
          active={config.chartType === 'candle'}
          onPress={() =>
            dispatchConfig({ type: 'set', patch: { chartType: 'candle' } })
          }
        >
          Candle
        </Btn>
        <Btn
          active={config.chartType === 'line'}
          onPress={() =>
            dispatchConfig({ type: 'set', patch: { chartType: 'line' } })
          }
        >
          Line
        </Btn>
        <Sep />
        <Label text="Width">
          {CANDLE_WIDTHS.map((cw) => (
            <Btn
              key={cw.secs}
              active={config.candleSecs === cw.secs}
              onPress={() =>
                dispatchConfig({ type: 'set', patch: { candleSecs: cw.secs } })
              }
            >
              {cw.label}
            </Btn>
          ))}
        </Label>
      </Section>

      <Section label="Data">
        <Label text="Volatility">
          {VOLATILITIES.map((v) => (
            <Btn
              key={v}
              active={config.volatility === v}
              onPress={() =>
                dispatchConfig({ type: 'set', patch: { volatility: v } })
              }
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
              active={config.tickRate === t.ms}
              onPress={() =>
                dispatchConfig({ type: 'set', patch: { tickRate: t.ms } })
              }
            >
              {t.label}
            </Btn>
          ))}
        </Label>
      </Section>

      <Section label="Window">
        {windows.map((w) => (
          <Btn
            key={w.secs}
            active={config.windowSecs === w.secs}
            onPress={() =>
              dispatchConfig({ type: 'set', patch: { windowSecs: w.secs } })
            }
          >
            {w.label}
          </Btn>
        ))}
      </Section>

      <Section label="Features">
        <Toggle on={grid} onToggle={setGrid}>
          Grid
        </Toggle>
        <Toggle on={scrub} onToggle={setScrub}>
          Scrub
        </Toggle>
      </Section>
    </>
  );
});

/**
 * Mini-chart grid — ported from dev/demo.tsx lines 386-429. Web gates only
 * `grid` by size here, and never passes `windows` to the minis.
 * Deliberately NOT memoized: `data`, `candles`, `value`, and `liveCandle`
 * change on every simulated tick, so a React.memo wrapper here would fail
 * its shallow comparison every render anyway and just add a wasted check.
 */
function SizeVariants({
  isDark,
  data,
  value,
  candles,
  candleSecs,
  liveCandle,
  chartType,
  theme,
  color,
  windowSecs,
  formatValue,
  loading,
  paused,
  grid,
  scrub,
}: {
  isDark: boolean;
  data: LivelinePoint[];
  value: number;
  candles: CandlePoint[];
  candleSecs: number;
  liveCandle: CandlePoint | null;
  chartType: ChartType;
  theme: 'dark' | 'light';
  color: string;
  windowSecs: number;
  formatValue: ((v: number) => string) | undefined;
  loading: boolean;
  paused: boolean;
  grid: boolean;
  scrub: boolean;
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
                mode="candle"
                data={data}
                value={value}
                candles={candles}
                candleWidth={candleSecs}
                liveCandle={liveCandle ?? undefined}
                lineMode={chartType === 'line'}
                lineData={data}
                lineValue={value}
                loading={loading}
                paused={paused}
                theme={theme}
                color={color}
                window={windowSecs}
                formatValue={formatValue}
                grid={grid && size.w >= 200}
                scrub={scrub}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        ))}
      </View>
    </>
  );
}

export function CandlestickSection() {
  const { isDark, accent } = useAppTheme();
  const theme = isDark ? 'dark' : 'light';

  const [preset, setPreset] = useState<Preset>('dev');
  const [paused, setPaused] = useState(false);
  const [grid, setGrid] = useState(true);
  const [scrub, setScrub] = useState(true);

  const {
    config,
    dispatchConfig,
    applyPreset,
    data,
    value,
    loading,
    scenario,
    setScenario,
    candles,
    liveCandle,
  } = useCandlestickFeed();
  const { candleSecs, chartType, tickRate, volatility, windowSecs } = config;

  // Memoized so it's a stable prop into the memoized CandlestickControls
  // below — a fresh arrow function here every render would defeat that memo.
  const handlePresetChange = useCallback(
    (p: Preset) => {
      setPreset(p);
      applyPreset(p);
    },
    [applyPreset]
  );

  // Deliberate correction of an upstream demo bug: web dev/demo.tsx's Window
  // control panel always maps over TIME_WINDOWS regardless of preset, so in
  // crypto mode it shows 10s/30s/1m/5m buttons that don't match the
  // 300/900/3600s window values actually in play. We switch the panel's
  // window buttons by preset here; the in-chart pills (below) still follow
  // web exactly (crypto-only, via the chart's own `windows` prop).
  const windows = preset === 'crypto' ? CRYPTO_WINDOWS : TIME_WINDOWS;
  const color = preset === 'crypto' ? CRYPTO_COLOR : accent;
  const formatValue = preset === 'crypto' ? formatCrypto : undefined;

  return (
    <View>
      <ScreenTitle
        title="Candlestick"
        subtitle="OHLC aggregation with line-mode morph"
      />

      <CandlestickControls
        preset={preset}
        onPresetChange={handlePresetChange}
        scenario={scenario}
        setScenario={setScenario}
        paused={paused}
        setPaused={setPaused}
        config={config}
        dispatchConfig={dispatchConfig}
        windows={windows}
        grid={grid}
        setGrid={setGrid}
        scrub={scrub}
        setScrub={setScrub}
      />

      <ChartFrame height={320}>
        <Liveline
          mode="candle"
          data={data}
          value={value}
          candles={candles}
          candleWidth={candleSecs}
          liveCandle={liveCandle ?? undefined}
          lineMode={chartType === 'line'}
          lineData={data}
          lineValue={value}
          loading={loading}
          paused={paused}
          theme={theme}
          color={color}
          window={windowSecs}
          windows={preset === 'crypto' ? CRYPTO_WINDOWS : undefined}
          formatValue={formatValue}
          onModeChange={(m) =>
            dispatchConfig({ type: 'set', patch: { chartType: m } })
          }
          grid={grid}
          scrub={scrub}
          style={{ flex: 1 }}
        />
      </ChartFrame>

      <SizeVariants
        isDark={isDark}
        data={data}
        value={value}
        candles={candles}
        candleSecs={candleSecs}
        liveCandle={liveCandle}
        chartType={chartType}
        theme={theme}
        color={color}
        windowSecs={windowSecs}
        formatValue={formatValue}
        loading={loading}
        paused={paused}
        grid={grid}
        scrub={scrub}
      />

      <StatusBar
        items={[
          `preset: ${preset}`,
          `ticks: ${data.length}`,
          `candles: ${candles.length}`,
          `loading: ${String(loading)}`,
          `paused: ${String(paused)}`,
          `value: ${value.toFixed(2)}`,
          `window: ${windowSecs}s`,
          `candle: ${candleSecs}s`,
          `tick: ${tickRate}ms`,
          `volatility: ${volatility}`,
          `mode: ${chartType}`,
        ]}
      />
    </View>
  );
}
