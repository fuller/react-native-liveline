import {
  Skia,
  PaintStyle,
  StrokeCap,
  StrokeJoin,
  BlendMode,
  TileMode,
  ClipOp,
  BlurStyle,
} from '@shopify/react-native-skia';
import type {
  SkCanvas,
  SkFont,
  SkPaint,
  SkPath,
  SkColor,
  SkShader,
  SkPathEffect,
  SkMaskFilter,
  SkPicture,
  SkHostRect,
} from '@shopify/react-native-skia';
import { Platform } from 'react-native';
import type { LivelineFonts } from '../types';

// Mask-filter (blurred) shadows re-raster the blur on every recorded frame.
// That recurring cost lands hardest on Android's typically weaker GPUs (and
// is brutal on emulators), so Android gets a simplified fallback: a flat
// offset silhouette instead of a blur — see fill(). Declared above the
// worklets that capture it (see the closure-capture note below).
const BLUR_SHADOWS = Platform.OS !== 'android';

// The "no dash" value for the shim's `lineDash` state. Shared module-level
// constant so retargeting the ctx for a new recording can reset the dash
// state without allocating a fresh empty array — same INVARIANT as
// setLineDash's callers: nothing may ever mutate a dash array in place.
const NO_DASH: number[] = [];

/**
 * A Canvas2D-flavored adapter over Skia's SkCanvas.
 *
 * The draw modules were ported from the web version of liveline, which
 * renders through CanvasRenderingContext2D. Rather than rewriting ~1,700
 * lines of carefully-tuned drawing code against Skia idioms (and risking
 * behavioral drift in the alpha/gradient threading), this shim implements
 * the exact Canvas2D subset that code uses. Everything runs as a worklet
 * on the UI thread.
 *
 * Deviations from Canvas2D:
 * - `font` holds an SkFont (not a CSS string) — pick from `ctx.fonts`
 * - only 'source-over' and 'destination-out' composite ops are supported
 * - `arc()` supports full circles and simple arcs (no ccw handling)
 */

export interface Gradient2D {
  isGradient: true;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  offsets: number[];
  colors: string[];
  addColorStop(offset: number, color: string): void;
}

/** A plain color string, a gradient, or a pre-built SkColor (Float32Array,
 * see math/color.ts's `rgbColor`) — the latter skips both string formatting
 * and the native Skia.Color() parse for animated blends. */
export type Style2D = string | Gradient2D | SkColor;
export type LineCap2D = 'butt' | 'round' | 'square';
export type LineJoin2D = 'miter' | 'round' | 'bevel';
export type TextAlign2D = 'left' | 'center' | 'right';
export type TextBaseline2D = 'alphabetic' | 'middle' | 'top';
export type CompositeOp2D = 'source-over' | 'destination-out';

export interface Ctx2D {
  fillStyle: Style2D;
  strokeStyle: Style2D;
  lineWidth: number;
  globalAlpha: number;
  lineCap: LineCap2D;
  lineJoin: LineJoin2D;
  font: SkFont;
  textAlign: TextAlign2D;
  textBaseline: TextBaseline2D;
  globalCompositeOperation: CompositeOp2D;
  shadowColor: string | SkColor;
  shadowBlur: number;
  shadowOffsetY: number;
  readonly fonts: LivelineFonts;

  save(): void;
  restore(): void;
  beginPath(): void;
  /** Adopt an existing SkPath as the current path (Skia extension, no Canvas2D equivalent) */
  beginPathFrom(path: SkPath): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number
  ): void;
  cubicTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number
  ): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number
  ): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, radius: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  /** Non-antialiased axis-aligned clip (Skia extension, no Canvas2D
   * equivalent — Canvas2D only clips via an arbitrary path). Every call site
   * in this codebase clips to an axis-aligned rect, and a non-AA rect clip
   * lowers to a GPU scissor instead of the clip-mask/analytic-AA fallback an
   * antialiased path clip forces; see clipRect() below for detail. */
  clipRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  setLineDash(segments: number[]): void;
  createLinearGradient(
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ): Gradient2D;
  translate(dx: number, dy: number): void;
  /** Composites a previously-recorded picture at the current transform
   * (Skia extension, no Canvas2D equivalent). Ignores `globalAlpha` — Skia's
   * drawPicture takes no paint/alpha argument, so callers must not use this
   * during an alpha fade (e.g. the chart reveal morph). */
  drawPicture(picture: SkPicture): void;
}

/**
 * The internal, retargetable flavor of `Ctx2D` stored on `SkiaCache.ctx`.
 *
 * `createCanvas2D` used to build a fresh ~36-property object with ~28 method
 * closures on every recording (60x/sec on the UI thread) purely because every
 * method closed over the frame's `SkCanvas`. The closures now read a mutable
 * `cv` instead, so one instance can serve every recording made through a
 * given cache — `retarget()` points it at the new canvas and resets all
 * per-recording state.
 *
 * `fonts` is re-declared writable here (it's `readonly` on `Ctx2D`, which is
 * what draw code sees) so `retarget` can swap the font set along with the
 * canvas.
 */
