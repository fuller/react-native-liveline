# react-native-liveline

[![npm version](https://img.shields.io/npm/v/@ajfuller/react-native-liveline.svg)](https://www.npmjs.com/package/@ajfuller/react-native-liveline)
[![license](https://img.shields.io/npm/l/@ajfuller/react-native-liveline.svg)](./LICENSE)

A React Native port of [liveline](https://github.com/benjitaylor/liveline) by
[Benji Taylor](https://github.com/benjitaylor) — real-time animated charts
(line, multi-series, candlestick) with the same SDK shape as the web version.
The chart keeps animating even when your JS thread is blocked: the render
engine runs entirely on the UI thread as a Reanimated worklet, painting into a
Skia picture every frame, independent of React renders and JS-thread work.

All the hard design and animation work here — the curve fitting, the
momentum/degen feel, the badge and crosshair interactions, the candlestick
morph — is Benji's. This package adapts it to run natively via Reanimated
worklets and Skia; see [Credits](#credits) below.

## Installation

Published on npm: [`@ajfuller/react-native-liveline`](https://www.npmjs.com/package/@ajfuller/react-native-liveline).

```sh
npm install @ajfuller/react-native-liveline
```

Peer dependencies (install alongside):

```sh
npm install @shopify/react-native-skia react-native-reanimated react-native-worklets react-native-gesture-handler
```

| Peer | Required range |
|---|---|
| `@shopify/react-native-skia` | `>=2.0.0` |
| `react-native-reanimated` | `>=4.0.0` |
| `react-native-worklets` | `>=0.3.0` |
| `react-native-gesture-handler` | `>=2.16.0` |

Reanimated 4 split its worklets runtime out into the separate
`react-native-worklets` package (Reanimated itself declares this as its own
peer dependency as of 4.0.0), so it's required alongside Reanimated here too.
This library hasn't been tested against Reanimated 3.x or gesture-handler 3.x
(the latter replaced the `Gesture.Pan()` builder API this library uses with a
hook-based API) — stick to the ranges above.

### Reanimated Babel plugin

Add the Reanimated plugin to your `babel.config.js` (must be listed **last**):

```js
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // ...your other plugins
    'react-native-reanimated/plugin',
  ],
};
```

### GestureHandlerRootView

Scrubbing is implemented as a gesture-handler `Pan` gesture. Wrap your app
root (once, near the top) in `GestureHandlerRootView`:

```tsx
import { GestureHandlerRootView } from 'react-native-gesture-handler';

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* rest of your app */}
    </GestureHandlerRootView>
  );
}
```

### Expo

Because this library depends on native code (Skia, Reanimated,
gesture-handler), it does **not** work in Expo Go. Use a
[development build](https://docs.expo.dev/develop/development-builds/introduction/)
(`npx expo prebuild` + a custom dev client) or a bare workflow app.

## Quick start

```tsx
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Liveline } from '@ajfuller/react-native-liveline';
import type { LivelinePoint } from '@ajfuller/react-native-liveline';

function Chart() {
  const [data, setData] = useState<LivelinePoint[]>([]);
  const [value, setValue] = useState(0);

  useEffect(() => {
    // Feed data from a WebSocket, polling, etc.
    // Each point: { time: unixSeconds, value: number }
    let v = 100;
    const id = setInterval(() => {
      v += (Math.random() - 0.5) * 2;
      setValue(v);
      setData((prev) => [...prev, { time: Date.now() / 1000, value: v }]);
    }, 500);
    return () => clearInterval(id);
  }, []);

  return (
    <View style={{ height: 300 }}>
      <Liveline data={data} value={value} color="#3b82f6" theme="dark" />
    </View>
  );
}
```

The component fills its parent container — set a height on the parent. Pass
`data` as a growing array of points and `value` as the latest number;
`Liveline` handles smooth interpolation between updates.

## Props

**Data**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `data` | `LivelinePoint[]` | required | Array of `{ time, value }` points |
| `value` | `number` | required | Latest value (smoothly interpolated) |

**Appearance**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `theme` | `'light' \| 'dark'` | `'dark'` | Color scheme |
| `color` | `string` | `'#3b82f6'` | Accent color — all palette colors derived from this |
| `grid` | `boolean` | `true` | Y-axis grid lines + labels |
| `badge` | `boolean` | `true` | Value pill tracking chart tip |
| `badgeVariant` | `'default' \| 'minimal'` | `'default'` | Badge style: accent-colored or white with grey text |
| `badgeTail` | `boolean` | `true` | Pointed tail on badge pill |
| `fill` | `boolean` | `true` | Gradient under the curve |
| `pulse` | `boolean` | `true` | Pulsing ring on live dot |
| `lineWidth` | `number` | `2` | Stroke width of the main line in pixels |

**Features**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `momentum` | `boolean \| Momentum` | `true` | Dot glow + arrows. `true` = auto-detect, or `'up' \| 'down' \| 'flat'` |
| `scrub` | `boolean` | `true` | Crosshair scrubbing on touch-drag |
| `exaggerate` | `boolean` | `false` | Tight Y-axis — small moves fill chart height |
| `showValue` | `boolean` | `false` | Large live value overlay (60fps, no re-renders) |
| `valueMomentumColor` | `boolean` | `false` | Color the value text green/red by momentum |
| `degen` | `boolean \| DegenOptions` | `false` | Burst particles + chart shake on momentum swings |

**Candlestick**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `mode` | `'line' \| 'candle'` | `'line'` | Chart type |
| `candles` | `CandlePoint[]` | — | OHLC candle data `{ time, open, high, low, close }` |
| `candleWidth` | `number` | — | Seconds per candle |
| `liveCandle` | `CandlePoint` | — | Current in-progress candle with real-time OHLC |
| `lineMode` | `boolean` | — | Morph candles into a line display |
| `lineData` | `LivelinePoint[]` | — | Tick-level data for line mode density |
| `lineValue` | `number` | — | Current tick value for line mode |
| `onModeChange` | `(mode: 'line' \| 'candle') => void` | — | Callback for built-in line/candle toggle |

When `mode="candle"`, pass `candles` (committed OHLC bars) and `liveCandle`
(the current bar, updated every tick). `candleWidth` sets the time bucket in
seconds. The `lineMode` prop smoothly morphs between candle and line views —
candle bodies collapse to close price, then the line extends outward. Provide
`lineData` and `lineValue` (tick-level resolution) for a smooth density
transition during the morph. The `onModeChange` prop renders a built-in
line/candle toggle next to the time window buttons.

**Multi-series**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `series` | `LivelineSeries[]` | — | Multiple overlapping lines `{ id, data, value, color, label? }` |
| `onSeriesToggle` | `(id: string, visible: boolean) => void` | — | Callback when a series is toggled via built-in chips |
| `seriesToggleCompact` | `boolean` | `false` | Show only colored dots in toggle (no text labels) |

Pass `series` instead of `data`/`value` to draw multiple lines sharing the
same axes. Each series gets its own color, label, and endpoint dot. Toggle
chips appear automatically when there are 2+ series — tapping one hides/shows
that line with a smooth fade. The Y-axis range adjusts when series are
hidden. Badge, momentum arrows, and fill are disabled in multi-series mode.

**State**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `loading` | `boolean` | `false` | Breathing line animation — use while waiting for data |
| `paused` | `boolean` | `false` | Smoothly freeze chart scrolling; resume catches up to real time |
| `emptyText` | `string` | `'No data to display'` | Text shown in the empty state |

When `loading` flips to `false` with data present, the loading line morphs
into the actual chart shape. In line mode, the fill, grid, and badge animate
in. In candle mode, flat lines expand into full OHLC bodies while the morph
line fades out. When `data` is empty and `loading` is `false`, a minimal "No
data" empty state is shown.

**Time**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `window` | `number` | `30` | Visible time window in seconds |
| `windows` | `WindowOption[]` | — | Time horizon buttons `[{ label, secs }]` |
| `onWindowChange` | `(secs: number) => void` | — | Called when a window button is pressed |
| `windowStyle` | `'default' \| 'rounded' \| 'text'` | `'default'` | Window button visual style |

**Crosshair**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `tooltipY` | `number` | `14` | Vertical offset for crosshair tooltip text |
| `tooltipOutline` | `boolean` | `true` | Stroke outline on tooltip text for readability |

**Orderbook**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `orderbook` | `OrderbookData` | — | Bid/ask depth stream `{ bids, asks }` |

**Fonts**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `fonts` | `Partial<LivelineFonts>` | platform monospace | Override the Skia fonts used for chart text (see [Fonts](#fonts-1) below) |

**Advanced**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `referenceLine` | `ReferenceLine` | — | Horizontal reference line `{ value, label? }` |
| `formatValue` | `(v: number) => string` (worklet) | `v.toFixed(2)` | Value label formatter |
| `formatTime` | `(t: number) => string` (worklet) | `HH:MM:SS` | Time axis formatter |
| `lerpSpeed` | `number` | `0.08` | Interpolation speed (0–1) |
| `padding` | `Padding` | `{ top: 12, right: auto, bottom: 28, left: 12 }` | Chart padding override (`right` is 80/54/12 based on badge/grid) |
| `onHover` | `(point: HoverPoint \| null) => void` | — | Hover callback with `{ time, value, x, y }` |
| `style` | `StyleProp<ViewStyle>` | — | Container style |

### `LivelineTransition`

Cross-fades between chart components (e.g. line ↔ candlestick). Children must
have unique `key` props matching possible `active` values.

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `active` | `string` | required | Key of the active child to display |
| `children` | `ReactElement \| ReactElement[]` | required | Chart elements with unique `key` props |
| `duration` | `number` | `300` | Cross-fade duration in ms |
| `style` | `StyleProp<ViewStyle>` | — | Container style |

```tsx
<LivelineTransition active={chartType}>
  <Liveline key="line" data={data} value={value} />
  <Liveline
    key="candle"
    mode="candle"
    candles={candles}
    candleWidth={5}
    data={data}
    value={value}
  />
</LivelineTransition>
```

## Examples

### Basic (line + badge)

```tsx
<Liveline data={data} value={value} color="#3b82f6" theme="dark" />
```

### Candlestick (minimal)

```tsx
<Liveline
  mode="candle"
  data={ticks}
  value={latestTick}
  candles={candles}
  candleWidth={60}
  liveCandle={liveCandle}
  color="#f7931a"
  formatValue={(v) => {
    'worklet';
    return `$${v.toFixed(2)}`;
  }}
/>
```

### Crypto-style (momentum + degen + exaggerate)

```tsx
<Liveline
  data={data}
  value={value}
  color="#f7931a"
  exaggerate
  degen
  showValue
  valueMomentumColor
  formatValue={(v) => {
    'worklet';
    return `$${v.toFixed(2)}`;
  }}
/>
```

### Multi-series (prediction market)

```tsx
<Liveline
  data={[]}
  value={0}
  series={[
    { id: 'yes', data: yesData, value: yesValue, color: '#3b82f6', label: 'Yes' },
    { id: 'no', data: noData, value: noValue, color: '#ef4444', label: 'No' },
  ]}
  grid
  scrub
  pulse
  windowStyle="rounded"
  formatValue={(v) => {
    'worklet';
    return v.toFixed(1) + '%';
  }}
  onSeriesToggle={(id, visible) => console.log(id, visible)}
  windows={[
    { label: '10s', secs: 10 },
    { label: '30s', secs: 30 },
    { label: '1m', secs: 60 },
  ]}
/>
```

### Orderbook (orderbook data + particles)

```tsx
<Liveline
  data={data}
  value={value}
  color="#f7931a"
  orderbook={{ bids: [[100, 2], [99, 5]], asks: [[101, 3], [102, 4]] }}
  degen
  showValue
/>
```

## React Native differences from the web version

This port keeps the same SDK shape as [liveline](https://github.com/benjitaylor/liveline)
but a few props differ because of the native/worklet environment:

- **`formatValue` / `formatTime` must be worklets.** They run every frame on
  the UI thread, not the JS thread. Add the `'worklet'` directive as the
  first line of the function:

  ```tsx
  <Liveline
    data={data}
    value={value}
    formatValue={(v) => {
      'worklet';
      return `$${v.toFixed(2)}`;
    }}
  />
  ```

  The defaults (`v.toFixed(2)` and `HH:MM:SS`) are already worklets.

- **`style` is a React Native `ViewStyle`**, not `CSSProperties`. There is no
  `className` or `cursor` prop — those were web-only (CSS class + cursor
  affordance), and don't apply on native.

- **New optional `fonts` prop** (`Partial<LivelineFonts>`) lets you override
  the Skia fonts used for chart text (`label`, `value`, `badge`, `crosshair`,
  `orderbook`, `empty`, `refLabel`, `seriesLabel`). Defaults come from
  `matchFont` (Menlo on iOS, `monospace` on Android). Build custom fonts with
  `matchFont` from `@shopify/react-native-skia`:

  ```tsx
  import { matchFont } from '@shopify/react-native-skia';
  import { Liveline } from '@ajfuller/react-native-liveline';

  const valueFont = matchFont({
    fontFamily: 'Menlo',
    fontSize: 13,
    fontWeight: '700',
  });

  <Liveline data={data} value={value} fonts={{ value: valueFont }} />;
  ```

- **`scrub` is touch-drag**, implemented as a `react-native-gesture-handler`
  `Pan` gesture (the web version uses mouse hover). Requires your app root to
  be wrapped in `GestureHandlerRootView` (see Installation above).

- **`showValue` renders via an animated `TextInput`** (the "ReText" pattern —
  an `Animated.createAnimatedComponent(TextInput)` driven by
  `useAnimatedProps` from the UI thread), instead of a DOM node updated
  imperatively.

## How it works

- **UI-thread engine** — the per-frame render step runs inside a Reanimated
  `useFrameCallback` worklet, not React state/render.
- **`SkPicture` per frame** — each frame records draw commands into a Skia
  `PictureRecorder` and hands the resulting picture to `<Canvas><Picture /></Canvas>`,
  so nothing round-trips through the JS thread or bridge.
- **Survives a blocked JS thread** — because layout, config, and drawing all
  live in shared values and worklets, the chart keeps animating smoothly even
  while your JS thread is busy (e.g. a long synchronous computation, a slow
  screen transition, or a stress test `while` loop).
- **Canvas2D-shaped draw layer** — the draw code is ported from the web
  version against a worklet-safe `CanvasRenderingContext2D`-shaped shim over
  `SkCanvas`, preserving the original curve-fitting, layout, and animation
  logic almost verbatim.

## Credits

This library is a React Native port of
[**liveline**](https://github.com/benjitaylor/liveline), created by
[**Benji Taylor**](https://github.com/benjitaylor). The original web library
did the hard work: the chart design, the curve fitting and layout math, the
momentum/degen animation feel, the badge and crosshair interactions, and the
candlestick line-morph. This port keeps that design and behavior intact —
most of the draw and engine code here is adapted near-verbatim from Benji's
implementation, retargeted from Canvas2D/DOM to Reanimated worklets and Skia
so it can run on the UI thread natively.

If you find this useful, go star the
[original project](https://github.com/benjitaylor/liveline).

## License

MIT. Original work © 2025-2026 Benji Taylor; React Native port © 2026 Andrew
Fuller. See [LICENSE](./LICENSE).
