/* eslint-disable react-native/no-inline-styles -- control styles are theme/prop-derived, mirrors upstream web demo controls */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Liveline } from '@fuller/react-native-liveline';
import type { LivelinePoint } from '@fuller/react-native-liveline';
import { useAppTheme } from '../AppTheme';
import {
  CRYPTO_WINDOWS,
  TICK_RATES,
  VOLATILITIES,
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

type Scenario = 'loading' | 'loading-hold' | 'live' | 'empty';

const CRYPTO_COLOR = '#f7931a';
const BASE_VALUE = 65000;

export function CryptoSection() {
  const { isDark } = useAppTheme();
  const theme = isDark ? 'dark' : 'light';

  const [data, setData] = useState<LivelinePoint[]>([]);
  const [value, setValue] = useState(BASE_VALUE);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [scenario, setScenario] = useState<Scenario>('loading');

  const [windowSecs, setWindowSecs] = useState(CRYPTO_WINDOWS[0]!.secs);
  const [volatility, setVolatility] = useState<Volatility>('calm');
  const [tickRate, setTickRate] = useState(1000);

  const [exaggerate, setExaggerate] = useState(true);
  const [degen, setDegen] = useState(true);
  const [showValue, setShowValue] = useState(true);
  const [valueMomentumColor, setValueMomentumColor] = useState(true);
  const [grid, setGrid] = useState(true);

  const intervalRef = useRef<ReturnType<typeof setInterval>>(0);
  const volatilityRef = useRef(volatility);
  volatilityRef.current = volatility;
  const lastValueRef = useRef(BASE_VALUE);

  const startLive = useCallback(() => {
    clearInterval(intervalRef.current);
    setLoading(false);

    const now = Date.now() / 1000;
    const seed: LivelinePoint[] = [];
    let v = BASE_VALUE;
    // Matches dev/demo.tsx's crypto preset: 3800 ticks at 1s intervals so the
    // 15m/1h CRYPTO_WINDOWS are already covered by seed data on mount.
    for (let i = 3800; i >= 0; i--) {
      const pt = generatePoint(v, now - i, volatilityRef.current, BASE_VALUE);
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
        volatilityRef.current,
        BASE_VALUE
      );
      lastValueRef.current = pt.value;
      setValue(pt.value);
      setData((prev) => {
        const next = [...prev, pt];
        return next.length > 4000 ? next.slice(-4000) : next;
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

  useEffect(() => {
    if (scenario !== 'live') return;
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      const now = Date.now() / 1000;
      const pt = generatePoint(
        lastValueRef.current,
        now,
        volatilityRef.current,
        BASE_VALUE
      );
      lastValueRef.current = pt.value;
      setValue(pt.value);
      setData((prev) => {
        const next = [...prev, pt];
        return next.length > 4000 ? next.slice(-4000) : next;
      });
    }, tickRate);
    return () => clearInterval(intervalRef.current);
  }, [tickRate, scenario]);

  return (
    <View>
      <ScreenTitle
        title="Crypto-Style"
        subtitle="Exaggerated range, degen particles, $-formatted value"
      />

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
        {CRYPTO_WINDOWS.map((w) => (
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
        <Toggle on={exaggerate} onToggle={setExaggerate}>
          Exaggerate
        </Toggle>
        <Toggle on={degen} onToggle={setDegen}>
          Degen
        </Toggle>
        <Toggle on={showValue} onToggle={setShowValue}>
          Show value
        </Toggle>
        <Toggle on={valueMomentumColor} onToggle={setValueMomentumColor}>
          Value momentum color
        </Toggle>
      </Section>

      <ChartFrame height={320}>
        <Liveline
          data={data}
          value={value}
          theme={theme}
          color={CRYPTO_COLOR}
          window={windowSecs}
          windows={CRYPTO_WINDOWS}
          onWindowChange={setWindowSecs}
          loading={loading}
          paused={paused}
          grid={grid}
          exaggerate={exaggerate}
          degen={degen}
          showValue={showValue}
          valueMomentumColor={valueMomentumColor}
          formatValue={formatCrypto}
          style={{ flex: 1 }}
        />
      </ChartFrame>

      <StatusBar
        items={[
          `points: ${data.length}`,
          `loading: ${String(loading)}`,
          `paused: ${String(paused)}`,
          `value: ${formatCrypto(value)}`,
          `window: ${windowSecs}s`,
        ]}
      />
    </View>
  );
}