export interface ReusableCtx2D extends Ctx2D {
  fonts: LivelineFonts;
  /**
   * Point this ctx at a new recording canvas and clear every piece of
   * per-recording state. See the implementation in `createCanvas2D` for the
   * full enumeration — anything not reset there leaks from one recording
   * into the next.
   */
  retarget(canvas: SkCanvas, fonts: LivelineFonts): void;
}

interface StyleSnapshot {
  fillStyle: Style2D;
  strokeStyle: Style2D;
  lineWidth: number;
  globalAlpha: number;
  lineCap: LineCap2D;
  lineJoin: LineJoin2D;
  font: SkFont;
  textAlign: TextAlign2D;
  textBaseline: TextBaseline2D;
  globalCompositeOperation: CompositeOp2D;
  shadowColor: string | SkColor;
  shadowBlur: number;
  shadowOffsetY: number;
  lineDash: number[];
}

// NOTE: these module-scope worklet helpers MUST be defined above
// createCanvas2D, and each helper that calls another worklet helper
// (alignDx/baselineDy call the cached* functions; cachedGradient calls
// cachedColor) MUST itself be defined below the helpers it calls. The
// worklets babel plugin rewrites 'worklet' function declarations into
// const-assigned worklet objects (hoisting is lost) and captures each
// worklet's closure at module evaluation time — a helper referenced before
// its own const assignment has run would be captured as `undefined` and
// crash on the UI thread.

/**
 * Cross-frame cache for Skia objects created by the Canvas2D shim: immutable
 * objects (gradients, dash effects, blur mask filters, parsed colors), plus
 * memoized text measurements (widths, font metrics), plus a pool of the
 * mutable path/paint host objects the shim draws through (see `pool`), plus
 * the reusable Canvas2D adapter itself (see `ctx`).
 * Everything here outlives a single recording, so this cache must live
 * outside `createCanvas2D` — the caller
 * (`useLivelineEngine`) owns one on a `useSharedValue` on the UI runtime and
 * passes it in every frame. Plain string-keyed records only (no Map/WeakMap):
 * this object crosses the Reanimated worklet boundary, which doesn't support
 * those collection types.
 *
 * Each cache is bounded — a `xCount` counter increments on insert, and once
 * it exceeds the cap the record is replaced with a fresh empty object and the
 * counter reset. There is no invalidation logic: cache keys encode every
 * input to the underlying Skia factory call, and the objects they produce are
 * immutable, so a hit is always correct for as long as it lives.
 */
export interface SkiaCache {
  // Pooled mutable Skia host objects, reused across frames (not just within
  // one). Paint/path state carries no per-frame meaning: every draw method
  // fully re-applies the state it depends on before use (see the leak-hazard
  // comments in createCanvas2D), and the pooled path is rewound at the top
  // of each frame. Built lazily on the UI thread by createCanvas2D on the
  // first frame (null until then) so the allocations happen on the runtime
  // that uses them.
  pool: {
    path: SkPath;
    fillPaint: SkPaint;
    strokePaint: SkPaint;
    shadowPaint: SkPaint;
    // Reused Gradient2D descriptor for createLinearGradient — see that
    // method for the safety argument (every call site builds, assigns, and
    // consumes one before the next is ever created, so a single mutable
    // instance can't alias two distinct gradients).
    gradient: Gradient2D;
    // Reused SkRect for rect()/arc()/fillRect()/clipRect() below. Safe to
    // share across all of them (and across calls): every one of those
    // methods calls `.setXYWH` and passes the rect into a native Skia call
    // (addRect/addArc/drawRect/clipRect) in the same statement, and the
    // native binding reads the rect's numeric fields and copies them into
    // its own recorded/native state synchronously — confirmed against the
    // binding's C++ source (JsiSkRect::fromValue + the JsiSkPath/JsiSkCanvas
    // host functions all dereference `*rect` by value into the Skia call
    // and never retain the JS-side object). There's no gradient-style
    // "assign now, consume later" gap here to create aliasing risk.
    rect: SkHostRect;
  } | null;
  /**
   * The reusable Canvas2D adapter for this cache (see `ReusableCtx2D`), built
   * lazily on the UI thread by the first `createCanvas2D` call and retargeted
   * — never rebuilt — on every subsequent one.
   *
   * CRITICAL: this lives on the cache, not at module scope, and must stay
   * there. Recordings nest: `engine/gridLayer.ts` opens its own
   * `PictureRecorder` *during* the main frame's recording, and it already
   * passes a separate `SkiaCache` (`EngineState.gridLayerCache`) precisely so
   * the pooled path/paints can't alias between the two live recordings. One
   * ctx per cache inherits that isolation exactly: the nested recording gets
   * its own ctx with its own `cv`, path, save-stack and style state, so it
   * cannot scribble into the outer one. A single module-global ctx would
   * retarget the outer recording's canvas out from under it mid-frame.
   */
  ctx: ReusableCtx2D | null;
  colors: Record<string, SkColor>;
  colorCount: number;
  gradients: Record<string, SkShader>;
  gradientCount: number;
  dashes: Record<string, SkPathEffect>;
  dashCount: number;
  blurs: Record<string, SkMaskFilter>;
  blurCount: number;
  textWidths: Record<string, number>;
  textWidthCount: number;
  fontMetrics: Record<string, { ascent: number; descent: number }>;
  fontMetricsCount: number;
}

