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
// createCanvas2D. The worklets babel plugin rewrites 'worklet' function
// declarations into const-assigned worklet objects (hoisting is lost) and
// captures createCanvas2D's closure at module evaluation — helpers defined
// below it would be captured as `undefined` and crash on the UI thread.
function alignDx(font: SkFont, text: string, align: TextAlign2D): number {
  'worklet';
  if (align === 'left') return 0;
  const w = font.measureText(text).width;
  return align === 'center' ? -w / 2 : -w;
}

function baselineDy(font: SkFont, baseline: TextBaseline2D): number {
  'worklet';
  if (baseline === 'alphabetic') return 0;
  const m = font.getMetrics(); // ascent is negative in Skia
  if (baseline === 'middle') return -(m.ascent + m.descent) / 2;
  return -m.ascent; // 'top'
}

export function createCanvas2D(canvas: SkCanvas, fonts: LivelineFonts): Ctx2D {
  'worklet';
  let path = Skia.Path.Make();
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
      paint.setColor(Skia.Color(style));
      if (alpha < 1) paint.setAlphaf(paint.getAlphaf() * alpha);
    } else {
      const colors = [];
      for (let i = 0; i < style.colors.length; i++) {
        colors.push(Skia.Color(style.colors[i]!));
      }
      paint.setShader(
        Skia.Shader.MakeLinearGradient(
          { x: style.x0, y: style.y0 },
          { x: style.x1, y: style.y1 },
          colors,
          style.offsets,
          TileMode.Clamp
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
      path = Skia.Path.Make();
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
        sp.setColor(Skia.Color(this.shadowColor));
        sp.setAlphaf(sp.getAlphaf() * this.globalAlpha);
        sp.setMaskFilter(
          Skia.MaskFilter.MakeBlur(
            BlurStyle.Normal,
            this.shadowBlur * 0.5,
            true
          )
        );
        const shadowPath = path.copy();
        shadowPath.offset(0, this.shadowOffsetY);
        canvas.drawPath(shadowPath, sp);
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
        lineDash.length > 0 ? Skia.PathEffect.MakeDash(lineDash, 0) : null
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
        x + alignDx(this.font, text, this.textAlign),
        y + baselineDy(this.font, this.textBaseline),
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
        x + alignDx(this.font, text, this.textAlign),
        y + baselineDy(this.font, this.textBaseline),
        paint,
        this.font
      );
    },

    measureText(text) {
      return { width: this.font.measureText(text).width };
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
