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
import type { EngineConfig, EngineConfigStep } from './engine/types';
import { MAX_DELTA_MS } from './engine/constants';
import { computeDelta, pointsEqual, candlesEqual } from './engine/dataDelta';
import type {
  HoverPoint,
  LivelineFonts,
  LivelinePoint,
  CandlePoint,
} from './types';

export type { EngineConfig } from './engine/types';

// A stable reference used as the `candles ?? EMPTY_CANDLES` fallback so
// callers that never pass `candles` (line mode) get the *same* array
// object across commits — computeDelta's `prev === next` fast path then
// reports 'same' every commit instead of a spurious 'reset' (which a
// fresh `[]` literal on every render would otherwise cause).
const EMPTY_CANDLES: CandlePoint[] = [];

/**
 * Strip `data`/`candles` off the caller's config for mirroring into `cfg`
 * — they're synced through their own delta-updated shared values instead
 * (see `useLivelineEngine`'s mirror effect).
 */
function toStepConfig(
  config: Omit<EngineConfig, 'hasOnHover' | 'noMotion'>,
  hasOnHover: boolean,
  noMotion: boolean
): EngineConfigStep {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit them below
  const { data, candles, ...rest } = config;
  return { ...rest, hasOnHover, noMotion };
}

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

  // `data`/`candles` are excluded from `cfg` and mirrored through their own
  // delta-updated shared values instead (see the effect below) — they're
  // the only fields that can grow to thousands of points, and re-deep-
  // converting them whole on every commit is exactly the cost this hook
  // exists to avoid. Everything else in EngineConfig is small and stays
  // fully mirrored every commit, same as before.
  const cfg = useSharedValue<EngineConfigStep>(
    toStepConfig(config, !!onHover, reduceMotion)
  );
  // Seed the buffers (and the "previous" refs the mirror effect diffs
  // against) with the actual initial data/candles, copied once — otherwise
  // the frame loop, which can start ticking on the UI thread before the
  // mount commit's effect below has run, would briefly render off an empty
  // buffer instead of the caller's initial data.
  const dataBuf = useSharedValue<LivelinePoint[]>(config.data.slice());
  const candlesBuf = useSharedValue<CandlePoint[]>(
    (config.candles ?? EMPTY_CANDLES).slice()
  );
  const prevDataRef = useRef<LivelinePoint[]>(config.data);
  const prevCandlesRef = useRef<CandlePoint[]>(config.candles ?? EMPTY_CANDLES);

  // Mirror the latest props every commit — the frame worklet reads cfg.value.
  useEffect(() => {
    cfg.value = toStepConfig(config, !!onHover, reduceMotion);

    const { data, candles } = config;
    const dataDelta = computeDelta(prevDataRef.current, data, pointsEqual);
    if (dataDelta.kind === 'delta') {
      const { drop, keep, tail } = dataDelta;
      dataBuf.modify((arr) => {
        'worklet';
        arr.splice(0, drop);
        arr.length = keep;
        for (const item of tail) arr.push(item);
        return arr;
      });
    } else if (dataDelta.kind === 'reset') {
      dataBuf.value = data.slice();
    }
    prevDataRef.current = data;

    const candlesNext = candles ?? EMPTY_CANDLES;
    const candlesDelta = computeDelta(
      prevCandlesRef.current,
      candlesNext,
      candlesEqual
    );
    if (candlesDelta.kind === 'delta') {
      const { drop, keep, tail } = candlesDelta;
      candlesBuf.modify((arr) => {
        'worklet';
        arr.splice(0, drop);
        arr.length = keep;
        for (const item of tail) arr.push(item);
        return arr;
      });
    } else if (candlesDelta.kind === 'reset') {
      candlesBuf.value = candlesNext.slice();
    }
    prevCandlesRef.current = candlesNext;
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
    const result = engineStep(
      ctx,
      c,
      s,
      w,
      h,
      hoverX.value,
      dt,
      now_ms,
      dataBuf.value,
      candlesBuf.value
    );
    picture.value = recorder.finishRecordingAsPicture();

    if (result.valueText !== null) valueText.value = result.valueText;
    if (result.valueColor !== null) valueColor.value = result.valueColor;
    if (result.emitHover !== undefined) {
      runOnJS(emitHover)(result.emitHover);
    }
  }, true);

  // Suspend the frame loop when either the app is backgrounded or the
  // caller marks this chart inactive (e.g. off-screen in a list, via
  // `active={false}` wired to a FlatList's `onViewableItemsChanged`). The
  // two conditions combine with AND — backgrounding must still suspend a
  // chart with `active=true`, and `active=false` must stay suspended even
  // if the app comes back to the foreground. `activePropRef` holds the
  // latest `active` prop so the AppState listener (subscribed once) never
  // reads a stale value.
  const activeProp = config.active ?? true;
  const activePropRef = useRef(activeProp);
  // Fail open at mount: treat anything but explicit 'background' as
  // foregrounded. AppState can read 'unknown' (native state not yet
  // delivered) or 'inactive' (cold-launch transition) with the app visibly
  // in the foreground, and 'unknown' is not guaranteed a subsequent change
  // event — initializing from `=== 'active'` would leave the chart stuck on
  // the empty placeholder picture until the next background/foreground
  // cycle. The change listener still uses strict `=== 'active'`.
  const appForegroundRef = useRef(AppState.currentState !== 'background');

  useEffect(() => {
    const sub = AppState.addEventListener('change', (status) => {
      appForegroundRef.current = status === 'active';
      frame.setActive(appForegroundRef.current && activePropRef.current);
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- frame is identity-stable
  }, []);

  useEffect(() => {
    activePropRef.current = activeProp;
    frame.setActive(appForegroundRef.current && activeProp);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- frame is identity-stable
  }, [activeProp]);

  // Touch-drag scrub — mirrors the web version's touchmove handling
  // (crosshair follows the finger; releasing fades it out).
  const scrubEnabled = config.scrub;
  const hasOnHover = !!onHover;
  const activationDelay = config.scrubActivationDelay ?? 0;
  const gesture = useMemo(() => {
    const finalize = () => {
      'worklet';
      // With an activation delay, onFinalize also fires when the gesture
      // fails without ever activating (a flick-scroll stolen by an outer
      // ScrollView — the exact case the delay exists for). Nothing was
      // hovered, so don't emit a spurious onHover(null) to the consumer.
      if (hoverX.value === null) return;
      hoverX.value = null;
      if (hasOnHover) runOnJS(emitHover)(null);
    };

    if (activationDelay > 0) {
      // Require a deliberate hold before the crosshair takes over — set
      // hoverX in onStart/onUpdate (never onBegin, which fires pre-activation
      // at touch-down) so nothing happens until the long-press activates.
      // That keeps a flick-scroll on an outer ScrollView/FlatList free to
      // pass through on first touch.
      return Gesture.Pan()
        .enabled(scrubEnabled)
        .activateAfterLongPress(activationDelay)
        .onStart((e) => {
          'worklet';
          hoverX.value = e.x;
        })
        .onUpdate((e) => {
          'worklet';
          hoverX.value = e.x;
        })
        .onFinalize(finalize);
    }

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
      .onFinalize(finalize);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hoverX is identity-stable
  }, [scrubEnabled, hasOnHover, emitHover, activationDelay]);

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      size.value = { w: width, h: height };
    },
    [size]
  );

  return { picture, gesture, onLayout, valueText, valueColor };
}
