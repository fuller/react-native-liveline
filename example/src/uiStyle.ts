export const CONTROL_HEIGHT = 24;
export const CONTROL_RADIUS = 5;
export const PILL_HEIGHT = 28;

export function fg(isDark: boolean, alpha: number): string {
  const base = isDark ? '255,255,255' : '0,0,0';
  return `rgba(${base},${alpha})`;
}
