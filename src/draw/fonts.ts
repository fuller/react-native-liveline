import { Platform } from 'react-native';
import { matchFont } from '@shopify/react-native-skia';
import type { LivelineFonts } from '../types';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });
const SANS = Platform.select({ ios: 'Helvetica', default: 'sans-serif' });

/**
 * Build the default Skia font set — platform monospace/sans faces matching
 * the web version's font stacks ("SF Mono", Menlo, monospace / system-ui).
 * Runs on the JS thread; the resulting SkFont host objects are captured by
 * the render worklet.
 */
export function makeDefaultFonts(): LivelineFonts {
  return {
    label: matchFont({ fontFamily: MONO, fontSize: 11, fontWeight: 'normal' }),
    value: matchFont({ fontFamily: MONO, fontSize: 11, fontWeight: '600' }),
    badge: matchFont({ fontFamily: MONO, fontSize: 11, fontWeight: '500' }),
    crosshair: matchFont({
      fontFamily: MONO,
      fontSize: 13,
      fontWeight: 'normal',
    }),
    orderbook: matchFont({ fontFamily: MONO, fontSize: 13, fontWeight: '600' }),
    empty: matchFont({ fontFamily: SANS, fontSize: 12, fontWeight: 'normal' }),
    refLabel: matchFont({ fontFamily: SANS, fontSize: 11, fontWeight: '500' }),
    seriesLabel: matchFont({
      fontFamily: SANS,
      fontSize: 10,
      fontWeight: '600',
    }),
  };
}
