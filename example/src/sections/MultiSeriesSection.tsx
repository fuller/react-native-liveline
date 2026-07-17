/* eslint-disable react-native/no-inline-styles -- control styles are theme/prop-derived, mirrors upstream web demo controls */
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Liveline } from 'react-native-liveline';
import type {
  LivelinePoint,
  LivelineSeries,
  WindowStyle,
} from 'react-native-liveline';
import { useAppTheme } from '../AppTheme';
import {
  MULTI_BIASES,
  MULTI_COLORS,
  MULTI_LABELS,
  MULTI_WINDOWS,
  formatPercent,
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

type Scenario = 'live' | 'loading' | 'loading-hold' | 'empty';

export function MultiSeriesSection() {
  const { isDark } = useAppTheme();
  const theme = isDark ? 'dark' : 'light';

  const [series, setSeries] = useState<LivelineSeries[]>([]);
  const [loading, setLoading] = useState(false);
  const [paused, setPaused] = useState(false);
  const [scenario, setScenario] = useState<Scenario>('live');
  const [seriesCount, setSeriesCount] = useState(4);
  const [windowSecs, setWindowSecs] = useState(MULTI_WINDOWS[0]!.secs);
  const [windowStyle, setWindowStyle] = useState<WindowStyle>('default');
  const [grid, setGrid] = useState(true);
  const [scrub, setScrub] = useState(true);
  const [exaggerate, setExaggerate] = useState(false);
  const [showRef, setShowRef] = useState(false);
  const [pulse, setPulse] = useState(true);
  const [compactToggle, setCompactToggle] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(0);
  const seriesCountRef = useRef(seriesCount);
  seriesCountRef.current = seriesCount;

  const startLive = useCallback((count: number) => {
    clearInterval(intervalRef.current);
    setLoading(false);
    const now = Date.now() / 1000;
    // Seed enough history for the 5m window (300s / 0.5s interval = 600 points)
    const initial: LivelineSeries[] = MULTI_LABELS.slice(0, count).map(
      (label, i) => {
        const seed: LivelinePoint[] = [];
        let v = 50 + (Math.random() - 0.5) * 4;
        for (let j = 700; j >= 0; j--) {
          v += (Math.random() - MULTI_BIASES[i]!) * 1.2;
          v = Math.max(10, Math.min(90, v));
          seed.push({ time: now - j * 0.5, value: v });
        }
        return {
          id: label.toLowerCase(),
          data: seed,
          value: v,
          color: MULTI_COLORS[i]!,
          label,
        };
      }
    );
    setSeries(initial);

    intervalRef.current = setInterval(() => {
      const c = seriesCountRef.current;
      setSeries((prev) => {
        // Trim or expand series to match count
        let next = prev.slice(0, c);
        // Add new series if count grew
        while (next.length < c) {
          const i = next.length;
          const now2 = Date.now() / 1000;
          const seed: LivelinePoint[] = [];
          let v = 50 + (Math.random() - 0.5) * 4;
          for (let j = 10; j >= 0; j--) {
            v += (Math.random() - MULTI_BIASES[i]!) * 1.2;
            v = Math.max(10, Math.min(90, v));
            seed.push({ time: now2 - j * 0.5, value: v });
          }
          next.push({
            id: MULTI_LABELS[i]!.toLowerCase(),
            data: seed,
            value: v,
            color: MULTI_COLORS[i]!,
            label: MULTI_LABELS[i]!,
          });
        }
        return next.map((s, i) => {
          const now3 = Date.now() / 1000;
          const delta = (Math.random() - MULTI_BIASES[i]!) * 1.2;
          const newVal = Math.max(10, Math.min(90, s.value + delta));
          const newData = [...s.data, { time: now3, value: newVal }];
          return {
            ...s,
            data: newData.length > 2000 ? newData.slice(-2000) : newData,
            value: newVal,
          };
        });
      });
    }, 300);
  }, []);

  useEffect(() => {
    if (scenario === 'loading') {
      setLoading(true);
      setSeries([]);
      clearInterval(intervalRef.current);
      const timer = setTimeout(() => setScenario('live'), 3000);
      return () => clearTimeout(timer);
    }
    if (scenario === 'loading-hold') {
      setLoading(true);
      setSeries([]);
      clearInterval(intervalRef.current);
      return;
    }
    if (scenario === 'empty') {
      setLoading(false);
      setSeries([]);
      clearInterval(intervalRef.current);
      return;
    }
    startLive(seriesCountRef.current);
    return () => clearInterval(intervalRef.current);
  }, [scenario, startLive]);

  return (
    <View>
      <ScreenTitle
        title="Multi-Series"
        subtitle="Overlapping series, shared axes"
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

      <Section label="Series">
        {[2, 3, 4].map((n) => (
          <Btn
            key={n}
            active={seriesCount === n}
            onPress={() => setSeriesCount(n)}
          >
            {n} lines
          </Btn>
        ))}
      </Section>

      <Section label="Window">
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

      <Section label="Features">
        <Toggle on={grid} onToggle={setGrid}>
          Grid
        </Toggle>
        <Toggle on={scrub} onToggle={setScrub}>
          Scrub
        </Toggle>
        <Toggle on={pulse} onToggle={setPulse}>
          Pulse
        </Toggle>
        <Toggle on={exaggerate} onToggle={setExaggerate}>
          Exaggerate
        </Toggle>
        <Toggle on={showRef} onToggle={setShowRef}>
          Ref Line
        </Toggle>
        <Toggle on={compactToggle} onToggle={setCompactToggle}>
          Compact Toggle
        </Toggle>
      </Section>

      <ChartFrame height={300}>
        <Liveline
          data={[]}
          value={0}
          series={series}
          theme={theme}
          window={windowSecs}
          windows={MULTI_WINDOWS}
          onWindowChange={setWindowSecs}
          windowStyle={windowStyle}
          grid={grid}
          scrub={scrub}
          pulse={pulse}
          exaggerate={exaggerate}
          loading={loading}
          paused={paused}
          referenceLine={showRef ? { value: 50, label: '50%' } : undefined}
          formatValue={formatPercent}
          seriesToggleCompact={compactToggle}
          onSeriesToggle={(id, vis) => console.log('series toggle:', id, vis)}
          style={{ flex: 1 }}
        />
      </ChartFrame>

      <StatusBar
        items={[
          `series: ${series.length}`,
          `loading: ${String(loading)}`,
          `paused: ${String(paused)}`,
          `window: ${windowSecs}s`,
          `points: ${series[0]?.data.length ?? 0}`,
        ]}
      />
    </View>
  );
}