// The 'worklet' directive is required even though this just returns a plain
// literal: engine/state.ts's createEngineState (itself a worklet, called
// lazily from the UI-thread frame callback) calls this directly to build
// `gridLayerCache`. A worklet calling a non-worklet function only works on
// the JS thread — on the UI thread the callee was never serialized into the
// worklet runtime, so the call resolves to a non-function and throws
// "Object is not a function" in release/Hermes builds specifically (dev
// builds tolerated it). See useLivelineEngine.ts's `createSkiaCache()` call
// for the JS-thread-only call site that doesn't need this.
export function createSkiaCache(): SkiaCache {
  'worklet';
  return {
    pool: null,
    ctx: null,
    colors: {},
    colorCount: 0,
    gradients: {},
    gradientCount: 0,
    dashes: {},
    dashCount: 0,
    blurs: {},
    blurCount: 0,
    textWidths: {},
    textWidthCount: 0,
    fontMetrics: {},
    fontMetricsCount: 0,
  };
}

const COLOR_CACHE_CAP = 256;
const GRADIENT_CACHE_CAP = 64;
const DASH_CACHE_CAP = 16;
const BLUR_CACHE_CAP = 32;
// Live value strings (badge/crosshair/candlestick price labels) churn every
// tick, so this is sized closer to the per-frame distinct-string count than
// the other caches, which cache a comparatively small, stable set of colors
// and shaders.
const TEXT_WIDTH_CACHE_CAP = 512;
// One entry per font slot (8 slots in LivelineFonts today) — metrics are a
// per-font constant, so this cache is expected to fully warm up and never
// evict in practice; the cap is a defensive bound, not a working-set sizing.
const FONT_METRICS_CACHE_CAP = 16;

// Identifies which named slot of `fonts` a given SkFont came from, by
// identity comparison — used to build cache keys for the text width/metrics
// caches below, since ctx.font is an SkFont (not a string) and the same
// string can be measured against different fonts. Falls back to a constant
// for a font that isn't one of the named slots; every ctx.font assignment
// in this codebase currently comes from `ctx.fonts.*` (or the `fonts.label`
// default createCanvas2D sets), so the fallback is unreachable today but
// kept as a defensive key rather than a crash if that invariant is ever
// broken.
function fontKey(fonts: LivelineFonts, font: SkFont): string {
  'worklet';
  if (font === fonts.label) return 'label';
  if (font === fonts.value) return 'value';
  if (font === fonts.badge) return 'badge';
  if (font === fonts.crosshair) return 'crosshair';
  if (font === fonts.orderbook) return 'orderbook';
  if (font === fonts.empty) return 'empty';
  if (font === fonts.refLabel) return 'refLabel';
  if (font === fonts.seriesLabel) return 'seriesLabel';
  return '?';
}

// Parses a CSS color string via Skia.Color, cached by the string itself.
// Bounded at COLOR_CACHE_CAP: blendColor-driven reveal/transition animations
// generate many distinct interpolated rgba(...) strings, which would grow
// this cache unboundedly without the reset-on-overflow.
function cachedColor(cache: SkiaCache, colorString: string): SkColor {
  'worklet';
  const hit = cache.colors[colorString];
  if (hit !== undefined) return hit;
  if (cache.colorCount >= COLOR_CACHE_CAP) {
    cache.colors = {};
    cache.colorCount = 0;
  }
  const color = Skia.Color(colorString);
  cache.colors[colorString] = color;
  cache.colorCount++;
  return color;
}

// Builds (or reuses) a linear gradient shader. Keyed on every input that
// affects the resulting shader: endpoints, offsets, and color stops — a
// stable chart fill (same geometry + palette across frames) resolves to the
// same key and hits every frame after the first.
function cachedGradient(
  cache: SkiaCache,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  offsets: number[],
  colors: string[]
): SkShader {
  'worklet';
  const key = `${x0},${y0},${x1},${y1}|${offsets.join(',')}|${colors.join('|')}`;
  const hit = cache.gradients[key];
  if (hit !== undefined) return hit;
  if (cache.gradientCount >= GRADIENT_CACHE_CAP) {
    cache.gradients = {};
    cache.gradientCount = 0;
  }
  const resolvedColors: SkColor[] = [];
  for (let i = 0; i < colors.length; i++) {
    resolvedColors.push(cachedColor(cache, colors[i]!));
  }
  const shader = Skia.Shader.MakeLinearGradient(
    { x: x0, y: y0 },
    { x: x1, y: y1 },
    resolvedColors,
    offsets,
    TileMode.Clamp
  );
  cache.gradients[key] = shader;
  cache.gradientCount++;
  return shader;
}

