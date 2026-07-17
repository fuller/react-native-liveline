/* eslint-disable react-native/no-inline-styles -- control styles are theme/prop-derived, mirrors upstream web demo controls */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Liveline } from '@ajfuller/react-native-liveline';
import type {
  LivelinePoint,
  OrderbookData,
} from '@ajfuller/react-native-liveline';
import { useAppTheme } from '../AppTheme';
import {
  TICK_RATES,
  TIME_WINDOWS,
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

type Scenario = 'live' | 'empty';

const LEVELS = 8;

/** Build a small fake order book straddling the current price. */
function buildOrderbook(mid: number): OrderbookData {
  const tick = Math.max(0.01, mid * 0.0006);
  const bids: [number, number][] = [];
  const asks: [number, number][] = [];
  for (let i = 1; i <= LEVELS; i++) {
    bids.push([mid - tick * i, Math.round(5 + Math.random() * 40)]);
    asks.push([mid + tick * i, Math.round(5 + Math.random() * 40)]);
  }
  return { bids, asks };
}

export function OrderbookSection() {
  const { isDark, accent } = useAppTheme();
  const theme = isDark ? 'dark' : 'light';

  const [data, setData] = useState<LivelinePoint[]>([]);
  const [value, setValue] = useState(100);
  const [orderbook, setOrderbook] = useState<OrderbookData>({
    bids: [],
    asks: [],
  });
  const [paused, setPaused] = useState(false);
  const [scenario, setScenario] = useState<Scenario>('live');
  const [tickRate, setTickRate] = useState(300);
  const [grid, setGrid] = useState(true);
  const [scrub, setScrub] = useState(true);

  const volatility: Volatility = 'normal';
  const intervalRef = useRef<ReturnType<typeof setInterval>>(0);
  const lastValueRef = useRef(100);

  const startLive = useCallback(() => {
    clearInterval(intervalRef.current);
    const now = Date.now() / 1000;
    const seed: LivelinePoint[] = [];
    let v = 100;
    for (let i = 60; i >= 0; i--) {
      const pt = generatePoint(v, now - i * 0.5, volatility);
      seed.push(pt);
      v = pt.value;
    }
    setData(seed);
    setValue(v);
    lastValueRef.current = v;
    setOrderbook(buildOrderbook(v));

    intervalRef.current = setInterval(() => {
      const now2 = Date.now() / 1000;
      const pt = generatePoint(lastValueRef.current, now2, volatility);
      lastValueRef.current = pt.value;
      setValue(pt.value);
      setData((prev) => {
        const next = [...prev, pt];
        return next.length > 500 ? next.slice(-500) : next;
      });
      setOrderbook(buildOrderbook(pt.value));
    }, tickRate);
  }, [tickRate]);

  useEffect(() => {
    if (scenario === 'empty') {
      setData([]);
      setOrderbook({ bids: [], asks: [] });
      clearInterval(intervalRef.current);
      return;
    }
    startLive();
    return () => clearInterval(intervalRef.current);
  }, [scenario, startLive]);

  return (
    <View>
      <ScreenTitle
        title="Orderbook"
        subtitle="Streaming fake bids/asks overlay"
      />

      <Section label="State">
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
          data={data}
          value={value}
          orderbook={orderbook}
          theme={theme}
          color={accent}
          window={30}
          windows={TIME_WINDOWS}
          paused={paused}
          grid={grid}
          scrub={scrub}
          style={{ flex: 1 }}
        />
      </ChartFrame>

      <StatusBar
        items={[
          `points: ${data.length}`,
          `bids: ${orderbook.bids.length}`,
          `asks: ${orderbook.asks.length}`,
          `value: ${value.toFixed(2)}`,
          `tick: ${tickRate}ms`,
        ]}
      />
    </View>
  );
}
