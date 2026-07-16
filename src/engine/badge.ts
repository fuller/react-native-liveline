import { Skia } from '@shopify/react-native-skia';
import type { ChartLayout, Momentum } from '../types';
import { lerp } from '../math/lerp';
import type { Ctx2D } from '../draw/canvas2d';
import {
  badgeSvgPath,
  badgePillOnly,
  BADGE_PAD_X,
  BADGE_PAD_Y,
  BADGE_TAIL_LEN,
  BADGE_TAIL_SPREAD,
  BADGE_LINE_H,
} from '../draw/badge';
import type { EngineConfig } from './types';
import type { BadgeState } from './state';
import {
  BADGE_WIDTH_LERP,
  BADGE_Y_LERP,
  BADGE_Y_LERP_TRANSITIONING,
  MOMENTUM_COLOR_LERP,
  MOMENTUM_GREEN,
  MOMENTUM_RED,
} from './constants';

/**
 * Draw the value badge pill directly on the canvas.
 *
 * The web version renders the badge as a DOM/SVG overlay updated per frame
 * (`updateBadgeDOM`); geometry, lerps, and colors here match it exactly —
 * the pill path comes from the same badgeSvgPath generator via
 * Skia.Path.MakeFromSVGString.
 *
 * Mutates `badge` (width/Y/color lerp state). Returns nothing.
 */
export function drawBadge(
  ctx: Ctx2D,
  cfg: EngineConfig,
  badge: BadgeState,
  smoothValue: number,
  layout: ChartLayout,
  momentum: Momentum,
  isWindowTransitioning: boolean,
  noMotion: boolean,
  dt: number,
  chartReveal: number,
  extraOpacity: number
): void {
  'worklet';
  if (!cfg.showBadge || chartReveal < 0.25) return;

  const badgeOpacity =
    (chartReveal < 0.5 ? (chartReveal - 0.25) / 0.25 : 1) * extraOpacity;
  if (badgeOpacity < 0.01) return;

  const { w, h, pad } = layout;

  const text = cfg.formatValue(smoothValue);
  const tailLen = cfg.badgeTail ? BADGE_TAIL_LEN : 0;

  // Measure target text width using a template with widest digits
  ctx.font = ctx.fonts.label;
  const template = text.replace(/[0-9]/g, '8');
  const targetTextW = ctx.measureText(template).width;

  // Smooth-lerp the badge width
  badge.targetW = targetTextW;
  if (badge.displayW === 0) badge.displayW = targetTextW;
  badge.displayW = lerp(badge.displayW, badge.targetW, BADGE_WIDTH_LERP, dt);
  if (Math.abs(badge.displayW - badge.targetW) < 0.3) {
    badge.displayW = badge.targetW;
  }
  const textW = badge.displayW;

  const pillW = textW + BADGE_PAD_X * 2;
  const pillH = BADGE_LINE_H + BADGE_PAD_Y * 2;

  // Badge Y lerp — decoupled from range/value math, morphed during reveal
  const centerY = pad.top + layout.chartH / 2;
  const realTargetY = Math.max(
    pad.top,
    Math.min(h - pad.bottom, layout.toY(smoothValue))
  );
  const targetBadgeY =
    chartReveal < 1
      ? centerY + (realTargetY - centerY) * chartReveal
      : realTargetY;
  if (badge.y === null || noMotion) {
    badge.y = targetBadgeY;
  } else {
    const badgeSpeed = isWindowTransitioning
      ? BADGE_Y_LERP_TRANSITIONING
      : BADGE_Y_LERP;
    badge.y = lerp(badge.y, targetBadgeY, badgeSpeed, dt);
  }

  const badgeLeft = w - pad.right + 8 - BADGE_PAD_X - tailLen;
  const badgeTop = badge.y - pillH / 2;

  // Pill fill color
  let fillColor: string;
  let textColor: string;
  let shadow = false;
  if (cfg.badgeVariant === 'minimal') {
    fillColor = cfg.palette.badgeOuterBg;
    textColor = cfg.palette.tooltipText;
    shadow = true;
  } else {
    textColor = '#ffffff';
    if (!cfg.showMomentum) {
      fillColor = cfg.palette.line;
    } else {
      const target =
        momentum === 'up' ? 1 : momentum === 'down' ? 0 : badge.green;
      badge.green = noMotion
        ? target
        : lerp(badge.green, target, MOMENTUM_COLOR_LERP, dt);
      if (badge.green > 0.99) badge.green = 1;
      if (badge.green < 0.01) badge.green = 0;
      const g = badge.green;
      const rr = Math.round(
        MOMENTUM_RED[0] + (MOMENTUM_GREEN[0] - MOMENTUM_RED[0]) * g
      );
      const gg = Math.round(
        MOMENTUM_RED[1] + (MOMENTUM_GREEN[1] - MOMENTUM_RED[1]) * g
      );
      const bb = Math.round(
        MOMENTUM_RED[2] + (MOMENTUM_GREEN[2] - MOMENTUM_RED[2]) * g
      );
      fillColor = `rgb(${rr},${gg},${bb})`;
    }
  }

  // Build the pill path (SVG path string → SkPath), positioned at badge origin
  const d = cfg.badgeTail
    ? badgeSvgPath(pillW, pillH, BADGE_TAIL_LEN, BADGE_TAIL_SPREAD)
    : badgePillOnly(pillW, pillH);
  const path = Skia.Path.MakeFromSVGString(d);
  if (!path) return;
  path.offset(badgeLeft, badgeTop);

  ctx.save();
  ctx.globalAlpha = badgeOpacity;

  // Drop shadow for the minimal variant (approximates CSS drop-shadow(0 1px 4px))
  if (shadow) {
    ctx.shadowColor = cfg.palette.badgeOuterShadow;
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 1;
  }

  // Fill the pill via the shim's current path so shadow handling applies
  ctx.beginPathFrom(path);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.shadowBlur = 0;

  // Text — left-aligned inside the pill (matches the DOM span's padding box)
  ctx.font = ctx.fonts.label;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = textColor;
  ctx.fillText(text, badgeLeft + tailLen + BADGE_PAD_X, badge.y);
  ctx.textBaseline = 'alphabetic';

  ctx.restore();
}
