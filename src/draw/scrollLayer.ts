/**
 * Generic cross-frame cache for a **scroll layer**: an SkPicture recorded
 * once in build-time screen coordinates and re-composited every frame at a
 * horizontal offset, instead of being re-recorded.
 *
 * This promotes the technique draw/lineCache.ts already applies at the *path*
 * level (`addPath(prefix)` + `offset(dx, 0)`) up to the *picture* level. Most
 * of what the frame callback records is content whose only per-frame change is
 * that the chart scrolls left because "now" advanced; for that content a
 * rebuild is pure waste.
 *
 * Composition happens in the declarative tree, not with canvas calls: the
 * picture goes under a transform-only Skia `<Group>`, whose `translateX` is
 * the slot's `dx` (`lineScrollDx` in draw/lineCache.ts for today's one
 * consumer). See `Liveline.tsx`:
 *
 * ```tsx
 * <Group transform={scrollTransform}>
 *   <Picture picture={scrollPicture} />
 * </Group>
 * ```
 *
 * A transform-only `<Group>` creates no layer, so the scroll layer and the
 * per-frame screen picture share one surface and composite in tree order.
 * Any clipping the content needs is recorded *into* the picture at build time
 * (see engine/lineScrollLayer.ts, which explains why that is sound for
 * horizontal-only motion); this module deliberately holds no clip state.
 *
 * The invariant future maintainers must not break: **alpha must be exactly
 * 1.** `ctx.drawPicture` ignores `globalAlpha` — Skia's drawPicture takes no
 * paint argument (canvas2d.ts:139-143). Fading a picture would need
 * `saveLayerAlpha`, which allocates an offscreen render target, precisely the
 * Android cost this work exists to avoid. So every consumer gates on
 * `scrollLayerUsable(slot, alpha)` and falls back to live drawing during the
 * reveal morph, the loading/empty crossfade and scrub dimming.
 * draw/index.ts:218 already gates the grid picture on `reveal >= 1` for
 * exactly this reason.
 *
 * A second consequence of caching pictures rather than paths: **palette is
 * part of every scroll-layer key**. A picture bakes color, stroke width and
 * gradient stops that a path did not.
 *
 * Kept free of Skia imports (`Picture` is a structural type parameter, exactly
 * like draw/gridLayer.ts) so jest can exercise the key comparison with fake
 * picture objects, with no native binding loaded.
 */

/**
 * A key dimension compared by reference/primitive identity rather than as a
 * number: palette color strings, and formatter functions (`formatTime`,
 * `formatValue`) whose identity is the only cheap proxy for their behaviour.
 */
export type ScrollLayerKeyRef = string | object | null;

/**
 * ## Why a push-built key array rather than named key fields
 *
 * The existing caches (lineCache, gridLayer) spell every key dimension out as
 * a named `kFoo` field and compare them field-by-field. That is ideal when one
 * module owns one cache — but this module is **designed for N consumers and
 * currently has exactly 1** (`lineScroll`; `candleScroll` and `axisScroll` are
 * plausible future ones). Their key dimensions would barely overlap: the line
 * keys on whether its prefix was rebuilt, candles on the closed-candle
 * revision and candle width, the axis on the tick interval and the visible
 * label set. Named fields would force every new dimension of any consumer to
 * be added to this module, i.e. every consumer would either fork the module or
 * bloat it with fields the others never read.
 *
 * So the key is a **positional array the consumer pushes into**, and the
 * comparison lives here, written exactly once. A consumer adds a dimension by
 * adding one `scrollLayerPushNum` call at its own call site; this file does
 * not change. `kNumLen`/`kRefLen` record how many slots were actually pushed,
 * so a consumer that changes its own key arity still invalidates correctly
 * rather than silently comparing a prefix.
 *
 * Two arrays, not one, and neither is `unknown[]`:
 *
 * - A numeric-only key (the obvious first design) cannot express the two
 *   dimensions the architecture *requires*: palette colors are strings, and
 *   formatter identity is a function reference. Hence `nRef`/`kRef`.
 * - Merging both into a single `unknown[]` would make the per-frame comparison
 *   loop polymorphic over numbers, strings and functions. Splitting keeps the
 *   hot numeric loop — which is the overwhelming majority of dimensions —
 *   monomorphic.
 *
 * The cost of the array form versus named fields is that a dimension is
 * identified by push order, not by name, so **push order must be identical
 * between the frames being compared**. Consumers must therefore push
 * unconditionally, never inside an `if`. Each consumer should keep its pushes
 * in one small `writeXKey(slot, ...)` helper so there is a single push order
 * to read.
 *
 * Zero allocation per frame: both the committed key and the scratch candidate
 * key are arrays owned by the slot, written in place by index. They grow once,
 * on the first few frames, and never again.
 */
export interface ScrollLayerSlot<Picture> {
  /** The recorded picture, in build-time screen coordinates. `null` until the
   * first build; that null is also the slot's validity flag, matching
   * `LineCacheSlot.prefix` and `GridLayerSlot.picture`. */
  picture: Picture | null;
  /** Pictures this slot replaced, awaiting `dispose()` — drained by
   * `disposeRetired` (engine/state.ts) one frame after replacement, once the
   * tree has composited the successor. The slot can't reach `EngineState`,
   * so it carries its own bin (mirrors `GridLayerSlot.retired`). */
  retired: Picture[];

  /** Committed numeric key (the inputs the current `picture` was built from). */
  kNum: number[];
  kNumLen: number;
  /** Committed reference/string key. */
  kRef: ScrollLayerKeyRef[];
  kRefLen: number;

