/* eslint-disable react-native/no-inline-styles -- control styles are theme/prop-derived, mirrors upstream web demo controls */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Liveline } from '@fuller/react-native-liveline';
import type { LivelinePoint } from '@fuller/react-native-liveline';
import { useAppTheme } from '../AppTheme';
import {
  TIME_WINDOWS,
  TICK_RATES,
  generatePoint,
  type Volatility,
} from '../demoData';
import { Btn, Label, ScreenTitle, Section, StatusBar } from '../ui';

const SIZES = [
  { w: 320, h: 180, label: '320×180' },
  { w: 240, h: 120, label: '240×120' },
  { w: 160, h: 100, label: '160×100' },
  { w: 120, h: 80, label: '120×80' },
];

export function DashboardSection() {
  const { isDark, accent } = useAppTheme();
  const theme = isDark ? 'dark' : 'light';

  const [data, setData] = useState<LivelinePoint[]>([]);
  const [value, setValue] = useState(100);
  const [windowSecs, setWindowSecs] = useState(30);
  const [tickRate, setTickRate] = useState(300);
  const volatility: Volatility = 'normal';

  const intervalRef = useRef<ReturnType<typeof setInterval>>(0);

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

    intervalRef.current = setInterval(() => {
      setData((prev) => {
        const now2 = Date.now() / 1000;
        const lastVal = prev.length > 0 ? prev[prev.length - 1]!.value : 100;
        const pt = generatePoint(lastVal, now2, volatility);
        setValue(pt.value);
        const next = [...prev, pt];
        return next.length > 500 ? next.slice(-500) : next;
      });
    }, tickRate);
  }, [tickRate]);

  useEffect(() => {
    startLive();
    return () => clearInterval(intervalRef.current);
  }, [startLive]);

  return (
    <View>
      <ScreenTitle
        title="Dashboard"
        subtitle="Small multiples — same feed, different sizes"
      />

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

      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 12,
          marginTop: 12,
        }}
      >
        {SIZES.map((size) => (
          <View key={size.label}>
            <Text
              style={{
                fontSize: 10,
                color: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)',
                marginBottom: 4,
              }}
            >
              {size.label}
            </Text>
            <View
              style={{
                width: size.w,
                height: size.h,
                backgroundColor: isDark
                  ? 'rgba(255,255,255,0.02)'
                  : 'rgba(0,0,0,0.02)',
                borderRadius: 8,
                borderWidth: 1,
                borderColor: isDark
                  ? 'rgba(255,255,255,0.06)'
                  : 'rgba(0,0,0,0.06)',
                overflow: 'hidden',
              }}
            >
              <Liveline
                data={data}
                value={value}
                theme={theme}
                color={accent}
                window={windowSecs}
                windows={TIME_WINDOWS}
                onWindowChange={setWindowSecs}
                badge={false}
                momentum={size.w >= 200}
                grid={size.w >= 200}
                fill
                scrub
                pulse
                style={{ flex: 1 }}
              />
            </View>
          </View>
        ))}
      </View>

      <StatusBar
        items={[
          `points: ${data.length}`,
          `value: ${value.toFixed(2)}`,
          `window: ${windowSecs}s`,
          `tick: ${tickRate}ms`,
        ]}
      />
    </View>
  );
}
