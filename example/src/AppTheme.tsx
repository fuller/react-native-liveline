import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/** Accent swatches offered by the global picker — first is the library default. */
export const ACCENT_COLORS = [
  '#3b82f6', // blue (default)
  '#ef4444', // red
  '#22c55e', // green
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#ec4899', // pink
];

interface AppThemeValue {
  isDark: boolean;
  setIsDark: (v: boolean) => void;
  accent: string;
  setAccent: (v: string) => void;
}

const AppThemeContext = createContext<AppThemeValue | null>(null);

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [isDark, setIsDark] = useState(true);
  const [accent, setAccent] = useState(ACCENT_COLORS[0]!);

  const value = useMemo(
    () => ({ isDark, setIsDark, accent, setAccent }),
    [isDark, accent]
  );

  return (
    <AppThemeContext.Provider value={value}>
      {children}
    </AppThemeContext.Provider>
  );
}

export function useAppTheme(): AppThemeValue {
  const ctx = useContext(AppThemeContext);
  if (!ctx) throw new Error('useAppTheme must be used within AppThemeProvider');
  return ctx;
}
