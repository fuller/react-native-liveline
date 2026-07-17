/* eslint-disable react-native/no-inline-styles -- control styles are theme/prop-derived, mirrors upstream web demo controls */
import { useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ACCENT_COLORS, AppThemeProvider, useAppTheme } from './AppTheme';
import { StressButton } from './StressButton';
import { PageBg } from './ui';
import { BasicLineSection } from './sections/BasicLineSection';
import { CandlestickSection } from './sections/CandlestickSection';
import { CryptoSection } from './sections/CryptoSection';
import { DashboardSection } from './sections/DashboardSection';
import { MultiSeriesSection } from './sections/MultiSeriesSection';
import { OrderbookSection } from './sections/OrderbookSection';

type SectionKey =
  'line' | 'crypto' | 'dashboard' | 'candle' | 'multi' | 'orderbook';

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: 'line', label: 'Line' },
  { key: 'crypto', label: 'Crypto' },
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'candle', label: 'Candles' },
  { key: 'multi', label: 'Multi' },
  { key: 'orderbook', label: 'Orderbook' },
];

function fg(isDark: boolean, alpha: number): string {
  const base = isDark ? '255,255,255' : '0,0,0';
  return `rgba(${base},${alpha})`;
}

function TopBar() {
  const { isDark, setIsDark, accent, setAccent } = useAppTheme();
  return (
    <View
      style={{
        paddingHorizontal: 16,
        paddingTop: 8,
        paddingBottom: 8,
        borderBottomWidth: 1,
        borderBottomColor: fg(isDark, 0.08),
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <Text
          style={{
            fontSize: 16,
            fontWeight: '600',
            color: isDark ? '#fff' : '#111',
          }}
        >
          Liveline
        </Text>
        <StressButton />
      </View>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <View style={{ flexDirection: 'row', gap: 4 }}>
          <Pressable
            onPress={() => setIsDark(true)}
            style={{
              paddingVertical: 4,
              paddingHorizontal: 10,
              borderRadius: 5,
              borderWidth: 1,
              borderColor: isDark ? 'rgba(59,130,246,0.5)' : fg(isDark, 0.08),
              backgroundColor: isDark ? 'rgba(59,130,246,0.12)' : 'transparent',
            }}
          >
            <Text
              style={{
                fontSize: 11,
                color: isDark ? '#3b82f6' : fg(isDark, 0.45),
              }}
            >
              Dark
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setIsDark(false)}
            style={{
              paddingVertical: 4,
              paddingHorizontal: 10,
              borderRadius: 5,
              borderWidth: 1,
              borderColor: !isDark ? 'rgba(59,130,246,0.5)' : fg(isDark, 0.08),
              backgroundColor: !isDark
                ? 'rgba(59,130,246,0.12)'
                : 'transparent',
            }}
          >
            <Text
              style={{
                fontSize: 11,
                color: !isDark ? '#3b82f6' : fg(isDark, 0.45),
              }}
            >
              Light
            </Text>
          </Pressable>
        </View>

        <View
          style={{ width: 1, height: 16, backgroundColor: fg(isDark, 0.08) }}
        />

        <View style={{ flexDirection: 'row', gap: 6 }}>
          {ACCENT_COLORS.map((c) => (
            <Pressable
              key={c}
              onPress={() => setAccent(c)}
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                backgroundColor: c,
                borderWidth: accent === c ? 2 : 0,
                borderColor: isDark ? '#fff' : '#111',
              }}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

function SectionTabs({
  active,
  onChange,
}: {
  active: SectionKey;
  onChange: (key: SectionKey) => void;
}) {
  const { isDark } = useAppTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{
        borderBottomWidth: 1,
        borderBottomColor: fg(isDark, 0.08),
      }}
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingVertical: 8,
        gap: 6,
      }}
    >
      {SECTIONS.map((s) => {
        const isActive = s.key === active;
        return (
          <Pressable
            key={s.key}
            onPress={() => onChange(s.key)}
            style={{
              paddingVertical: 5,
              paddingHorizontal: 12,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: isActive ? 'rgba(59,130,246,0.5)' : fg(isDark, 0.08),
              backgroundColor: isActive
                ? 'rgba(59,130,246,0.12)'
                : fg(isDark, 0.02),
            }}
          >
            <Text
              style={{
                fontSize: 12,
                fontWeight: isActive ? '600' : '400',
                color: isActive ? '#3b82f6' : fg(isDark, 0.45),
              }}
            >
              {s.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function ActiveSection({ active }: { active: SectionKey }) {
  switch (active) {
    case 'line':
      return <BasicLineSection />;
    case 'crypto':
      return <CryptoSection />;
    case 'dashboard':
      return <DashboardSection />;
    case 'candle':
      return <CandlestickSection />;
    case 'multi':
      return <MultiSeriesSection />;
    case 'orderbook':
      return <OrderbookSection />;
  }
}

function DemoApp() {
  const [active, setActive] = useState<SectionKey>('line');

  return (
    <PageBg>
      <SafeAreaView style={{ flex: 1 }}>
        <TopBar />
        <SectionTabs active={active} onChange={setActive} />
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
          keyboardShouldPersistTaps="handled"
        >
          <ActiveSection active={active} />
        </ScrollView>
      </SafeAreaView>
    </PageBg>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppThemeProvider>
        <DemoApp />
      </AppThemeProvider>
    </GestureHandlerRootView>
  );
}
