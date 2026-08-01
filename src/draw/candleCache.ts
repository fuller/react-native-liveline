import type { ChartLayout, CandlePoint } from '../types';
import {
  ensured,
  createLayoutKey,
  writeLayoutKey,
  layoutKeyMatches,
  type CachePath,
  type LayoutKey,
} from './pathCache';

export type { CachePath } from './pathCache';

/**
 * Cross-frame cache for candlestick body+wick geometry (see draw/lineCache.ts
 * for the sibling implementation this mirrors).
 *
 * Between candle closes, almost nothing about the CLOSED candles changes:
 * the time-scroll is a pure horizontal translate (same reasoning as the line
 * cache — toX is affine outside window transitions), and the Y-range lerp
 * snaps exactly when settled. Yet drawCandlesticks rebuilt the full body+wick
 * geometry every frame for every closed candle — for wide candles (the
 * common case) each body is a rounded rect, 9 native path calls instead of a
 * plain rect.
 *
 * This module caches four combined paths (bull bodies, bull wicks, bear
 * bodies, bear wicks) built from every CLOSED candle only, batched exactly
 * like drawCandlesticks' existing canBatch fast path already batches them
 * per-frame. On a cache hit, the caller draws each cached path translated by
 * `dx` (computed against the build-time reference, never accumulated, so
 * there is no drift) instead of rebuilding. The live (currently-forming)
 * candle is never part of this cache — its OHLC changes every tick, so it
 * continues to be drawn fresh every frame by drawCandlesticks, exactly as
 * before this cache existed.
 *
 * Geometry-only: colors are never baked into these paths (drawCandlesticks
 * applies bullColor/bearColor via ctx.fillStyle/strokeStyle at draw time,
 * same as today), so accent-blend/line-mode-morph color animation keeps
 * working unchanged on top of cached geometry.
 *
 * Kept free of Skia imports (paths are typed structurally via `CachePath`,
 * shared with the line + badge caches — see draw/pathCache.ts) so jest can
 * exercise the full key/geometry logic with fake path recorders.
 */

/** How drawCandlesticks receives a cache: the slot plus the data-identity
 * inputs, mirroring LineCacheRef. */
export interface CandleCacheRef {
  slot: CandleCacheSlot;
  /** Which backing array the candles came from: 0 = live buffer, 1 = paused
   * snapshot, 2 = reverse-morph stash. Guards against a false cache hit if a
   * source switch ever coincidentally preserves candle count/first/last time
   * (see engine/step.ts's dataSourceOf, reused here). */
  dataSource: number;
  /** Revision counter bumped whenever the candles buffer actually changed
   * (0 where no counter is available — the value-heuristic key fields still
   * catch appends/prunes/live-candle changes). Catches a consumer revising
   * an ALREADY-CLOSED candle in place (a late trade correcting the previous
   * bar's close, or an exchange sending a corrected OHLC): closedCount and
   * firstClosedTime/lastClosedTime don't move, and if the revision doesn't
   * move the visible extreme neither do minVal/maxVal, so without this the
   * cache would keep serving the stale body until the next candle closes. */
  candlesRev: number;
}

export interface CandleCacheSlot {
  /** Combined bull-candle body path (rounded rects), build-time screen coords. */
  bullBodies: CachePath | null;
  /** Combined bull-candle wick path (moveTo/lineTo pairs), build-time screen coords. */
  bullWicks: CachePath | null;
  /** Combined bear-candle body path. */
  bearBodies: CachePath | null;
  /** Combined bear-candle wick path. */
  bearWicks: CachePath | null;

  // "This group actually has content" flags — mirrors the bodyCount>0 /
  // wickCount>0 guards in drawCandlesticks today. An empty cached path must
  // not be fill()'d/stroke()'d.
  hasBullBodies: boolean;
  hasBullWicks: boolean;
  hasBearBodies: boolean;
  hasBearWicks: boolean;

  // Reference point for the translate, same idea as LineCacheSlot's
  // tRef/xRefAtBuild.
  tRef: number; // time of the first closed candle at build
  xRefAtBuild: number; // toX(tRef) at build