// Builds (or reuses) a dash path effect for a given segment pattern. The
// shim only ever uses one constant [4,4] pattern today, but the key covers
// arbitrary patterns.
function cachedDash(cache: SkiaCache, segments: number[]): SkPathEffect {
  'worklet';
  const key = segments.join(',');
  const hit = cache.dashes[key];
  if (hit !== undefined) return hit;
  if (cache.dashCount >= DASH_CACHE_CAP) {
    cache.dashes = {};
    cache.dashCount = 0;
  }
  const effect = Skia.PathEffect.MakeDash(segments, 0);
  cache.dashes[key] = effect;
  cache.dashCount++;
  return effect;
}

// Builds (or reuses) a blur mask filter. `sigma` is quantized to 1 decimal
// place for both the cache key and the filter actually built — shadowBlur
// animates continuously in drawDot's scrub-dim path (6 * (1 - scrubAmount *
// 0.7)), and without quantization every distinct floating-point sigma would
// be a cache miss, defeating the cache entirely during that animation.
// Quantizing to 0.1 is visually lossless for a blur radius while keeping the
// cache small.
function cachedBlur(cache: SkiaCache, sigma: number): SkMaskFilter {
  'worklet';
  const q = Math.round(sigma * 10) / 10;
  const key = String(q);
  const hit = cache.blurs[key];
  if (hit !== undefined) return hit;
  if (cache.blurCount >= BLUR_CACHE_CAP) {
    cache.blurs = {};
    cache.blurCount = 0;
  }
  const filter = Skia.MaskFilter.MakeBlur(BlurStyle.Normal, q, true);
  cache.blurs[key] = filter;
  cache.blurCount++;
  return filter;
}

// Measures text width via font.measureText, cached by font slot + string.
// Called every frame by measureText() and by alignDx for every
// center/right-aligned fillText/strokeText — badge, crosshair, timeAxis,
// candlestick, referenceLine, and empty all remeasure the same handful of
// live-value strings on every tick, so this is a hot per-frame cost that a
// cache hit skips entirely.
function cachedTextWidth(
  cache: SkiaCache,
  fonts: LivelineFonts,
  font: SkFont,
  text: string
): number {
  'worklet';
  const key = fontKey(fonts, font) + ' ' + text;
  const hit = cache.textWidths[key];
  if (hit !== undefined) return hit;
  if (cache.textWidthCount >= TEXT_WIDTH_CACHE_CAP) {
    cache.textWidths = {};
    cache.textWidthCount = 0;
  }
  const width = font.measureText(text).width;
  cache.textWidths[key] = width;
  cache.textWidthCount++;
  return width;
}

// Reads font.getMetrics(), cached by font slot only — metrics are a
// per-font constant (don't vary by string), so this cache is expected to
// warm up to at most one entry per LivelineFonts slot and never miss again.
function cachedFontMetrics(
  cache: SkiaCache,
  fonts: LivelineFonts,
  font: SkFont
): { ascent: number; descent: number } {
  'worklet';
  const key = fontKey(fonts, font);
  const hit = cache.fontMetrics[key];
  if (hit !== undefined) return hit;
  if (cache.fontMetricsCount >= FONT_METRICS_CACHE_CAP) {
    cache.fontMetrics = {};
    cache.fontMetricsCount = 0;
  }
  const m = font.getMetrics();
  const metrics = { ascent: m.ascent, descent: m.descent };
  cache.fontMetrics[key] = metrics;
  cache.fontMetricsCount++;
  return metrics;
}

function alignDx(
  cache: SkiaCache,
  fonts: LivelineFonts,
  font: SkFont,
  text: string,
  align: TextAlign2D
): number {
  'worklet';
  if (align === 'left') return 0;
  const w = cachedTextWidth(cache, fonts, font, text);
  return align === 'center' ? -w / 2 : -w;
}

function baselineDy(
  cache: SkiaCache,
  fonts: LivelineFonts,
  font: SkFont,
  baseline: TextBaseline2D
): number {
  'worklet';
  if (baseline === 'alphabetic') return 0;
  const m = cachedFontMetrics(cache, fonts, font); // ascent is negative in Skia
  if (baseline === 'middle') return -(m.ascent + m.descent) / 2;
  return -m.ascent; // 'top'
}

/**
 * Returns the Canvas2D adapter for `cache`, pointed at `canvas`.
 *
 * Despite the name this allocates nothing after the first call per cache: the
 * ctx (and the path/paint pool it draws through) is stored on the cache and
 * `retarget`-ed for each new recording, because it used to cost ~31
 * allocations 60 times a second in a library that pools paints, paths and
 * rects specifically to avoid that. The name is kept because every call site
 * reads as "make me a ctx for this recording", which is still exactly what it
 * does. Two rules follow from the reuse, both enforced by construction:
 *  - the returned ctx is valid only until the next `createCanvas2D(_, _,
 *    cache)` with the SAME cache; don't hold one across recordings.
 *  - concurrently-live recordings (the nested grid-layer recorder inside the
 *    main frame's) must pass DIFFERENT caches — as they already must for the
 *    pooled path/paints. See `SkiaCache.ctx`.
 */
