import type { LivelinePalette, ChartLayout } from '../types';
import { niceTimeInterval } from '../math/intervals';
import { lerp } from '../math/lerp';
import type { Ctx2D } from './canvas2d';

/** Pooled entry for a single visible time-axis label — see
 * `labelEntryPool` below for why this is reused rather than allocated
 * fresh per label per frame. */
interface TimeLabelEntry {
  x: number;
  alpha: number;
  text: string;
  w: number;
}

export interface TimeAxisState {
  labels: Map<number, { alpha: number; text: string }>;
  /** Scratch set for the per-frame target-interval computation — purely
   * local to a single `drawTimeAxis` call, but rebuilt unconditionally
   * every frame (this function has no picture-cache bypass, unlike
   * `drawGrid` — see the call site in draw/index.ts), so it's persisted
   * and `.clear()`-ed instead of reallocated 60x/sec. Same rationale as
   * `EngineState.smoothValuesScratch`. */
  targetsScratch: Set<number>;
  /** Reused container for this frame's "visible, sorted by X" label list.
   * `.length = 0` at the top of each use instead of a fresh array — mirrors
   * `EngineState.visibleScratch`. Holds references into `labelEntryPool`
   * below, never its own objects. */
  visibleLabelsScratch: TimeLabelEntry[];
  /** Reused container for this frame's post-overlap-resolution draw list.
   * Also holds references into `labelEntryPool`, never its own objects —
   * `.length = 0` at the top of each use. */
  drawnScratch: TimeLabelEntry[];
  /** Growable pool of reusable `{x,alpha,text,w}` objects, indexed by
   * position in this frame's visible-label scan (NOT by label key — a
   * given index may back a different label on every frame, which is fine
   * since every field is overwritten before use). Grows to the steady-state
   * max distinct visible labels needed (capped by the `targets.size < 30`
   * generation limit above, then further reduced by the alpha/visibility
   * filter) and then stops growing. Indexed into directly — never iterated
   * as a collection, since entries beyond this frame's fill count are
   * stale leftovers from a frame with more visible labels. */
  labelEntryPool: TimeLabelEntry[];
}

const FADE = 0.08;

