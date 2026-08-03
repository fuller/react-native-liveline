import type { LivelinePalette, ChartLayout, OrderbookData } from '../types';
import type { SkColor } from '@shopify/react-native-skia';
import type { Ctx2D } from './canvas2d';

// Green: rgb(34, 197, 94), Red: rgb(239, 68, 68)
const GREEN: [number, number, number] = [34, 197, 94];
const RED: [number, number, number] = [239, 68, 68];

interface StreamLabel {
  y: number;
  text: string;
  green: boolean;
  life: number;
  maxLife: number;
  intensity: number; // 0-1, bigger orders = brighter
}

export interface OrderbookState {
  labels: StreamLabel[];
  spawnTimer: number;
  smoothSpeed: number;
  // Orderbook churn tracking
  prevBidTotal: number;
  prevAskTotal: number;
  churnRate: number; // smoothed 0-1, how much the book is changing
  // outlineColor cache: rebuilding a template string every frame is wasted
  // work since palette.bgRgb only changes on a theme swap. Flat numeric
  // fields (not a tuple/array) so the hit check is alloc-free, matching the
  // LineCacheSlot / badge pill path cache style used elsewhere.
  outlineColorR: number;
  outlineColorG: number;
  outlineColorB: number;
  outlineColor: string;
  // Pooled SkColor scratch buffers for the per-label fill blend (mixColorInto
  // below) — one Float32Array(4) per label slot, mutated in place every
  // frame instead of allocating a fresh one per label per frame (see
  // mixColorInto for why reusing these across labels/frames is safe).
  colorPool: SkColor[];
}

// NOTE: these consts MUST be declared above createOrderbookState. The
// worklets babel plugin captures a worklet's closure at module evaluation,
// so consts declared below a worklet that references them are captured as
// `undefined` (hoisting is lost in the transform) — BASE_SPEED would become
// undefined, poisoning smoothSpeed/label.y with NaN on the UI thread.
const MAX_LABELS = 50;
const LABEL_LIFETIME = 6; // seconds
const SPAWN_INTERVAL = 40; // ms
const MIN_LABEL_GAP = 22; // px
const BASE_SPEED = 60; // px/s calm
const MAX_SPEED = 160; // px/s during big activity

export function createOrderbookState(): OrderbookState {
  'worklet';
  const colorPool: SkColor[] = [];
  for (let i = 0; i < MAX_LABELS; i++) {
    colorPool.push(new Float32Array(4) as unknown as SkColor);
  }
  return {
    labels: [],
    spawnTimer: 0,
    smoothSpeed: BASE_SPEED,
    prevBidTotal: 0,
    prevAskTotal: 0,
    churnRate: 0,
    // -1 is not a valid RGB channel value, so the first frame always misses
    // and builds outlineColor for real.
    outlineColorR: -1,
    outlineColorG: -1,
    outlineColorB: -1,
    outlineColor: '',
    colorPool,
  };
}

// Blends `from` -> `to` by `t` and writes the RGBA into `out` in place
// (out is a pooled Float32Array(4) — see OrderbookState.colorPool) instead
// of allocating a fresh SkColor per call. This runs once per active label
// per frame (up to MAX_LABELS = 50 times), so at 60fps that's up to ~3,000
// Float32Array allocations/sec avoided.
//
// Aliasing: `out` is safe to mutate and reuse because every write is
// consumed synchronously before the next write happens. The draw loop below
// does, per label, in order: mixColorInto(...) -> ctx.fillStyle = fillColor
// -> ctx.fillText(...). fillText's paint.setColor(style) (see canvas2d.ts's
// applyStyle) copies the 4 floats into Skia's native paint state
// synchronously on the same JS-thread call — there is no deferred/async read
// of the array later. So by the time the loop moves on to the next label and
// reuses the *next* pool slot (or, next frame, wraps back to slot 0), Skia
// has already consumed every previously-written value; nothing is reading a
// stale or in-flight reference to a pool slot. Each iteration also uses a
// distinct slot (indexed by loop position, not label identity), so there is
// no intra-frame slot collision either.
export function mixColorInto(
  out: SkColor,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  t: number
): SkColor {
  'worklet';
  const o = out as unknown as Float32Array;
  o[0] = Math.round(from[0] + (to[0] - from[0]) * t) / 255;
  o[1] = Math.round(from[1] + (to[1] - from[1]) * t) / 255;
  o[2] = Math.round(from[2] + (to[2] - from[2]) * t) / 255;
  o[3] = 1;
  return out;
}

