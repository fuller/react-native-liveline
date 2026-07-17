/* eslint-disable react-native/no-inline-styles -- control styles are theme/prop-derived, mirrors upstream web demo controls */
import { Pressable, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import { useAppTheme } from './AppTheme';

const ACCENT = '#3b82f6';

function fg(isDark: boolean, alpha: number): string {
  const base = isDark ? '255,255,255' : '0,0,0';
  return `rgba(${base},${alpha})`;
}

export function PageBg({ children }: { children: ReactNode }) {
  const { isDark } = useAppTheme();
  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#111' : '#f5f5f5' }}>
      {children}
    </View>
  );
}

export function ScreenTitle({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  const { isDark } = useAppTheme();
  return (
    <View style={{ marginBottom: 16 }}>
      <Text
        style={{
          fontSize: 18,
          fontWeight: '600',
          color: isDark ? '#fff' : '#111',
          marginBottom: 2,
        }}
      >
        {title}
      </Text>
      {subtitle != null && (
        <Text style={{ fontSize: 12, color: fg(isDark, 0.3) }}>{subtitle}</Text>
      )}
    </View>
  );
}

export function Section({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const { isDark } = useAppTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginBottom: 8,
        flexWrap: 'wrap',
      }}
    >
      <Text
        style={{
          fontSize: 10,
          color: fg(isDark, 0.3),
          width: 56,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        {label}
      </Text>
      {children}
    </View>
  );
}

export function Label({
  text,
  children,
}: {
  text: string;
  children: ReactNode;
}) {
  const { isDark } = useAppTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Text style={{ fontSize: 10, color: fg(isDark, 0.2), marginRight: 2 }}>
        {text}:
      </Text>
      {children}
    </View>
  );
}

export function Sep() {
  const { isDark } = useAppTheme();
  return (
    <View
      style={{
        width: 1,
        height: 16,
        backgroundColor: fg(isDark, 0.08),
        marginHorizontal: 2,
      }}
    />
  );
}

export function Btn({
  children,
  active,
  onPress,
}: {
  children: ReactNode;
  active: boolean;
  onPress: () => void;
}) {
  const { isDark } = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 5,
        borderWidth: 1,
        borderColor: active ? 'rgba(59,130,246,0.5)' : fg(isDark, 0.08),
        backgroundColor: active ? 'rgba(59,130,246,0.12)' : fg(isDark, 0.02),
      }}
    >
      <Text
        style={{
          fontSize: 11,
          lineHeight: 15,
          color: active ? ACCENT : fg(isDark, 0.45),
        }}
      >
        {children}
      </Text>
    </Pressable>
  );
}

export function Toggle({
  on,
  onToggle,
  children,
}: {
  on: boolean;
  onToggle: (v: boolean) => void;
  children: ReactNode;
}) {
  const { isDark } = useAppTheme();
  return (
    <Pressable
      onPress={() => onToggle(!on)}
      style={{
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 5,
        borderWidth: 1,
        borderColor: on ? 'rgba(59,130,246,0.4)' : fg(isDark, 0.06),
        backgroundColor: on ? 'rgba(59,130,246,0.1)' : 'transparent',
      }}
    >
      <Text
        style={{
          fontSize: 11,
          lineHeight: 15,
          color: on ? ACCENT : fg(isDark, 0.35),
        }}
      >
        {children}
      </Text>
    </Pressable>
  );
}

export function StatusBar({ items }: { items: string[] }) {
  const { isDark } = useAppTheme();
  return (
    <View
      style={{
        marginTop: 10,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 16,
      }}
    >
      {items.map((it) => (
        <Text key={it} style={{ fontSize: 11, color: fg(isDark, 0.25) }}>
          {it}
        </Text>
      ))}
    </View>
  );
}

export function ChartFrame({
  height,
  children,
}: {
  height: number;
  children: ReactNode;
}) {
  const { isDark } = useAppTheme();
  return (
    <View
      style={{
        height,
        backgroundColor: fg(isDark, 0.02),
        borderRadius: 12,
        borderWidth: 1,
        borderColor: fg(isDark, 0.06),
        padding: 8,
        overflow: 'hidden',
        marginTop: 16,
      }}
    >
      {children}
    </View>
  );
}