  // Invalidation key — flat numbers only, compared field-by-field so a
  // per-frame check allocates nothing. Validity is `bullBodies !== null` (no
  // separate boolean — all four paths are always (re)built together).
  //
  // The candle-identity half lives here; the layout half is the shared
  // `LayoutKey` below, the same object type LineCacheSlot embeds — one
  // spelling of min/max/x-scale/h/pads/chartW for both caches. Nested object,
  // but allocated once per slot in `createCandleCacheSlot` and overwritten in
  // place by `writeLayoutKey`, so the per-frame compare still allocates
  // nothing.
  kCandlesRev: number;
  kDataSource: number; // not layout — stays here, see pathCache.ts LayoutKey
  kCandleWidthSecs: number;
  kClosedCount: number; // count of non-live candles in the frame's candle list
  kFirstClosedTime: number;
  kLastClosedTime: number;
  kRadius: number; // candleDims' radius — depends on bodyW (zoom level)
  /** Layout half of the key — see `LayoutKey` in pathCache.ts. */
  layoutKey: LayoutKey;
}

/** Below this many closed candles the legacy rebuild is cheap anyway. */
export const MIN_CACHE_CANDLES = 6;

export function createCandleCacheSlot(): CandleCacheSlot {
  'worklet';
  return {
    bullBodies: null,
    bullWicks: null,
    bearBodies: null,
    bearWicks: null,
    hasBullBodies: false,
    hasBullWicks: false,
    hasBearBodies: false,
    hasBearWicks: false,
    tRef: 0,
    xRefAtBuild: 0,
    kCandlesRev: 0,
    kDataSource: 0,
    kCandleWidthSecs: 0,
    kClosedCount: 0,
    kFirstClosedTime: 0,
    kLastClosedTime: 0,
    kRadius: 0,
    layoutKey: createLayoutKey(),
  };
}

/**
 * Rounded-rect body geometry, built directly onto a CachePath (the
 * cache-side twin of candlestick.ts's `roundedRect`, which draws through a
 * Ctx2D instead). Kept in sync intentionally — same fallback-to-plain-rect
 * threshold (`r <= 0 || h < r * 2`) and the same corner winding.
 */
function roundedRectOnPath(
  path: CachePath,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  'worklet';
  if (r <= 0 || h < r * 2) {
    path.moveTo(x, y);
    path.lineTo(x + w, y);
    path.lineTo(x + w, y + h);
    path.lineTo(x, y + h);
    path.close();
    return;
  }
  path.moveTo(x + r, y);
  path.lineTo(x + w - r, y);
  path.arcToTangent(x + w, y, x + w, y + r, r);
  path.lineTo(x + w, y + h - r);
  path.arcToTangent(x + w, y + h, x + w - r, y + h, r);
  path.lineTo(x + r, y + h);
  path.arcToTangent(x, y + h, x, y + h - r, r);
  path.lineTo(x, y + r);
  path.arcToTangent(x, y, x + r, y, r);
  path.close();
}

/**
 * Key-compare → on miss rebuild the four combined paths from every CLOSED
 * candle in `candles` (batched by bull/bear exactly like drawCandlesticks'
 * canBatch path does today).
 *
 * Returns true when the slot's cached paths are ready to draw (either a
 * translate-only hit, or a freshly rebuilt set) — the caller draws each
 * group translated by `dx = layout.toX(slot.tRef) - slot.xRefAtBuild` (via
 * ctx.translate + beginPathFrom, since unlike the line cache there is no
 * live tail to append onto the cached geometry — the live candle is drawn
 * entirely separately). Returns false when caching doesn't apply (too few
 * closed candles) and the caller must fall back to the legacy per-frame
 * rebuild.
 *
 * Caller must only invoke this when canBatch is true (scrub-dimming gives
 * each candle its own continuous alpha, incompatible with a combined path)
 * and outside candle-width morph / mid line-mode-morph / reveal-OHLC-collapse
 * (all of which change candle geometry every frame in ways this key doesn't
 * track) — see the call site in candlestick.ts / index.ts for exactly which
 * upstream conditions gate that.
 */