function formatSize(size: number): string {
  'worklet';
  if (size >= 10) return `$${Math.round(size)}`;
  if (size >= 1) return `$${size.toFixed(1)}`;
  return `$${size.toFixed(2)}`;
}

/**
 * Kalshi-style orderbook: left-aligned column spanning full chart height.
 * Labels decelerate as they rise — fast entry at bottom, slow drift at top.
 * Speed driven by two signals:
 *   1. swingMagnitude — price momentum (proxy for activity)
 *   2. orderbook churn — how much the bid/ask data itself is changing
 * Whichever signal is stronger wins. Works with both demo and production data.
 */
export function drawOrderbook(
  ctx: Ctx2D,
  layout: ChartLayout,
  palette: LivelinePalette,
  orderbook: OrderbookData,
  dt: number,
  state: OrderbookState,
  swingMagnitude: number
): void {
  'worklet';
  const { pad, h, chartH } = layout;
  const dtSec = dt / 1000;

  if (orderbook.bids.length === 0 && orderbook.asks.length === 0) return;

  let maxSize = 0;
  let bidTotal = 0;
  let askTotal = 0;
  for (const [, size] of orderbook.bids) {
    bidTotal += size;
    if (size > maxSize) maxSize = size;
  }
  for (const [, size] of orderbook.asks) {
    askTotal += size;
    if (size > maxSize) maxSize = size;
  }
  if (maxSize === 0) return;

  // Measure orderbook churn: how much total size changed since last frame
  // Normalized by the total size so it's scale-independent
  const prevTotal = state.prevBidTotal + state.prevAskTotal;
  let churnSignal = 0;
  if (prevTotal > 0) {
    const delta =
      Math.abs(bidTotal - state.prevBidTotal) +
      Math.abs(askTotal - state.prevAskTotal);
    churnSignal = Math.min(delta / prevTotal, 1); // 0-1
  }
  state.prevBidTotal = bidTotal;
  state.prevAskTotal = askTotal;

  // Smooth the churn rate (fast attack, slower decay). Converted to the
  // same continuous-decay form as speedLerp below — a fixed per-call blend
  // factor would smooth more slowly in wall-clock terms whenever a frame
  // gets skipped (frame pacing, a stalled JS thread, ...) since it's
  // applied once per call, not once per unit time.
  const churnRateTarget = churnSignal > state.churnRate ? 0.3 : 0.05;
  const churnLerp = 1 - Math.pow(1 - churnRateTarget, dt / 16.67);
  state.churnRate += (churnSignal - state.churnRate) * churnLerp;

  // Activity = max of price momentum and orderbook churn
  const activity = Math.max(Math.min(swingMagnitude * 5, 1), state.churnRate);

  // Drive speed from activity
  const targetSpeed = BASE_SPEED + activity * (MAX_SPEED - BASE_SPEED);
  const speedLerp = 1 - Math.pow(0.95, dt / 16.67);
  state.smoothSpeed += (targetSpeed - state.smoothSpeed) * speedLerp;
  const speed = state.smoothSpeed;

  const labelX = pad.left + 8;
  const bottomY = h - pad.bottom - 6;
  const topY = pad.top;
  const bg = palette.bgRgb;

  // Spawn new labels at bottom
  state.spawnTimer += dt;
  while (
    state.spawnTimer >= SPAWN_INTERVAL &&
    state.labels.length < MAX_LABELS
  ) {
    state.spawnTimer -= SPAWN_INTERVAL;

    // Check overlap against ALL existing labels near spawn point
    let tooClose = false;
    for (let j = 0; j < state.labels.length; j++) {
      if (Math.abs(state.labels[j]!.y - bottomY) < MIN_LABEL_GAP) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) break;

    // Weighted random pick. Walk bids then asks directly instead of
    // building a combined `{size, green}` scratch array first — bidTotal
    // and askTotal are already computed above, so totalWeight is free, and
    // this spawn loop runs up to ~25x/sec even when the book itself hasn't
    // changed between spawns, so avoiding the per-spawn array/object churn
    // matters. Scan order (bids first, then asks) and the <= 0 tie-break
    // match the original allLevels construction exactly, so the weighted
    // distribution is unchanged.
    const totalWeight = bidTotal + askTotal;
    let r = Math.random() * totalWeight;
    // Fallback matches the old `allLevels[0]` default (only reached if
    // float rounding means r never drops to <=0 in the walk below): first
    // bid if any exist, else first ask.
    let pickedSize = orderbook.bids[0]?.[1] ?? orderbook.asks[0]?.[1] ?? 0;
    let pickedGreen = orderbook.bids.length > 0;
    let found = false;
    for (const [, size] of orderbook.bids) {
      r -= size;
      if (r <= 0) {
        pickedSize = size;
        pickedGreen = true;
        found = true;
        break;
      }
    }
    if (!found) {
      for (const [, size] of orderbook.asks) {
        r -= size;
        if (r <= 0) {
          pickedSize = size;
          pickedGreen = false;
          found = true;
          break;
        }
      }
    }

    const sizeRatio = pickedSize / maxSize;
    state.labels.push({
      y: bottomY,
      text: `+ ${formatSize(pickedSize)}`,
      green: pickedGreen,
      life: LABEL_LIFETIME,
      maxLife: LABEL_LIFETIME,
      intensity: 0.5 + sizeRatio * 0.5,
    });
  }

  // Update positions — decelerate as labels rise (fast at bottom, slow at top)
  const range = bottomY - topY;
  let writeIdx = 0;
  for (let i = 0; i < state.labels.length; i++) {
    const l = state.labels[i]!;
    l.life -= dtSec;
    if (l.life <= 0) continue;
    const yProgress = range > 0 ? (l.y - topY) / range : 1; // 1 at bottom, 0 at top
    l.y -= speed * (0.7 + 0.3 * yProgress) * dtSec;
    if (l.y < topY - 14) continue;
    state.labels[writeIdx++] = l;
  }
  state.labels.length = writeIdx;

  // Draw
  const baseAlpha = ctx.globalAlpha;
  ctx.save();
  ctx.font = ctx.fonts.orderbook;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = baseAlpha;

  // Cache the outline color template string keyed on the RGB triple it was
  // built from — bg (palette.bgRgb) only changes on a theme swap, but this
  // draw path runs every frame the orderbook is on screen, so rebuilding
  // the string unconditionally wastes an allocation on every one of those
  // frames.
  if (
    state.outlineColorR !== bg[0] ||
    state.outlineColorG !== bg[1] ||
    state.outlineColorB !== bg[2]
  ) {
    state.outlineColorR = bg[0];
    state.outlineColorG = bg[1];
    state.outlineColorB = bg[2];
    state.outlineColor = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
  }
  const outlineColor = state.outlineColor;

  for (let i = 0; i < state.labels.length; i++) {
    const l = state.labels[i]!;
    const lifeRatio = l.life / l.maxLife;

    // Fade in quickly, fade out near top of chart
    const fadeIn = Math.min((1 - lifeRatio) * 10, 1);
    const yRatio = (l.y - topY) / chartH;
    const fadeOut = yRatio < 0.45 ? yRatio / 0.45 : 1;

    const colorStrength = l.intensity * fadeIn * fadeOut;
    const baseColor = l.green ? GREEN : RED;
    const fillColor = mixColorInto(
      state.colorPool[i]!,
      baseColor,
      bg,
      1 - colorStrength
    );

    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.strokeText(l.text, labelX, l.y);

    ctx.fillStyle = fillColor;
    ctx.fillText(l.text, labelX, l.y);
  }

  ctx.restore();
}