  /** Scratch numeric key: this frame's candidate, built by `scrollLayerPushNum`. */
  nNum: number[];
  nNumLen: number;
  /** Scratch reference/string key. */
  nRef: ScrollLayerKeyRef[];
  nRefLen: number;
}

export function createScrollLayerSlot<Picture>(): ScrollLayerSlot<Picture> {
  'worklet';
  return {
    picture: null,
    retired: [],
    kNum: [],
    kNumLen: 0,
    kRef: [],
    kRefLen: 0,
    nNum: [],
    nNumLen: 0,
    nRef: [],
    nRefLen: 0,
  };
}

// NOTE: worklet declaration order. The worklets babel plugin rewrites
// 'worklet' function declarations into const-assigned worklet objects
// (hoisting is lost) and captures each worklet's closure at module evaluation
// time, so a helper referenced before its own const assignment has run is
// captured as `undefined` and crashes on the UI thread — see the same NOTE at
// draw/canvas2d.ts:163-171. Every function below that calls another worklet in
// this file is therefore declared *after* the one it calls:
//   scrollLayerCommitKey  →  called by scrollLayerBuilt
// Keep that ordering if you add anything here.

/**
 * Starts building this frame's candidate key. Call before any push; every
 * push for the frame must follow, in the same order every frame.
 */
export function scrollLayerBeginKey<Picture>(
  slot: ScrollLayerSlot<Picture>
): void {
  'worklet';
  slot.nNumLen = 0;
  slot.nRefLen = 0;
}

/** Appends one numeric dimension to this frame's candidate key. */
export function scrollLayerPushNum<Picture>(
  slot: ScrollLayerSlot<Picture>,
  v: number
): void {
  'worklet';
  slot.nNum[slot.nNumLen] = v;
  slot.nNumLen++;
}

/**
 * Appends one identity-compared dimension (palette color string, formatter
 * function) to this frame's candidate key. Compared with `===`, so a
 * behaviourally-identical but freshly-allocated formatter invalidates — the
 * same conservative trade gridLayer.ts makes for `kFormatValue`.
 */
export function scrollLayerPushRef<Picture>(
  slot: ScrollLayerSlot<Picture>,
  v: ScrollLayerKeyRef
): void {
  'worklet';
  slot.nRef[slot.nRefLen] = v;
  slot.nRefLen++;
}

/**
 * Pure, allocation-free predicate: true when the slot holds a picture whose
 * committed key equals the candidate key just pushed for this frame.
 *
 * Read-only — it does not commit. A consumer calls this before doing any
 * expensive work, exactly as `lineCacheHits` is called before building
 * `decimated`/`pts`, and this is the ONE place the comparison is written so
 * consumers cannot drift apart.
 *
 * Arity is compared first: a consumer that changed how many dimensions it
 * pushes gets a miss rather than a silent prefix match.
 */
export function scrollLayerKeyHits<Picture>(
  slot: ScrollLayerSlot<Picture>
): boolean {
  'worklet';
  if (slot.picture === null) return false;
  if (slot.nNumLen !== slot.kNumLen || slot.nRefLen !== slot.kRefLen)
    return false;
  for (let i = 0; i < slot.nNumLen; i++) {
    if (slot.nNum[i] !== slot.kNum[i]) return false;
  }
  for (let i = 0; i < slot.nRefLen; i++) {
    if (slot.nRef[i] !== slot.kRef[i]) return false;
  }
  return true;
}

/** Promotes this frame's candidate key to the committed key (call on rebuild). */
export function scrollLayerCommitKey<Picture>(
  slot: ScrollLayerSlot<Picture>
): void {
  'worklet';
  for (let i = 0; i < slot.nNumLen; i++) slot.kNum[i] = slot.nNum[i]!;
  for (let i = 0; i < slot.nRefLen; i++) slot.kRef[i] = slot.nRef[i]!;
  slot.kNumLen = slot.nNumLen;
  slot.kRefLen = slot.nRefLen;
}

/**
 * Records a completed rebuild: stores the picture and commits the key. The
 * two are written together on purpose — `picture` is the slot's validity
 * flag, so committing one without the other would leave the slot advertising
 * a picture it is stale for (or throwing away a good one).
 *
 * The slot deliberately keeps no build-time position reference of its own.
 * The offset the picture is composited at is the consumer's to supply, from
 * whatever the recording was made from — for today's one consumer that is
 * `lineScrollDx(lineSlot, layout)` against the line cache slot the prefix
 * came from, so the picture and the transform cannot disagree.
 */
export function scrollLayerBuilt<Picture>(
  slot: ScrollLayerSlot<Picture>,
  picture: Picture
): void {
  'worklet';
  // Retire (don't drop) the outgoing picture — it may still be composited
  // by the declarative tree until this frame's publish lands, so it is
  // disposed one frame later by disposeRetired (engine/state.ts), not here.
  if (slot.picture !== null) slot.retired.push(slot.picture);
  slot.picture = picture;
  scrollLayerCommitKey(slot);
}

/**
 * True when the slot may be composited this frame: it holds a picture and the
 * composite alpha is exactly 1. See the header invariant — `drawPicture` ignores
 * `globalAlpha`, so at alpha < 1 the consumer must fall back to live drawing
 * rather than compositing at the wrong opacity. `>= 1` rather than `=== 1`
 * mirrors draw/index.ts:218's `reveal >= 1`, which tolerates a lerp that
 * overshoots to exactly its target.
 */
export function scrollLayerUsable<Picture>(
  slot: ScrollLayerSlot<Picture>,
  alpha: number
): boolean {
  'worklet';
  return slot.picture !== null && alpha >= 1;
}