export function createCanvas2D(
  canvas: SkCanvas,
  fonts: LivelineFonts,
  cache: SkiaCache
): Ctx2D {
  'worklet';
  // Pooled path + paints, persisted in the cross-frame cache: one JSI
  // host-object allocation per component lifetime instead of four per frame.
  // Path reuse after canvas.drawPath is safe across recordings: Skia records
  // paths (and paints) by value with copy-on-write, so rewinding/mutating
  // our objects detaches them from anything already recorded — including the
  // previous frame's finished picture. rewind() (not reset()) keeps the
  // verb/point storage allocated for refill. beginPathFrom() temporarily
  // adopts a caller-owned path instead; the pool is never rewound while
  // adopted paths are current, and adopted paths are never rewound by the
  // shim. AntiAlias and Style never vary per paint, so they're set once at
  // pool creation. Everything else that a fresh Skia.Paint() would default
  // to must be explicitly reset on every use below — see applyStyle and the
  // draw methods for the specific leak hazards (shader, alphaf, blend mode,
  // path effect, stroke cap).
  if (cache.pool === null) {
    const pooledFill = Skia.Paint();
    pooledFill.setAntiAlias(true);
    pooledFill.setStyle(PaintStyle.Fill);

    const pooledStroke = Skia.Paint();
    pooledStroke.setAntiAlias(true);
    pooledStroke.setStyle(PaintStyle.Stroke);

    const pooledShadow = Skia.Paint();
    pooledShadow.setAntiAlias(true);
    pooledShadow.setStyle(PaintStyle.Fill);

    // isVolatile tells Skia this path's contents won't be reused as a
    // static resource — appropriate here since it's rewound and refilled
    // every frame (see below). Without it, Skia may treat the path as
    // worth caching/uploading as if it were long-lived geometry, which is
    // wasted work for something that never looks the same twice. This is
    // the ONLY path in the codebase that should be volatile: lineCache.ts's
    // prefix path, candleCache.ts's four body/wick paths, and badge.ts's
    // pill path are all deliberately long-lived and benefit from the
    // caching volatility disables — do not mark those volatile.
    const pooledPath = Skia.Path.Make();
    pooledPath.setIsVolatile(true);

    // Pooled Gradient2D descriptor — see createLinearGradient below for why
    // reusing a single mutable instance is safe (every call site fully
    // consumes one before the next is created). `addColorStop` is defined
    // once here rather than per-call, so pooling also removes a closure
    // allocation on top of the two backing arrays.
    const pooledGradient: Gradient2D = {
      isGradient: true,
      x0: 0,
      y0: 0,
      x1: 0,
      y1: 0,
      offsets: [],
      colors: [],
      addColorStop(offset: number, color: string) {
        pooledGradient.offsets.push(offset);
        pooledGradient.colors.push(color);
      },
    };

    // Pooled SkRect — see the `rect` field comment on SkiaCache's `pool`
    // type for why reuse across rect()/arc()/fillRect()/clipRect() is safe.
    const pooledRect = Skia.XYWHRect(0, 0, 0, 0);

    cache.pool = {
      path: pooledPath,
      fillPaint: pooledFill,
      strokePaint: pooledStroke,
      shadowPaint: pooledShadow,
      gradient: pooledGradient,
      rect: pooledRect,
    };
  }
  const {
    path: ownPath,
    fillPaint,
    strokePaint,
    shadowPaint,
    gradient: ownGradient,
    rect: ownRect,
  } = cache.pool;

  // Reuse this cache's adapter if it already has one — see SkiaCache.ctx for
  // why it hangs off the cache (nested recordings) and `retarget` below for
  // the per-recording state it clears.
  const existing = cache.ctx;
  if (existing !== null) {
    existing.retarget(canvas, fonts);
    return existing;
  }

  // ---- per-recording state (everything `retarget` must reset) ----
  // 1. the recording canvas itself — every method below reads this mutable
  //    binding rather than capturing the frame's canvas as a const, which is
  //    the whole reason this object is reusable at all.
  let cv = canvas;
  // 2. the current path: normally the pooled path, but beginPathFrom() can
  //    adopt a caller-owned one, which must not survive into the next
  //    recording.
  let path = ownPath;
  // 3. the dash pattern set by setLineDash().
  let lineDash: number[] = NO_DASH;
  // 4. the save()/restore() snapshot stack. Balanced call sites leave it
  //    empty, but an unbalanced one would otherwise leak a snapshot (and its
  //    styles) into the next recording via a stray restore().
  const stack: StyleSnapshot[] = [];
  // 5. the thirteen public style properties + `fonts`, reset on the ctx
  //    object itself in retarget().
  // (`cache` and the pooled path/paints/gradient/rect are per-cache, not
  //  per-recording: the ctx and the pool it draws through always belong to
  //  the same cache, so they never need reassigning.)

  // Applies a fill/stroke style + globalAlpha to a paint. For color strings
  // the string's own alpha is multiplied by globalAlpha; for gradients the
  // paint alpha modulates the shader output. Since paint is pooled, both
  // branches must fully reset the state the other branch sets: a solid
  // color must clear any shader left by a prior gradient call (setColor is
  // ignored while a shader is set), and a gradient at alpha 1 must clear any
  // alphaf left by a prior alpha<1 call (a fresh paint's alphaf defaults to
  // 1, which is only reproduced here by always setting it, not just when
  // alpha < 1).
  const applyStyle = (paint: SkPaint, style: Style2D, alpha: number) => {
    if (typeof style === 'string') {
      // setColor re-derives alphaf from the color string on every call, so
      // no explicit alphaf reset is needed on this path — only the shader
      // (setColor is silently ignored while a shader is set).
      paint.setShader(null);
      paint.setColor(cachedColor(cache, style));
      if (alpha < 1) paint.setAlphaf(paint.getAlphaf() * alpha);
    } else if (style instanceof Float32Array) {
      // A pre-built SkColor (see math/color.ts's rgbColor) — an animated
      // blend that skipped the string round-trip entirely. Same alpha
      // handling as the string path: setColor re-derives alphaf from the
      // color's own 4th (alpha) component every call.
      paint.setShader(null);
      paint.setColor(style);
      if (alpha < 1) paint.setAlphaf(paint.getAlphaf() * alpha);
    } else {
      paint.setShader(
        cachedGradient(
          cache,
          style.x0,
          style.y0,
          style.x1,
          style.y1,
          style.offsets,
          style.colors
        )
      );
      // Unconditional (not just `if (alpha < 1)`): a pooled paint may carry
      // a stale alphaf from a previous alpha<1 call, and unlike the solid
      // path there's no setColor to re-derive it here.
      paint.setAlphaf(alpha < 1 ? alpha : 1);
    }
  };

  const capOf = (cap: LineCap2D) =>
    cap === 'round'
      ? StrokeCap.Round
      : cap === 'square'
        ? StrokeCap.Square
        : StrokeCap.Butt;

  const joinOf = (join: LineJoin2D) =>
    join === 'round'
      ? StrokeJoin.Round
      : join === 'bevel'
        ? StrokeJoin.Bevel
        : StrokeJoin.Miter;

  const ctx: ReusableCtx2D = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: fonts.label,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
    shadowColor: 'rgba(0,0,0,0)',
    shadowBlur: 0,
    shadowOffsetY: 0,
    fonts,

    // Points this adapter at a new recording canvas and resets EVERY piece
    // of per-recording state, so a reused ctx is indistinguishable from the
    // freshly-built one this used to be. The enumeration, in order:
    //   canvas       -> the new one (all methods read `cv`)
    //   fonts        -> the new set (methods read `this.fonts`)
    //   pooled path  -> rewound; discards the last recording's verbs
    //   path         -> back to the pooled path (drops any adopted one)
    //   lineDash     -> NO_DASH
    //   stack        -> emptied
    //   13 styles    -> the same defaults the object literal above declares
    // Missing any one of these leaks state across recordings — a stuck dash
    // pattern, a stale gradient, or a wrong alpha in an unrelated layer.
    retarget(nextCanvas, nextFonts) {
      cv = nextCanvas;
      ownPath.rewind();
      path = ownPath;
      lineDash = NO_DASH;
      stack.length = 0;
      this.fonts = nextFonts;
      this.fillStyle = '#000000';
      this.strokeStyle = '#000000';
      this.lineWidth = 1;
      this.globalAlpha = 1;
      this.lineCap = 'butt';
      this.lineJoin = 'miter';
      this.font = nextFonts.label;
      this.textAlign = 'left';
      this.textBaseline = 'alphabetic';
      this.globalCompositeOperation = 'source-over';
      this.shadowColor = 'rgba(0,0,0,0)';
      this.shadowBlur = 0;
      this.shadowOffsetY = 0;
    },

    save() {
      stack.push({
        fillStyle: this.fillStyle,
        strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth,
        globalAlpha: this.globalAlpha,
        lineCap: this.lineCap,
        lineJoin: this.lineJoin,
        font: this.font,
        textAlign: this.textAlign,
        textBaseline: this.textBaseline,
        globalCompositeOperation: this.globalCompositeOperation,
        shadowColor: this.shadowColor,
        shadowBlur: this.shadowBlur,
        shadowOffsetY: this.shadowOffsetY,
        // No defensive copy: every call site now passes a hoisted
        // module-level constant array (or the shared EMPTY_DASH) rather
        // than a fresh literal, and setLineDash below stores that reference
        // as-is — see the invariant note there. Storing/restoring the same
        // reference is safe as long as nothing ever mutates a dash array in
        // place, which no caller in this codebase does.
        lineDash,
      });
      cv.save();
    },

    restore() {
      const s = stack.pop();
      if (s) {
        this.fillStyle = s.fillStyle;
        this.strokeStyle = s.strokeStyle;
        this.lineWidth = s.lineWidth;
        this.globalAlpha = s.globalAlpha;
        this.lineCap = s.lineCap;
        this.lineJoin = s.lineJoin;
        this.font = s.font;
        this.textAlign = s.textAlign;
        this.textBaseline = s.textBaseline;
        this.globalCompositeOperation = s.globalCompositeOperation;
        this.shadowColor = s.shadowColor;
        this.shadowBlur = s.shadowBlur;
        this.shadowOffsetY = s.shadowOffsetY;
        lineDash = s.lineDash;
      }
      cv.restore();
    },

    beginPath() {
      ownPath.rewind();
      path = ownPath;
    },

    beginPathFrom(p) {
      path = p;
    },

    closePath() {
      path.close();
    },

    moveTo(x, y) {
      path.moveTo(x, y);
    },

    lineTo(x, y) {
      path.lineTo(x, y);
    },

    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
      path.cubicTo(c1x, c1y, c2x, c2y, x, y);
    },

    // Alias so drawSpline's SplinePath interface is satisfied directly
    cubicTo(c1x, c1y, c2x, c2y, x, y) {
      path.cubicTo(c1x, c1y, c2x, c2y, x, y);
    },

    arc(x, y, radius, startAngle, endAngle) {
      const sweep = endAngle - startAngle;
      if (Math.abs(sweep) >= Math.PI * 2 - 1e-6) {
        path.addCircle(x, y, radius);
      } else {
        // Reuses the pooled rect (see SkiaCache's `pool.rect` comment) —
        // addArc reads the bounds and writes verb data into `path`
        // synchronously, so there's no window where a stale value could
        // leak into a different call.
        ownRect.setXYWH(x - radius, y - radius, radius * 2, radius * 2);
        path.addArc(
          ownRect,
          (startAngle * 180) / Math.PI,
          (sweep * 180) / Math.PI
        );
      }
    },

    arcTo(x1, y1, x2, y2, radius) {
      path.arcToTangent(x1, y1, x2, y2, radius);
    },

    rect(x, y, w, h) {
      ownRect.setXYWH(x, y, w, h);
      path.addRect(ownRect);
    },

    fill() {
      const paint = fillPaint;
      applyStyle(paint, this.fillStyle, this.globalAlpha);
      // Unconditional: a pooled paint may carry DstOut from a prior
      // destination-out fill/stroke/fillRect call.
      paint.setBlendMode(
        this.globalCompositeOperation === 'destination-out'
          ? BlendMode.DstOut
          : BlendMode.SrcOver
      );
      // Shadow pass. On Android (BLUR_SHADOWS false) the blur is replaced
      // with a flat silhouette at reduced alpha — the 1px-offset rim reads
      // as the same depth cue without re-rastering a blur every frame. A
      // flat shadow with no vertical offset (the live-candle glow) would be
      // an invisible repaint of the same shape, so that pass is skipped
      // entirely there.
      if (this.shadowBlur > 0 && (BLUR_SHADOWS || this.shadowOffsetY !== 0)) {
        const sp = shadowPaint;
        sp.setColor(
          typeof this.shadowColor === 'string'
            ? cachedColor(cache, this.shadowColor)
            : this.shadowColor
        );
        sp.setAlphaf(
          sp.getAlphaf() * this.globalAlpha * (BLUR_SHADOWS ? 1 : 0.6)
        );
        sp.setMaskFilter(
          BLUR_SHADOWS ? cachedBlur(cache, this.shadowBlur * 0.5) : null
        );
        // Draw the same path through a translated canvas instead of
        // allocating an offset copy per shadowed fill.
        cv.save();
        cv.translate(0, this.shadowOffsetY);
        cv.drawPath(path, sp);
        cv.restore();
      }
      cv.drawPath(path, paint);
    },

    stroke() {
      const paint = strokePaint;
      paint.setStrokeWidth(this.lineWidth);
      paint.setStrokeCap(capOf(this.lineCap));
      paint.setStrokeJoin(joinOf(this.lineJoin));
      applyStyle(paint, this.strokeStyle, this.globalAlpha);
      paint.setBlendMode(
        this.globalCompositeOperation === 'destination-out'
          ? BlendMode.DstOut
          : BlendMode.SrcOver
      );
      // Reset to null on the no-dash path: strokeText shares this pooled
      // paint and never dashes, so it must not inherit a dash pattern left
      // by a previous stroke() call.
      paint.setPathEffect(
        lineDash.length > 0 ? cachedDash(cache, lineDash) : null
      );
      cv.drawPath(path, paint);
    },

    // Every call site clips to an axis-aligned rect built immediately before
    // the clip call, so this always uses clipRect (a GPU scissor) rather
    // than clipPath with doAntiAlias=true. An antialiased path clip can't be
    // expressed as a scissor rect, so Skia falls back to a clip mask or
    // analytic AA coverage — substantially more expensive per draw call, and
    // these clips wrap the innermost, most-executed draws in the library
    // (the line stroke/fill, the whole candle body). doAntiAlias is false
    // here: an axis-aligned rect clip has no diagonal/curved edge to
    // antialias, so there's no visual cost to the non-AA path.
    clipRect(x, y, w, h) {
      ownRect.setXYWH(x, y, w, h);
      cv.clipRect(ownRect, ClipOp.Intersect, false);
    },

    fillRect(x, y, w, h) {
      const paint = fillPaint;
      applyStyle(paint, this.fillStyle, this.globalAlpha);
      paint.setBlendMode(
        this.globalCompositeOperation === 'destination-out'
          ? BlendMode.DstOut
          : BlendMode.SrcOver
      );
      ownRect.setXYWH(x, y, w, h);
      cv.drawRect(ownRect, paint);
    },

    fillText(text, x, y) {
      const paint = fillPaint;
      applyStyle(paint, this.fillStyle, this.globalAlpha);
      // fillText never sets a blend mode itself (matches pre-pooling
      // behavior, which never applied destination-out to text), but since
      // this paint is shared with fill()/fillRect() it must not inherit
      // DstOut from a prior destination-out fill.
      paint.setBlendMode(BlendMode.SrcOver);
      cv.drawText(
        text,
        x + alignDx(cache, this.fonts, this.font, text, this.textAlign),
        y + baselineDy(cache, this.fonts, this.font, this.textBaseline),
        paint,
        this.font
      );
    },

    strokeText(text, x, y) {
      const paint = strokePaint;
      paint.setStrokeWidth(this.lineWidth);
      // Reset cap to Butt (a fresh paint's default): stroke() sets cap
      // per its own lineCap, but strokeText never has and must not inherit
      // one from a prior stroke() call now that the paint is pooled.
      paint.setStrokeCap(StrokeCap.Butt);
      paint.setStrokeJoin(joinOf(this.lineJoin));
      applyStyle(paint, this.strokeStyle, this.globalAlpha);
      // strokeText never dashes; must not inherit a dash from stroke().
      paint.setPathEffect(null);
      paint.setBlendMode(BlendMode.SrcOver);
      cv.drawText(
        text,
        x + alignDx(cache, this.fonts, this.font, text, this.textAlign),
        y + baselineDy(cache, this.fonts, this.font, this.textBaseline),
        paint,
        this.font
      );
    },

    measureText(text) {
      return { width: cachedTextWidth(cache, this.fonts, this.font, text) };
    },

    // No defensive copy: `segments` used to be sliced here because callers
    // passed fresh array literals (`[4, 4]`, `[]`) that were free to mutate
    // afterward. Callers now pass hoisted module-level constants instead
    // (each draw module keeps its own — e.g. line.ts's DASH_4_4 and
    // EMPTY_DASH, grid.ts's DASH_1_3 and EMPTY_DASH — rather than importing
    // from here, since this module pulls in the native Skia binding at
    // import time and several of those modules are unit-tested directly
    // without it) specifically so this can store the reference directly and
    // skip the per-call allocation. INVARIANT: nothing may mutate an array
    // in place after passing it to setLineDash — every call site in this
    // codebase passes a constant it never touches again.
    setLineDash(segments) {
      lineDash = segments;
    },

    // Reuses the pooled descriptor instead of allocating a fresh object +
    // two arrays + an addColorStop closure on every call (this was ~4
    // allocations per call, called 2-3x/frame). Safe because every call
    // site in this codebase builds a gradient, assigns it to a style
    // property, and consumes it via fill()/fillRect() (which read
    // style.x0/y0/x1/y1/offsets/colors synchronously) before returning —
    // never held across a save()/restore() or a nested draw call, and never
    // two live at once. Every fill()/fillRect()/fillText() call site also
    // assigns its style property immediately beforehand (grepped: none rely
    // on a leftover ctx.fillStyle), so even a stale reference to this pooled
    // object sitting in a save() snapshot is never read as a gradient after
    // being overwritten by a later call. If a future call site ever holds a
    // gradient across another createLinearGradient call before consuming
    // it, this pooling breaks (silently wrong colors) — don't add one
    // without re-checking this invariant.
    createLinearGradient(x0, y0, x1, y1) {
      const grad = ownGradient;
      grad.x0 = x0;
      grad.y0 = y0;
      grad.x1 = x1;
      grad.y1 = y1;
      grad.offsets.length = 0;
      grad.colors.length = 0;
      return grad;
    },

    translate(dx, dy) {
      cv.translate(dx, dy);
    },

    drawPicture(picture) {
      cv.drawPicture(picture);
    },
  };

  // Run the same reset the reuse path runs, so the first recording is
  // byte-for-byte identical to every later one (and so the pooled path is
  // rewound before the first use). The literal's initial values above exist
  // only to satisfy the type — retarget() is the single source of truth for
  // the defaults.
  ctx.retarget(canvas, fonts);
  cache.ctx = ctx;
  return ctx;
}