export function updateCandleCache(
  slot: CandleCacheSlot,
  makePath: () => CachePath,
  layout: ChartLayout,
  candles: CandlePoint[],
  candleWidthSecs: number,
  liveTime: number,
  bodyW: number,
  radius: number,
  dataSource: number,
  candlesRev: number
): boolean {
  'worklet';
  // Scan closed-candle identity (no allocation): count + first/last time.
  let closedCount = 0;
  let firstClosedTime = 0;
  let lastClosedTime = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (c.time === liveTime) continue;
    if (closedCount === 0) firstClosedTime = c.time;
    lastClosedTime = c.time;
    closedCount++;
  }
  if (closedCount < MIN_CACHE_CANDLES) return false;

  const hit =
    slot.bullBodies !== null &&
    slot.kCandlesRev === candlesRev &&
    slot.kDataSource === dataSource &&
    slot.kCandleWidthSecs === candleWidthSecs &&
    slot.kClosedCount === closedCount &&
    slot.kFirstClosedTime === firstClosedTime &&
    slot.kLastClosedTime === lastClosedTime &&
    slot.kRadius === radius &&
    layoutKeyMatches(slot.layoutKey, layout);

  if (hit) return true;

  const { toX, toY } = layout;
  const halfBody = bodyW / 2;
  const padL = layout.pad.left;
  const padR = layout.pad.left + layout.chartW;

  slot.bullBodies = ensured(slot.bullBodies, makePath);
  slot.bullWicks = ensured(slot.bullWicks, makePath);
  slot.bearBodies = ensured(slot.bearBodies, makePath);
  slot.bearWicks = ensured(slot.bearWicks, makePath);
  const bullBodies = slot.bullBodies;
  const bullWicks = slot.bullWicks;
  const bearBodies = slot.bearBodies;
  const bearWicks = slot.bearWicks;
  bullBodies.rewind();
  bullWicks.rewind();
  bearBodies.rewind();
  bearWicks.rewind();

  let hasBullBodies = false;
  let hasBullWicks = false;
  let hasBearBodies = false;
  let hasBearWicks = false;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (c.time === liveTime) continue;
    const cx = toX(c.time + candleWidthSecs / 2);
    if (cx + halfBody < padL || cx - halfBody > padR) continue;

    const isBull = c.close >= c.open;
    const bodyTop = toY(Math.max(c.open, c.close));
    const bodyBottom = toY(Math.min(c.open, c.close));
    const bodyH = Math.max(1, bodyBottom - bodyTop);
    const wickTop = toY(c.high);
    const wickBottom = toY(c.low);

    const bodiesPath = isBull ? bullBodies : bearBodies;
    const wicksPath = isBull ? bullWicks : bearWicks;

    roundedRectOnPath(bodiesPath, cx - halfBody, bodyTop, bodyW, bodyH, radius);
    if (isBull) hasBullBodies = true;
    else hasBearBodies = true;

    if (bodyTop - wickTop > 0.5) {
      wicksPath.moveTo(cx, bodyTop);
      wicksPath.lineTo(cx, wickTop);
      if (isBull) hasBullWicks = true;
      else hasBearWicks = true;
    }
    if (wickBottom - bodyBottom > 0.5) {
      wicksPath.moveTo(cx, bodyBottom);
      wicksPath.lineTo(cx, wickBottom);
      if (isBull) hasBullWicks = true;
      else hasBearWicks = true;
    }
  }

  slot.hasBullBodies = hasBullBodies;
  slot.hasBullWicks = hasBullWicks;
  slot.hasBearBodies = hasBearBodies;
  slot.hasBearWicks = hasBearWicks;

  slot.tRef = firstClosedTime;
  slot.xRefAtBuild = toX(firstClosedTime);

  slot.kCandlesRev = candlesRev;
  slot.kDataSource = dataSource;
  slot.kCandleWidthSecs = candleWidthSecs;
  slot.kClosedCount = closedCount;
  slot.kFirstClosedTime = firstClosedTime;
  slot.kLastClosedTime = lastClosedTime;
  slot.kRadius = radius;
  writeLayoutKey(slot.layoutKey, layout);

  return true;
}
