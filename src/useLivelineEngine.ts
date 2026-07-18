import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState, type LayoutChangeEvent } from 'react-native';
import { Skia, type SkPicture } from '@shopify/react-native-skia';
import {
  runOnJS,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { Gesture } from 'react-native-gesture-handler';
// `Gesture.Pan()` is the classic (pre-v3) builder API, whose composed-gesture
// result type the package now exposes as `LegacyComposedGesture` — the plain
// `ComposedGesture` name was reassigned to the new v3 declarative gesture
// model, which this classic API doesn't produce.
import type {
  LegacyComposedGesture as ComposedGesture,
  GestureType,
} from 'react-native-gesture-handler';
import { createCanvas2D } from './draw/canvas2d';
import { engineStep } from './engine/step';
import { createEngineState, type EngineState } from './engine/state';
import type { EngineConfig } from './engine/types';
import { MAX_DELTA_MS } from './engine/constants';
import type { HoverPoint, LivelineFonts } from './types';

export type { EngineConfig } from './engine/types';

/** A 0×0 picture used before the first frame is recorded. */
function makeEmptyPicture(): SkPicture {
  const recorder = Skia.PictureRecorder();
  recorder.beginRecording(Skia.XYWHRect(0, 0, 1, 1));
  return recorder.finishRecordingAsPicture();
}

export interface LivelineEngine {
  /** Re-recorded every frame on the UI thread — render via Skia's <Picture> */
  picture: SharedValue<SkPicture>;
  /** Pan gesture driving crosshair scrub — attach with <GestureDetector> */
  gesture: ComposedGesture | GestureType;
  /** Attach to the chart container to feed the engine its size */
  onLayout: (e: LayoutChangeEvent) => void;
  /** Live value text (when showValue) — bind via useAnimatedProps */
  valueText: SharedValue<string>;
  /** Live value color ('' = inherit) — bind via useAnimatedStyle */
  valueColor: SharedValue<string>;
}

/**
 * The liveline render engine, RN edition.
 *
 * The web version runs a requestAnimationFrame loop on the main thread and
 * paints a 2D canvas. Here the identical per-frame step runs as a Reanimated
 * frame callback on the UI thread, recording an SkPicture that the <Canvas>
 * displays — chart animation survives a blocked JS thread.
 *
 * `config` is mirrored into a shared value on every commit (same contract as
 * the web version's `configRef.current = config`). `fonts` must be a stable
 * (memoized) object.
 */
export function useLivelineEngine(
  config: Omit<EngineConfig, 'hasOnHover' | 'noMotion'>,
  fonts: LivelineFonts,
  onHover?: (point: HoverPoint | null) => void
): LivelineEngine {
  const reduceMotion = useReducedMotion();

  const cfg = useSharedValue<EngineConfig>({
    ...config,
    hasOnHover: !!onHover,
    noMotion: reduceMotion,
  });
  // Mirror the latest props every commit — the frame worklet reads cfg.value
  useEffect(() => {
    cfg.value = { ...config, hasOnHover: !!onHover, noMotion: reduceMotion };
  });

  const state = useSharedValue<EngineState | null>(null);
  const size = useSharedValue({ w: 0, h: 0 });
  const hoverX = useSharedValue<number | null>(null);
  const picture = useSharedValue<SkPicture>(makeEmptyPicture());
  const valueText = useSharedValue('');
  const valueColor = useSharedValue('');

  // Stable JS-side hover dispatcher (runOnJS needs a stable target)
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  const emitHover = useCallback((point: HoverPoint | null) => {
    onHoverRef.current?.(point);
  }, []);

  const frame = useFrameCallback((info) => {
    'worklet';
    const w = size.value.w;
    const h = size.value.h;
    if (w <= 0 || h <= 0) return;

    const c = cfg.value;
    let s = state.value;
    if (s === null) {
      s = createEngineState(
        c.value,
        c.windowSecs,
        c.loading ?? false,
        c.candleWidth ?? 1
      );
      state.value = s;
    }

    const now_ms = info.timestamp ?? 0;
    const dt = Math.min(info.timeSincePreviousFrame ?? 16.67, MAX_DELTA_MS);

    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(Skia.XYWHRect(0, 0, w, h));
    const ctx = createCanvas2D(canvas, fonts);
    const result = engineStep(ctx, c, s, w, h, hoverX.value, dt, now_ms);
    picture.value = recorder.finishRecordingAsPicture();

    if (result.valueText !== null) valueText.value = result.valueText;
    if (result.valueColor !== null) valueColor.value = result.valueColor;
    if (result.emitHover !== undefined) {
      runOnJS(emitHover)(result.emitHover);
    }
  }, true);

  // Pause the loop while the app is backgrounded
  useEffect(() => {
    const sub = AppState.addEventListener('change', (status) => {
      frame.setActive(status === 'active');
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- frame is identity-stable
  }, []);

  // Touch-drag scrub — mirrors the web version's touchmove handling
  // (crosshair follows the finger; releasing fades it out).
  const scrubEnabled = config.scrub;
  const hasOnHover = !!onHover;
  const gesture = useMemo(() => {
    return Gesture.Pan()
      .enabled(scrubEnabled)
      .onBegin((e) => {
        'worklet';
        hoverX.value = e.x;
      })
      .onUpdate((e) => {
        'worklet';
        hoverX.value = e.x;
      })
      .onFinalize(() => {
        'worklet';
        hoverX.value = null;
        if (hasOnHover) runOnJS(emitHover)(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hoverX is identity-stable
  }, [scrubEnabled, hasOnHover, emitHover]);

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      size.value = { w: width, h: height };
    },
    [size]
  );

  return { picture, gesture, onLayout, valueText, valueColor };
}
