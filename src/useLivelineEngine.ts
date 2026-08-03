import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState, type LayoutChangeEvent } from 'react-native';
import {
  Skia,
  type SkPicture,
  type SkHostRect,
  type Transforms3d,
} from '@shopify/react-native-skia';
import {
  runOnJS,
  runOnUI,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { Gesture } from 'react-native-gesture-handler';
// `GestureType` only — deliberately NOT `LegacyComposedGesture`. This hook
// always returns a single `Gesture.Pan()` and never composes, so the old
// `ComposedGesture | GestureType` union was over-broad. It also mattered for
// compatibility: `LegacyComposedGesture` is a gesture-handler v3 name that
// does not exist in v2, and importing it forced the peerDependency to
// `>=3.0.0` — which fails `expo-doctor` for every Expo SDK 55 consumer, since
// that SDK pins `~2.30.0`. `GestureType` exists in both majors (verified
// against the published 2.30.0 typings), as do every builder method used
// below: Pan, enabled, activateAfterLongPress, onBegin/onStart/onUpdate/
// onFinalize.
import type { GestureType } from 'react-native-gesture-handler';
import {
  createCanvas2D,
  createSkiaCache,
  type SkiaCache,
} from './draw/canvas2d';
import { engineStep } from './engine/step';
import {
  createEngineState,
  disposeRetired,
  type EngineState,
} from './engine/state';
import type {
  EngineConfig,
  EngineConfigStep,
  MultiSeriesConfigEntry,
} from './engine/types';
import { isQuiescentCandidate } from './engine/quiescence';
import {
  MAX_DELTA_MS,
  QUIESCENT_FRAME_THRESHOLD,
  MIN_FRAME_INTERVAL_MS,
} from './engine/constants';
import {
  observeScrollRate,
  extrapolateScrollDx,
} from './engine/scrollExtrapolate';
import { accrualDeltaMs, suspendedDebtSec } from './engine/timeAccrual';
import {
  computeDelta,
  pointsEqual,
  candlesEqual,
  type DeltaResult,
} from './engine/dataDelta';
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
// Same idea as EMPTY_CANDLES, for a single multi-series entry with no
// previously-seen data (a series appearing for the first time).
const EMPTY_POINTS: LivelinePoint[] = [];

/** Size of the preallocated scroll-transform ring (`scrollTransformBufs`
 * below). Three rather than two gives two frames of separation before a
 * buffer is reused, so a consumer still holding last frame's array can't
 * observe it mutate. Ties the array length to both `%` rotations — resize
 * here, nowhere else. */
const SCROLL_TRANSFORM_BUF_COUNT = 3;

/**
 * Strip `data`/`candles` off the caller's config for mirroring into `cfg`
 * — they're synced through their own delta-updated shared values instead
 * (see `useLivelineEngine`'s mirror effect). Same treatment per multi-series
 * entry: each one's `data` is dropped too, synced instead through
 * `multiDataBuf` below.
 */
function toStepConfig(
  config: Omit<EngineConfig, 'hasOnHover' | 'noMotion'>,
  hasOnHover: boolean,
  noMotion: boolean,
  dataRev: number,
  candlesRev: number,
  multiRevs: Record<string, number> | undefined
): EngineConfigStep {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit them below
  const { data, candles, multiSeries, ...rest } = config;
  return {
    ...rest,
    hasOnHover,
    noMotion,
    dataRev,
    candlesRev,
    multiRevs,
    multiSeries: multiSeries?.map(({ id, value, palette, label }) => ({
      id,
      value,
      palette,
      label,
    })),
  };
}

/**
 * Seed `multiDataBuf`'s initial value from the caller's initial
 * `multiSeries` prop — mirrors `dataBuf`/`candlesBuf`'s mount-time seeding
 * above (see the comment there for why: the frame loop can start ticking on
 * the UI thread before the mount commit's mirror effect below has run).
 */
function buildInitialMultiData(
  multiSeries: MultiSeriesConfigEntry[] | undefined
): Record<string, LivelinePoint[]> {
  if (!multiSeries || multiSeries.length === 0) return {};
  const out: Record<string, LivelinePoint[]> = {};
  for (const series of multiSeries) out[series.id] = series.data.slice();
  return out;
}

/** A 0×0 picture used before the first frame is recorded. */
function makeEmptyPicture(): SkPicture {
  const recorder = Skia.PictureRecorder();
  recorder.beginRecording(Skia.XYWHRect(0, 0, 1, 1));
  return recorder.finishRecordingAsPicture();
}

export interface LivelineEngine {
  /**
   * The scroll layer: content that is recorded once and then translated
   * horizontally by `scrollTransform` instead of being re-recorded. Render
   * inside a `<Group transform={scrollTransform}>`, *below* `screenPicture`.
   *
   * Holds the single-series line's prefix stroke (the spline through all but
   * the last data point), re-recorded only when the line path cache misses.
   * Stays the empty placeholder in multi-series and candle mode, and on any
   * frame where the line can't be composited at alpha 1 — see
   * draw/lineScrollLayer.ts.
   */
  scrollPicture: SharedValue<SkPicture>;
  /**
   * The screen layer: everything drawn live, re-recorded every frame on the
   * UI thread — render via Skia's <Picture>, above the scroll layer.
   */
  screenPicture: SharedValue<SkPicture>;
  /**
   * Scroll-layer offset, `[{ translateX: dx }]` in screen pixels. Updated on
   * the UI thread every recorded frame; bind to `<Group transform>` so the
   * update stays a prop change (UI thread) rather than a structural change
   * (which would need a JS-thread reconcile).
   */
  scrollTransform: SharedValue<Transforms3d>;
  /** Pan gesture driving crosshair scrub — attach with <GestureDetector> */
  gesture: GestureType;
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
    toStepConfig(config, !!onHover, reduceMotion, 0, 0, undefined)
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
  // Multi-series points, keyed by series id — one delta-synced buffer per
  // series instead of a single array, since series are added/removed
  // independently of each other's data changing. Seeded at mount for the
  // same reason as dataBuf/candlesBuf above.
  const multiDataBuf = useSharedValue<Record<string, LivelinePoint[]>>(
    buildInitialMultiData(config.multiSeries)
  );
  const prevDataRef = useRef<LivelinePoint[]>(config.data);
  const prevCandlesRef = useRef<CandlePoint[]>(config.candles ?? EMPTY_CANDLES);
  // Bumped whenever the data buffer actually changes (delta or reset) —
  // consumed by the UI-thread line path cache as an exact data identity.
  const dataRevRef = useRef(0);
  // Same idea for the candles buffer — consumed by the UI-thread candle
  // cache. A revision counter (rather than the count/first/last-time
  // heuristic the cache also tracks) is what catches a consumer revising an
  // already-closed candle in place (a late trade correcting the previous
  // bar's OHLC): the heuristic fields don't move, but this does.
  const candlesRevRef = useRef(0);
  // Per-series previous-`data`-array reference, used purely as computeDelta's
  // `prev` argument for that series (mirrors prevDataRef/prevCandlesRef,
  // just keyed by series id instead of a single slot).
  const prevMultiDataRef = useRef<Map<string, LivelinePoint[]>>(new Map());
  // Per-series revision counters, bumped whenever that series' computeDelta
  // result isn't 'same' — consumed by the UI-thread multi-series line caches
  // as an exact per-series data identity, exactly like dataRevRef/
  // candlesRevRef above (see the EngineConfigStep.multiRevs doc comment).
  const multiRevsRef = useRef<Map<string, number>>(new Map());

  // Mirror the latest props every commit — the frame worklet reads cfg.value.
  useEffect(() => {
    const { data, candles } = config;
    // Diff first so the mirrored config carries the up-to-date revisions —
    // both dataRev and candlesRev must be bumped (when their delta isn't
    // 'same') before cfg.value is written below, so a commit that revises
    // data and/or candles is visible to the UI-thread caches immediately,
    // not one frame late.
    const dataDelta = computeDelta(prevDataRef.current, data, pointsEqual);
    if (dataDelta.kind !== 'same') dataRevRef.current++;

    const candlesNext = candles ?? EMPTY_CANDLES;
    const candlesDelta = computeDelta(
      prevCandlesRef.current,
      candlesNext,
      candlesEqual
    );
    if (candlesDelta.kind !== 'same') candlesRevRef.current++;

    // Same "diff before the config write" rule as above, for multi-series —
    // one computeDelta per series, keyed by id. `multiRevs` is rebuilt as a
    // plain object each commit (small — one number per series) so it can
    // cross into the worklet runtime alongside the rest of cfg; the deltas
    // themselves are applied to `multiDataBuf` after the cfg.value write
    // below, mirroring the data/candles ordering.
    let multiRevs: Record<string, number> | undefined;
    const multi = config.multiSeries;
    const prevMultiData = prevMultiDataRef.current;
    const multiRevsMap = multiRevsRef.current;
    const multiDeltas: {
      id: string;
      delta: DeltaResult<LivelinePoint>;
      data: LivelinePoint[];
    }[] = [];
    // Series ids to drop from multiDataBuf below — either individual series
    // removed from a still-active multi-series config, or every series at
    // once when the chart leaves multi-series mode entirely.
    let removedMultiIds: string[] | null = null;

    if (multi !== undefined && multi.length > 0) {
      multiRevs = {};
      for (const series of multi) {
        const prev = prevMultiData.get(series.id) ?? EMPTY_POINTS;
        const delta = computeDelta(prev, series.data, pointsEqual);
        if (delta.kind !== 'same') {
          multiRevsMap.set(series.id, (multiRevsMap.get(series.id) ?? 0) + 1);
        }
        multiRevs[series.id] = multiRevsMap.get(series.id) ?? 0;
        multiDeltas.push({ id: series.id, delta, data: series.data });
        prevMultiData.set(series.id, series.data);
      }
      // Drop bookkeeping (and buffered data) for series that no longer
      // exist, so none of prevMultiData/multiRevsMap/multiDataBuf can grow
      // without bound across a long-lived chart whose series churn.
      if (prevMultiData.size > multi.length) {
        const live = new Set(multi.map((s) => s.id));
        removedMultiIds = [];
        for (const id of prevMultiData.keys()) {
          if (!live.has(id)) {
            removedMultiIds.push(id);
            prevMultiData.delete(id);
          }
        }
        for (const id of multiRevsMap.keys())
          if (!live.has(id)) multiRevsMap.delete(id);
      }
    } else if (prevMultiData.size > 0) {
      // Left multi-series mode entirely (or the array emptied out) — drop
      // all per-series bookkeeping and buffered data so switching briefly
      // into multi-series and back doesn't leak previously-tracked series
      // forever.
      removedMultiIds = Array.from(prevMultiData.keys());
      prevMultiData.clear();
      multiRevsMap.clear();
    }

    cfg.value = toStepConfig(
      config,
      !!onHover,
      reduceMotion,
      dataRevRef.current,
      candlesRevRef.current,
      multiRevs
    );

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

    // Apply this commit's per-series deltas (and any removed-series
    // cleanup) to multiDataBuf in a single `.modify()` call — one UI-thread
    // write for the whole commit instead of one per series.
    if (multiDeltas.length > 0 || removedMultiIds) {
      multiDataBuf.modify(
        <T extends Record<string, LivelinePoint[]>>(value: T): T => {
          'worklet';
          // `.modify()`'s modifier type is itself generic (`<T extends
          // Value>(value: T) => T`), which TS won't let us index-assign into
          // directly (TS2862) — `buf` is the same object under a concrete,
          // writable type purely so the loop below can assign into it.
          const buf: Record<string, LivelinePoint[]> = value;
          for (const { id, delta, data: fullData } of multiDeltas) {
            if (delta.kind === 'delta') {
              const { drop, keep, tail } = delta;
              let arr = buf[id];
              if (arr === undefined) {
                arr = [];
                buf[id] = arr;
              }
              arr.splice(0, drop);
              arr.length = keep;
              for (const item of tail) arr.push(item);
            } else if (delta.kind === 'reset') {
              buf[id] = fullData.slice();
            }
          }
          if (removedMultiIds) {
            for (const id of removedMultiIds) delete buf[id];
          }
          return value;
        }
      );
    }
  });

  const state = useSharedValue<EngineState | null>(null);
  // Cross-frame cache for immutable Skia objects (gradients, dash effects,
  // blur mask filters, parsed colors) allocated by the Canvas2D shim. Lives
  // on the UI runtime for the component's lifetime — createCanvas2D is
  // recreated every frame, but the cache it's handed persists across frames
  // so identical inputs (stable gradient geometry/palette, the constant
  // dash pattern, etc.) resolve to the same native object instead of a fresh
  // allocation each frame. Mutated in place by worklets on the UI thread only
  // (never read from JS); nothing subscribes to it, so plain worklet mutation
  // is enough — no .modify() needed.
  const skiaCache = useSharedValue<SkiaCache>(createSkiaCache());
  // Reused SkRect for the picture recorder's cull rect (below) — built
  // lazily on the UI thread on the first frame, then mutated in place via
  // setXYWH every subsequent frame instead of a fresh Skia.XYWHRect(...)
  // allocation. Safe to reuse across frames despite `recorder` being a new
  // PictureRecorder every frame: SkPictureRecorder::beginRecording reads
  // the bounds and copies them into its own state synchronously (confirmed
  // against the binding's C++ source — same argument as canvas2d.ts's
  // pooled rect), so mutating this object for the next frame can't affect
  // a recording (or finished SkPicture) already produced from a prior
  // value.
  const cullRect = useSharedValue<SkHostRect | null>(null);
  const size = useSharedValue({ w: 0, h: 0 });
  const hoverX = useSharedValue<number | null>(null);
  // Wall-clock milliseconds the frame loop spent suspended, waiting to be
  // credited to `timeDebt` by the next frame that runs. The JS side (the
  // AppState listener / the `active` effect below, the only things that know
  // a suspension happened) computes the interval but accumulates it via
  // `runOnUI`, so every read-modify-write — the `+=` and the frame
  // callback's drain to 0 — happens serialized on the UI runtime.
  //
  // A plain number shared value rather than a reach into `state.value`:
  // EngineState holds Skia handles and is owned by the UI runtime, so the JS
  // thread must not touch it. Additive (`+=`) so two suspensions that both
  // land before a frame runs — app backgrounded and then `active={false}`,
  // say — can't lose one of the intervals.
  const pendingSuspendedMs = useSharedValue(0);
  const screenPicture = useSharedValue<SkPicture>(makeEmptyPicture());
  // The 1×1 do-nothing picture the scroll layer falls back to on every frame
  // that can't composite it (see StepOutput.scrollPicture) — and also its
  // initial value, so there is exactly ONE empty picture. Two distinct ones
  // would make `scrollPicture.value !== emptyPicture.value` read true before
  // the first recorded frame, i.e. claim a live scroll layer while nothing
  // is compositing. Liveness is `EngineState.scrollActive` instead, which the
  // recorded frame sets from an answer it already has.
  const emptyPicture = useSharedValue<SkPicture>(makeEmptyPicture());
  // The scroll layer — the single-series line's prefix stroke, recorded once
  // per line-cache miss by engine/lineScrollLayer.ts and translated by
  // `scrollTransform`. Starts (and, in the multi-series and candle
  // pipelines, stays) the empty placeholder, which draws nothing.
  const scrollPicture = useSharedValue<SkPicture>(emptyPicture.value);
  // `[{ translateX: dx }]` — the current transform, always one of the three
  // buffers in `scrollTransformBufs` below.
  const scrollTransform = useSharedValue<Transforms3d>([{ translateX: 0 }]);
  // Preallocated transform buffers, rotated through by `pushScrollDx` below.
  //
  // A shared value only notifies its mapper when it is REASSIGNED, never when
  // its contents are mutated — so `scrollTransform.value = [{ translateX: dx }]`
  // was the obvious shape, and it allocates an array AND an object on every
  // assignment: up to 120 assignments/sec on a ProMotion display, 240
  // short-lived allocations/sec on the UI thread, in a library whose entire
  // point is to allocate nothing per frame. Guarding on `dx` changing doesn't
  // help; dx is a continuously varying float, so the guard essentially never
  // fires while the chart scrolls.
  //
  // Rotating through a fixed ring gives both properties at once: the object
  // identity changes on every assignment (so the mapper always sees a change)
  // while steady-state allocation is exactly zero. Three slots rather than
  // two gives two frames of separation before a buffer is reused, so a
  // consumer still holding last frame's array can't observe it mutate.
  //
  // Rejected alternatives: `useDerivedValue` allocates the same array inside
  // the derivation instead of outside it, and self-assignment
  // (`x.value = x.value` after mutating) is not a notification contract
  // Reanimated documents or honors.
  const scrollTransformBufs = useSharedValue<Transforms3d[]>(
    Array.from({ length: SCROLL_TRANSFORM_BUF_COUNT }, () => [
      { translateX: 0 },
    ])
  );
  const scrollBufIdx = useSharedValue(0);
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

    // Dispose pictures retired on previous frames (screen, grid layer,
    // scroll layer — see EngineState.retiredPictures). First thing, before
    // any recording: entries are pushed later in the callback, so everything
    // drained here is at least one vsync old and its replacement has
    // composited.
    disposeRetired(s);

    const now_ms = info.timestamp ?? 0;

    // --- Suspended-loop credit. `frame.setActive(false)` stops accrual but
    // not the wall clock, and `dt` below is clamped to MAX_DELTA_MS, so a
    // minute in the background would otherwise contribute 50ms of debt
    // instead of 60s. For an unpaused chart that is right — it *should*
    // advance to the new wall-clock — and `suspendedDebtSec` preserves that
    // by scaling on `pauseProgress`, which is 0 for exactly those charts.
    // For a paused one, the missing debt is the whole absence: without this
    // the frozen window jumps a minute to the left on foreground, dumping a
    // minute of data off the left edge of a chart the user paused precisely
    // so it would hold still.
    //
    // Drained before anything else reads `s.timeDebt`, and before the
    // quiescence gate, so a chart that comes back still-quiescent (the
    // common case — nothing changed while it was away) is credited too.
    const pendingMs = pendingSuspendedMs.value;
    if (pendingMs > 0) {
      pendingSuspendedMs.value = 0;
      s.timeDebt += suspendedDebtSec(pendingMs, s.pauseProgress);
      // Restart the accrual clock at the resume instant. Everything before
      // now is accounted for by the credit just applied; leaving the stale
      // pre-suspension origin here would let the first quiescent frame
      // credit a clamped MAX_DELTA_MS on top of it.
      s.lastAccrualTimestamp = now_ms;
    }

    // Wall-clock time since the last frame that actually ran engineStep —
    // not info.timeSincePreviousFrame (vsync-to-vsync). These differ once
    // frame pacing (below) starts skipping vsyncs: every lerp() in the
    // engine is a continuous exponential decay, so applying it once with
    // dt=dt1+dt2 is identical to applying it twice with dt1 then dt2 — an
    // accumulated dt on the frame that does run is mathematically
    // equivalent to running every frame, not an approximation. Only
    // updated on frames that actually record (below), so a quiescence gap
    // correctly produces one large, clamped dt on resume — same as any
    // other stall today.
    const rawDt =
      s.lastFrameTimestamp === null ? 16.67 : now_ms - s.lastFrameTimestamp;
    const dt = Math.min(Math.max(rawDt, 0), MAX_DELTA_MS);

    // --- Quiescence: skip the picture re-record when the chart is
    // provably static (see engine/quiescence.ts). Break conditions first —
    // `cfg.value` is a fresh object every commit, so identity mismatch
    // means something committed since last frame (prop change, theme
    // switch, tick, ...); a canvas resize must also break it, compared
    // against the size of the *last recorded* frame (not the last-checked
    // frame, since size can't drift while frames are being skipped).
    const cfgUnchanged = s.lastCfgObj === c;
    const sizeUnchanged = w === s.lastRecordedW && h === s.lastRecordedH;
    s.lastCfgObj = c;
    if (
      cfgUnchanged &&
      sizeUnchanged &&
      isQuiescentCandidate(c, s, hoverX.value)
    ) {
      s.quiescentFrames++;
    } else {
      s.quiescentFrames = 0;
    }
    if (s.quiescentFrames > QUIESCENT_FRAME_THRESHOLD) {
      // Still accrue time debt exactly as engineStep would have
      // (`s.timeDebt += (dt/1000) * pauseProgress`, and pauseProgress === 1
      // is one of the quiescence conditions) — timeDebt drives the resume
      // catch-up animation, so skipping without it would change resume
      // behavior. The picture shared value is left untouched — it still
      // holds the last recorded (pixel-identical) frame.
      //
      // Measured against `lastAccrualTimestamp`, NOT `dt`. `dt` is measured
      // from `lastFrameTimestamp`, which by design does not move while
      // frames are skipped — so `dt` here is the time since the last
      // *recorded* frame, and re-crediting it every skipped frame counts
      // the same interval over and over: 16.7ms, 33.3, 50, 50, 50…, roughly
      // 3s of debt per 1s of real time at 60Hz (6s at 120Hz). The separate
      // accrual clock advances on every credited frame, so each frame
      // credits only its own interval and 1s of quiescence costs exactly 1s
      // of debt at any refresh rate. See engine/timeAccrual.ts.
      //
      // Both properties of `lastFrameTimestamp` documented above survive
      // untouched, because this branch still does not write it:
      //   1. `dt` on the frame that breaks quiescence is still one large,
      //      clamped delta covering the whole skipped span — the resume
      //      frame's lerps still take a single MAX_DELTA_MS step rather
      //      than a 16ms one.
      //   2. The pacing gate below still compares against "when state last
      //      actually advanced", so the frame that breaks quiescence is
      //      never itself paced out.
      s.timeDebt += accrualDeltaMs(s.lastAccrualTimestamp, now_ms) / 1000;
      s.lastAccrualTimestamp = now_ms;
      return;
    }

    // --- Frame pacing: on a high-refresh display (120Hz+), re-recording
    // every vsync buys nothing visually for a data chart but doubles CPU
    // work. MIN_FRAME_INTERVAL_MS is deliberately below the nominal 60fps
    // interval (16.67ms) to absorb vsync jitter — set it exactly at 16.67
    // and jitter alone would intermittently skip legitimate frames on a
    // real 60Hz display, silently halving its frame rate. Skipped frames
    // still let `dt` (above) accumulate correctly on the frame that runs.
    if (
      s.lastFrameTimestamp !== null &&
      now_ms - s.lastFrameTimestamp < MIN_FRAME_INTERVAL_MS
    ) {
      // Paced out — no re-record this vsync. But translating an
      // already-recorded picture is nearly free, so the scroll layer's
      // transform still advances, giving the scrolled content the display's
      // full refresh rate (120fps on ProMotion) while recording stays at ~60.
      // This is the point of putting scroll in a <Group transform> at all;
      // without it the layer would judder in lockstep with the paced
      // recording and the split would have bought a draw call and nothing
      // else.
      //
      // `dx` cannot be recomputed here — it needs `layout`, which lives
      // inside engineStep — so it is extrapolated from the last two recorded
      // frames (see engine/scrollExtrapolate.ts). Guarded three ways: only
      // when a scroll layer is actually compositing, only when a rate has
      // been observed, and only across a gap short enough for that rate to
      // still be true (MAX_SCROLL_EXTRAPOLATION_MS).
      //
      // Known consequence: the prefix now moves at 120Hz while the tail is
      // re-recorded at 60Hz, so on skipped vsyncs they shear by one frame of
      // scroll — chartW / (windowSecs * refreshHz), i.e. ~0.25px on a 10s
      // window and ~0.08px on 30s. Sub-pixel, but it is a shimmer at the
      // join rather than a clean offset. Verify on real 120Hz hardware; the
      // simulator renders at 60 and cannot show this either way.
      if (s.scrollActive) {
        const dxEx = extrapolateScrollDx(
          s.scrollDxLast,
          s.scrollDxLastT,
          s.scrollDxRate,
          now_ms
        );
        if (dxEx !== null) {
          // Rotate to the next preallocated buffer, mutate it, then assign:
          // a fresh identity for the mapper with no allocation. See
          // `scrollTransformBufs`.
          const i = (scrollBufIdx.value + 1) % SCROLL_TRANSFORM_BUF_COUNT;
          scrollBufIdx.value = i;
          const buf = scrollTransformBufs.value[i]!;
          (buf[0] as { translateX: number }).translateX = dxEx;
          scrollTransform.value = buf;
        }
      }
      return;
    }

    if (cullRect.value === null) {
      cullRect.value = Skia.XYWHRect(0, 0, w, h);
    } else {
      cullRect.value.setXYWH(0, 0, w, h);
    }
    const recorder = Skia.PictureRecorder();
    const canvas = recorder.beginRecording(cullRect.value);
    const ctx = createCanvas2D(canvas, fonts, skiaCache.value);
    // Pooled per-frame input struct (EngineState.frameInputs) refilled in
    // place — see `FrameInputs`. Named fields instead of twelve positional
    // arguments, at no allocation cost.
    const frameInputs = s.frameInputs;
    frameInputs.w = w;
    frameInputs.h = h;
    frameInputs.hoverPixelX = hoverX.value;
    frameInputs.dt = dt;
    frameInputs.now_ms = now_ms;
    frameInputs.fonts = fonts;
    frameInputs.data = dataBuf.value;
    frameInputs.candles = candlesBuf.value;
    frameInputs.multiData = multiDataBuf.value;
    const result = engineStep(ctx, c, s, frameInputs);
    // Retire the outgoing screen picture — replaced every recorded frame,
    // so leaving it to GC is ~60 native pictures/sec of pressure (see
    // EngineState.retiredPictures). Still composited until this assignment
    // lands, hence retire-now/dispose-next-frame rather than dispose here.
    s.retiredPictures.push(screenPicture.value);
    screenPicture.value = recorder.finishRecordingAsPicture();
    // Publish this frame's scroll layer. `null` means the layer must not
    // composite at all (see StepOutput.scrollPicture) — the empty 1×1
    // placeholder goes up instead of leaving the previous frame's picture
    // in place, since the screen picture then already contains the whole
    // line. Both writes land in this same UI-thread tick as the screen
    // picture, so the declarative tree's mapper always sees a consistent
    // pair. Guarded on identity: an unchanged picture must not be
    // reassigned, or every frame would look like a change to the mapper.
    const nextScroll = result.scrollPicture ?? emptyPicture.value;
    if (scrollPicture.value !== nextScroll) scrollPicture.value = nextScroll;
    // Whether a scroll layer is live this frame, recorded where the answer is
    // already known — the paced-out branch above reads it instead of
    // comparing two picture shared values (two JSI reads per vsync, and wrong
    // before the first recorded frame if the placeholders weren't identical).
    const scrollActive = result.scrollPicture !== null;
    // Did the thing `dx` is an offset OF change since the last recorded
    // frame? Two ways it can: the layer started or stopped compositing (dx
    // is 0 on every frame it isn't live), or the prefix picture was rebuilt,
    // which resets dx to ~0 while the line on screen does not move. Either
    // makes this frame's dx and the last one's incommensurable, so no rate
    // is observable across the pair — see observeScrollRate's `layerChanged`
    // parameter. Read before `s.scrollActive` is overwritten below.
    const buildRev = s.lineCache.buildRev;
    const layerChanged =
      scrollActive !== s.scrollActive || buildRev !== s.scrollDxBuildRev;
    s.scrollActive = scrollActive;
    const dx = result.scrollDx;
    // Observed dx-per-ms across the last two RECORDED frames, used to
    // extrapolate the transform on paced-out vsyncs above — see
    // engine/scrollExtrapolate.ts for why the rate is observed rather than
    // derived, and for the guards.
    s.scrollDxRate = observeScrollRate(
      s.scrollDxLast,
      s.scrollDxLastT,
      dx,
      now_ms,
      layerChanged
    );
    s.scrollDxLast = dx;
    s.scrollDxLastT = now_ms;
    s.scrollDxBuildRev = buildRev;
    // Exact value always wins over whatever a skipped vsync extrapolated, so
    // extrapolation error can never accumulate past one frame. Same
    // rotate-mutate-assign as the paced-out branch above.
    const bufIdx = (scrollBufIdx.value + 1) % SCROLL_TRANSFORM_BUF_COUNT;
    scrollBufIdx.value = bufIdx;
    const buf = scrollTransformBufs.value[bufIdx]!;
    (buf[0] as { translateX: number }).translateX = dx;
    scrollTransform.value = buf;
    s.lastRecordedW = w;
    s.lastRecordedH = h;
    s.lastFrameTimestamp = now_ms;
    // This frame credited its own debt inside engineStep (off `dt`), so the
    // accrual clock advances here too — the two are equal on every recorded
    // frame and diverge only across skips. Keeping them in step here is what
    // makes the first quiescent frame after a record measure from that
    // record rather than from whenever quiescence last ended.
    s.lastAccrualTimestamp = now_ms;

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

  // Wall-clock instant the frame loop was suspended, or null while it runs.
  // `Date.now()` rather than the frame callback's `info.timestamp`: no frame
  // callback fires while suspended, so there is no UI-thread clock reading
  // to be had at either end of the interval.
  const suspendedAtRef = useRef<number | null>(null);
  // The single place `frame.setActive` is called, so that no suspension can
  // be entered or left without the elapsed interval being accounted for.
  // Both suspension causes route through it: backgrounding and
  // `active={false}` stop accrual identically, and a chart scrolled off a
  // FlatList for a minute has exactly the same paused-chart-jumps-forward
  // bug as a backgrounded one.
  const setFrameActive = useCallback(
    (next: boolean) => {
      if (next) {
        const at = suspendedAtRef.current;
        if (at !== null) {
          suspendedAtRef.current = null;
          // `Math.max(0, ...)` guards a wall clock that stepped backwards
          // (NTP correction, user changing the device time zone/clock while
          // the app was away) — never credit negative debt.
          const creditMs = Math.max(0, Date.now() - at);
          if (creditMs > 0) {
            // Accumulate ON the UI runtime, where the frame callback's
            // drain (`pendingSuspendedMs.value = 0`) also runs. A JS-side
            // `+=` is a cross-thread read-modify-write: a fast
            // background/foreground flap could read a value the UI thread
            // had already drained but not yet propagated back, re-adding an
            // interval that was already credited. On the UI runtime both
            // writers are serialized and the race is gone.
            runOnUI((ms: number) => {
              'worklet';
              pendingSuspendedMs.value += ms;
            })(creditMs);
          }
        }
      } else if (suspendedAtRef.current === null) {
        // Only the FIRST transition into suspension stamps the clock: with
        // two independent causes, `active={false}` while already
        // backgrounded must not restart the interval and swallow the time
        // already spent in the background.
        suspendedAtRef.current = Date.now();
      }
      frame.setActive(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- frame and pendingSuspendedMs are identity-stable
    []
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (status) => {
      appForegroundRef.current = status === 'active';
      setFrameActive(appForegroundRef.current && activePropRef.current);
    });
    return () => sub.remove();
  }, [setFrameActive]);

  useEffect(() => {
    activePropRef.current = activeProp;
    setFrameActive(appForegroundRef.current && activeProp);
  }, [activeProp, setFrameActive]);

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

  return {
    scrollPicture,
    screenPicture,
    scrollTransform,
    gesture,
    onLayout,
    valueText,
    valueColor,
  };
}