export function drawTimeAxis(
  ctx: Ctx2D,
  layout: ChartLayout,
  palette: LivelinePalette,
  _windowSecs: number,
  targetWindowSecs: number,
  formatTime: (t: number) => string,
  state: TimeAxisState,
  dt: number
) {
  'worklet';
  const { h, pad, leftEdge, rightEdge, toX } = layout;
  const chartLeft = pad.left;
  const chartRight = layout.w - pad.right;
  const chartW = chartRight - chartLeft;
  const fadeZone = 50;

  const edgeAlpha = (x: number): number => {
    const fromLeft = x - chartLeft;
    const fromRight = chartRight - x;
    const fromEdge = Math.min(fromLeft, fromRight);
    if (fromEdge >= fadeZone) return 1;
    if (fromEdge <= 0) return 0;
    return fromEdge / fadeZone;
  };

  ctx.font = ctx.fonts.label;

  // Interval fully derived from target window — no dependency on the
  // interpolating display. Prevents a one-frame flicker when the transition
  // ends and windowSecs snaps to targetWindowSecs.
  const targetPxPerSec = chartW / targetWindowSecs;
  let interval = niceTimeInterval(targetWindowSecs);
  while (interval * targetPxPerSec < 60 && interval < targetWindowSecs) {
    interval *= 2;
  }

  // Generate labels: current view + 1 interval buffer.
  // Cap at 30 labels as a safety valve — during wide→narrow transitions the
  // target interval can be tiny relative to the current display span.
  // For day+ intervals, align to local midnight instead of UTC epoch.
  const useLocalDays = interval >= 86400;
  let firstTime: number;
  if (useLocalDays) {
    const d = new Date((leftEdge - interval) * 1000);
    d.setHours(0, 0, 0, 0);
    firstTime = d.getTime() / 1000;
  } else {
    firstTime = Math.ceil((leftEdge - interval) / interval) * interval;
  }
  const targets = state.targetsScratch;
  targets.clear();
  for (
    let t = firstTime;
    t <= rightEdge + interval && targets.size < 30;
    t += interval
  ) {
    targets.add(Math.round(t * 100));
  }

  // Create or update labels. Text is updated in-place — no crossfade needed
  // because format changes coincide with scroll transitions where the eye
  // tracks movement, not text content. By the time labels settle, the text
  // is already correct so nothing visibly changes on stationary labels.
  for (const key of targets) {
    const text = formatTime(key / 100);
    const existing = state.labels.get(key);
    if (!existing) {
      state.labels.set(key, { alpha: 0, text });
    } else {
      existing.text = text;
    }
  }

  // Update alphas
  for (const [key, label] of state.labels) {
    const x = toX(key / 100);
    const isTarget = targets.has(key);
    const target = isTarget ? edgeAlpha(x) : 0;
    let next = lerp(label.alpha, target, FADE, dt);
    if (Math.abs(next - target) < 0.02) next = target;
    if (next < 0.01 && target === 0) {
      state.labels.delete(key);
    } else {
      label.alpha = next;
    }
  }

  // Draw
  const baseAlpha = ctx.globalAlpha;
  const lineY = h - pad.bottom;
  const tickLen = 5;

  ctx.strokeStyle = palette.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(chartLeft, lineY);
  ctx.lineTo(chartRight, lineY);
  ctx.stroke();

  ctx.textAlign = 'center';

  // Collect, sort by X, resolve overlaps by keeping the more-visible label.
  // `labels` and the per-entry objects it holds are pooled on state (see
  // `visibleLabelsScratch`/`labelEntryPool` docs) instead of allocated
  // fresh every frame — sorting a pooled-object array works exactly like
  // sorting any array, since sort only reorders positions, not identities.
  const labels = state.visibleLabelsScratch;
  labels.length = 0;
  let poolIdx = 0;
  for (const [key, label] of state.labels) {
    if (label.alpha < 0.02) continue;
    const x = toX(key / 100);
    if (x < chartLeft - 20 || x > chartRight) continue;
    const w = ctx.measureText(label.text).width;
    let entry = state.labelEntryPool[poolIdx];
    if (!entry) {
      entry = { x, alpha: label.alpha, text: label.text, w };
      state.labelEntryPool[poolIdx] = entry;
    } else {
      entry.x = x;
      entry.alpha = label.alpha;
      entry.text = label.text;
      entry.w = w;
    }
    poolIdx++;
    labels.push(entry);
  }
  labels.sort((a, b) => a.x - b.x);

  // Resolve overlaps: when two labels collide, keep the higher-alpha one.
  // This gives a clean one-time crossover (no flickering) because one alpha
  // is always rising while the other is falling. `drawn` only ever holds
  // references into the same pooled objects above — never its own.
  const drawn = state.drawnScratch;
  drawn.length = 0;
  for (const label of labels) {
    const left = label.x - label.w / 2;
    if (drawn.length > 0) {
      const prev = drawn[drawn.length - 1]!;
      const prevRight = prev.x + prev.w / 2;
      if (left < prevRight + 8) {
        // Overlap — swap in the higher-alpha label
        if (label.alpha > prev.alpha) {
          drawn[drawn.length - 1] = label;
        }
        continue;
      }
    }
    drawn.push(label);
  }

  for (const label of drawn) {
    ctx.save();
    ctx.globalAlpha = baseAlpha * label.alpha;

    ctx.strokeStyle = palette.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(label.x, lineY);
    ctx.lineTo(label.x, lineY + tickLen);
    ctx.stroke();

    ctx.fillStyle = palette.timeLabel;
    ctx.fillText(label.text, label.x, lineY + tickLen + 14);

    ctx.restore();
  }
}
