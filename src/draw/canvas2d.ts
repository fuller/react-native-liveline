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
} from '@shopify/react-native-skia';
import type { LivelineFonts } from '../types';

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

export type Style2D = string | Gradient2D;
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
  shadowColor: string;
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
  clip(): void;
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
  shadowColor: string;
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
 * Cross-frame cache for immutable Skia objects created by the Canvas2D shim
 * (gradients, dash effects, blur mask filters, parsed colors) plus memoized
 * text measurements (widths, font metrics). `createCanvas2D` is recreated
 * every frame, so this cache must live outside it — the caller
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

export function createSkiaCache(): SkiaCache {
  return {
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

export function createCanvas2D(
  canvas: SkCanvas,
  fonts: LivelineFonts,
  cache: SkiaCache
): Ctx2D {
  'worklet';
  // Pooled path, reused across every beginPath() in this frame's recording
  // (mirrors the paint pool below — one JSI host-object allocation per frame
  // instead of one per path). Reuse after canvas.drawPath is safe: Skia
  // records paths by value with copy-on-write, so rewinding our object
  // detaches it from anything already recorded. rewind() (not reset())
  // keeps the verb/point storage allocated for refill. beginPathFrom()
  // temporarily adopts a caller-owned path instead; the pool is never
  // rewound while adopted paths are current, and adopted paths are never
  // rewound by the shim.
  const ownPath = Skia.Path.Make();
  let path = ownPath;
  let lineDash: number[] = [];
  const stack: StyleSnapshot[] = [];

  // Paint pool: one per style, reused across all draw calls within this
  // frame's recording (a new SkCanvas/pool is created each frame, so this
  // does not persist state across frames — only within one). AntiAlias and
  // Style never vary per paint, so they're set once here rather than on
  // every draw call. Everything else that a fresh Skia.Paint() would default
  // to must be explicitly reset on every use below — see applyStyle and the
  // draw methods for the specific leak hazards (shader, alphaf, blend mode,
  // path effect, stroke cap).
  const fillPaint = Skia.Paint();
  fillPaint.setAntiAlias(true);
  fillPaint.setStyle(PaintStyle.Fill);

  const strokePaint = Skia.Paint();
  strokePaint.setAntiAlias(true);
  strokePaint.setStyle(PaintStyle.Stroke);

  const shadowPaint = Skia.Paint();
  shadowPaint.setAntiAlias(true);
  shadowPaint.setStyle(PaintStyle.Fill);

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

  const ctx: Ctx2D = {
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
        lineDash: lineDash.slice(),
      });
      canvas.save();
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
      canvas.restore();
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
        path.addArc(
          Skia.XYWHRect(x - radius, y - radius, radius * 2, radius * 2),
          (startAngle * 180) / Math.PI,
          (sweep * 180) / Math.PI
        );
      }
    },

    arcTo(x1, y1, x2, y2, radius) {
      path.arcToTangent(x1, y1, x2, y2, radius);
    },

    rect(x, y, w, h) {
      path.addRect(Skia.XYWHRect(x, y, w, h));
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
      if (this.shadowBlur > 0) {
        const sp = shadowPaint;
        sp.setColor(cachedColor(cache, this.shadowColor));
        sp.setAlphaf(sp.getAlphaf() * this.globalAlpha);
        sp.setMaskFilter(cachedBlur(cache, this.shadowBlur * 0.5));
        // Draw the same path through a translated canvas instead of
        // allocating an offset copy per shadowed fill.
        canvas.save();
        canvas.translate(0, this.shadowOffsetY);
        canvas.drawPath(path, sp);
        canvas.restore();
      }
      canvas.drawPath(path, paint);
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
      canvas.drawPath(path, paint);
    },

    clip() {
      canvas.clipPath(path, ClipOp.Intersect, true);
    },

    fillRect(x, y, w, h) {
      const paint = fillPaint;
      applyStyle(paint, this.fillStyle, this.globalAlpha);
      paint.setBlendMode(
        this.globalCompositeOperation === 'destination-out'
          ? BlendMode.DstOut
          : BlendMode.SrcOver
      );
      canvas.drawRect(Skia.XYWHRect(x, y, w, h), paint);
    },

    fillText(text, x, y) {
      const paint = fillPaint;
      applyStyle(paint, this.fillStyle, this.globalAlpha);
      // fillText never sets a blend mode itself (matches pre-pooling
      // behavior, which never applied destination-out to text), but since
      // this paint is shared with fill()/fillRect() it must not inherit
      // DstOut from a prior destination-out fill.
      paint.setBlendMode(BlendMode.SrcOver);
      canvas.drawText(
        text,
        x + alignDx(cache, fonts, this.font, text, this.textAlign),
        y + baselineDy(cache, fonts, this.font, this.textBaseline),
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
      canvas.drawText(
        text,
        x + alignDx(cache, fonts, this.font, text, this.textAlign),
        y + baselineDy(cache, fonts, this.font, this.textBaseline),
        paint,
        this.font
      );
    },

    measureText(text) {
      return { width: cachedTextWidth(cache, fonts, this.font, text) };
    },

    setLineDash(segments) {
      lineDash = segments.slice();
    },

    createLinearGradient(x0, y0, x1, y1) {
      const grad: Gradient2D = {
        isGradient: true,
        x0,
        y0,
        x1,
        y1,
        offsets: [],
        colors: [],
        addColorStop(offset: number, color: string) {
          grad.offsets.push(offset);
          grad.colors.push(color);
        },
      };
      return grad;
    },

    translate(dx, dy) {
      canvas.translate(dx, dy);
    },
  };

  return ctx;
}
