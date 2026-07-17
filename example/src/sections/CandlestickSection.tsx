/* eslint-disable react-native/no-inline-styles -- control styles are theme/prop-derived, mirrors upstream web demo controls */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Liveline } from 'react-native-liveline';
import type { CandlePoint, LivelinePoint } from 'react-native-liveline';
import { useAppTheme } from '../AppTheme';
import {
  CANDLE_WIDTHS,
  CRYPTO_WINDOWS,
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

type Preset = 'dev' | 'crypto';
type Scenario = 'loading' | 'loading-hold' | 'live' | 'empty';
type ChartType = 'line' | 'candle';

const CRYPTO_COLOR = '#f7931a';

export function CandlestickSection() {
  const { isDark, accent } = useAppTheme();
  const theme = isDark ? 'dark' : 'light';

  const [preset, setPreset] = useState<Preset>('dev');
  const [data, setData] = useState<LivelinePoint[]>([]);
  const [value, setValue] = useState(100);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [scenario, setScenario] = useState<Scenario>('loading');

  const [windowSecs, setWindowSecs] = useState(30);
  const [grid, setGrid] = useState(true);
  const [scrub, setScrub] = useState(true);

  const [volatility, setVolatility] = useState<Volatility>('normal');
  const [tickRate, setTickRate] = useState(300);

  const [chartType, setChartType] = useState<ChartType>('candle');
  const [candleSecs, setCandleSecs] = useState(2);
  const [candles, setCandles] = useState<CandlePoint[]>([]);
  const [liveCandle, setLiveCandle] = useState<CandlePoint | null>(null);

  const candleSecsRef = useRef(candleSecs);
  candleSecsRef.current = candleSecs;
  const [startValue, setStartValue] = useState(100);
  const lastValueRef = useRef(100);
  const liveCandleRef = useRef<CandlePoint | null>(null);
  const dataRef = useRef<LivelinePoint[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(0);
  const volatilityRef = useRef(volatility);
  volatilityRef.current = volatility;
  const startValueRef = useRef(startValue);
  startValueRef.current = startValue;
  // Tick buffer covers widest window: crypto 1h=3600 ticks, dev 5m≈1000 ticks
  const maxTicksRef = useRef(1200);

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
        return next.length > maxTicksRef.current
          ? next.slice(-maxTicksRef.current)
          : next;
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
        const trimmed =
          next.length > maxTicksRef.current
            ? next.slice(-maxTicksRef.current)
            : next;
        dataRef.current = trimmed;
        return trimmed;
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
        const trimmed =
          next.length > maxTicksRef.current
            ? next.slice(-maxTicksRef.current)
            : next;
        dataRef.current = trimmed;
        return trimmed;
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

  // Preset switch — reset all dependent state
  useEffect(() => {
    if (preset === 'crypto') {
      setStartValue(65000);
      startValueRef.current = 65000;
      setTickRate(1000);
      setCandleSecs(60);
      candleSecsRef.current = 60;
      setWindowSecs(300);
      setVolatility('calm');
      setChartType('candle');
      maxTicksRef.current = 4000; // covers 1h window at 1 tick/sec
    } else {
      setStartValue(100);
      startValueRef.current = 100;
      setTickRate(300);
      setCandleSecs(2);
      candleSecsRef.current = 2;
      setWindowSecs(30);
      setVolatility('normal');
      setChartType('candle');
      maxTicksRef.current = 1200; // covers 5m window at ~3 ticks/sec
    }
    setData([]);
    dataRef.current = [];
    setCandles([]);
    setLiveCandle(null);
    liveCandleRef.current = null;
    lastValueRef.current = preset === 'crypto' ? 65000 : 100;
    clearInterval(intervalRef.current);
    setLoading(true);
    setScenario('loading');
  }, [preset]);

  const windows = preset === 'crypto' ? CRYPTO_WINDOWS : TIME_WINDOWS;
  const color = preset === 'crypto' ? CRYPTO_COLOR : accent;
  const formatValue = preset === 'crypto' ? formatCrypto : undefined;

  return (
    <View>
      <ScreenTitle
        title="Candlestick"
        subtitle="OHLC aggregation with line-mode morph"
      />

      <Section label="Preset">
        <Btn active={preset === 'dev'} onPress={() => setPreset('dev')}>
          Dev
        </Btn>
        <Btn active={preset === 'crypto'} onPress={() => setPreset('crypto')}>
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
          active={chartType === 'candle'}
          onPress={() => setChartType('candle')}
        >
          Candle
        </Btn>
        <Btn active={chartType === 'line'} onPress={() => setChartType('line')}>
          Line
        </Btn>
        <Sep />
        <Label text="Width">
          {CANDLE_WIDTHS.map((cw) => (
            <Btn
              key={cw.secs}
              active={candleSecs === cw.secs}
              onPress={() => setCandleSecs(cw.secs)}
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
        {windows.map((w) => (
          <Btn
            key={w.secs}
            active={windowSecs === w.secs}
            onPress={() => setWindowSecs(w.secs)}
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
          windows={windows}
          onWindowChange={setWindowSecs}
          formatValue={formatValue}
          onModeChange={(m) => setChartType(m)}
          grid={grid}
          scrub={scrub}
          style={{ flex: 1 }}
        />
      </ChartFrame>

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
