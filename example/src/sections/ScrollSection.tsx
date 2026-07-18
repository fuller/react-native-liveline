/* eslint-disable react-native/no-inline-styles -- control styles are theme/prop-derived, mirrors upstream web demo controls */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Liveline } from '@ajfuller/react-native-liveline';
import type { LivelinePoint } from '@ajfuller/react-native-liveline';
import { useAppTheme } from '../AppTheme';
import { generatePoint, TIME_WINDOWS, type Volatility } from '../demoData';
import { fg, ScreenTitle } from '../ui';

const VOLATILITY: Volatility = 'normal';
const TICK_MS = 300;

/** A block of non-chart filler content, to give the ScrollView something to scroll past. */
function Filler({ label }: { label: string }) {
  const { isDark } = useAppTheme();
  return (
    <View
      style={{
        height: 140,
        borderRadius: 10,
        backgroundColor: fg(isDark, 0.02),
        borderWidth: 1,
        borderColor: fg(isDark, 0.06),
        justifyContent: 'center',
        alignItems: 'center',
        marginVertical: 12,
      }}
    >
      <Text style={{ fontSize: 12, color: fg(isDark, 0.25) }}>{label}</Text>
    </View>
  );
}

function MiniChart({
  data,
  value,
  label,
  scrubActivationDelay,
}: {
  data: LivelinePoint[];
  value: number;
  label: string;
  scrubActivationDelay?: number;
}) {
  const { isDark, accent } = useAppTheme();
  const theme = isDark ? 'dark' : 'light';

  return (
    <View>
      <Text
        style={{
          fontSize: 11,
          fontWeight: '600',
          color: isDark ? '#fff' : '#111',
          marginBottom: 6,
        }}
      >
        {label}
      </Text>
      <View
        style={{
          height: 160,
          borderRadius: 10,
          backgroundColor: fg(isDark, 0.02),
          borderWidth: 1,
          borderColor: fg(isDark, 0.06),
          overflow: 'hidden',
          padding: 8,
        }}
      >
        <Liveline
          data={data}
          value={value}
          theme={theme}
          color={accent}
          window={30}
          windows={TIME_WINDOWS}
          badge={false}
          grid={false}
          fill
          scrub
          scrubActivationDelay={scrubActivationDelay}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

export function ScrollSection() {
  const { isDark } = useAppTheme();

  const [data, setData] = useState<LivelinePoint[]>([]);
  const [value, setValue] = useState(100);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(0);

  const startLive = useCallback(() => {
    clearInterval(intervalRef.current);
    const now = Date.now() / 1000;
    const seed: LivelinePoint[] = [];
    let v = 100;
    for (let i = 60; i >= 0; i--) {
      const pt = generatePoint(v, now - i * 0.5, VOLATILITY);
      seed.push(pt);
      v = pt.value;
    }
    setData(seed);
    setValue(v);

    intervalRef.current = setInterval(() => {
      setData((prev) => {
        const now2 = Date.now() / 1000;
        const lastVal = prev.length > 0 ? prev[prev.length - 1]!.value : 100;
        const pt = generatePoint(lastVal, now2, VOLATILITY);
        setValue(pt.value);
        const next = [...prev, pt];
        return next.length > 500 ? next.slice(-500) : next;
      });
    }, TICK_MS);
  }, []);

  useEffect(() => {
    startLive();
    return () => clearInterval(intervalRef.current);
  }, [startLive]);

  return (
    <View>
      <ScreenTitle
        title="Scroll"
        subtitle="Charts embedded in a ScrollView — scrubActivationDelay keeps flick-scrolls free"
      />

      <ScrollView
        style={{
          height: 620,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: fg(isDark, 0.06),
        }}
        contentContainerStyle={{ padding: 12 }}
        nestedScrollEnabled
      >
        <Filler label="Filler content — scroll past this" />

        <MiniChart
          data={data}
          value={value}
          label="Default (scrubActivationDelay unset — scrub activates immediately)"
        />

        <Filler label="More filler — scroll between charts" />

        <MiniChart
          data={data}
          value={value}
          label="scrubActivationDelay={300} — requires a long-press hold to scrub"
          scrubActivationDelay={300}
        />

        <Filler label="Filler content — scroll past this" />
      </ScrollView>
    </View>
  );
}
