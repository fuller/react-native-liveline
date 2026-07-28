# react-native-liveline — Maintainability hardening

**STATUS: NOT STARTED (written 2026-07-28).** Nothing in this doc has been
implemented. Seven items, ranked below; work them in the order given in
"Suggested execution order" at the bottom, not top-to-bottom.

**Read this first when resuming work.** This is the third standalone
workstream doc, alongside:

- `PLAN.md` — the original web→RN port. Fully shipped as of v0.1.0. Don't
  relitigate anything marked done there.
- `PLAN_PERF.md` — the react-native-graph comparison + perf hardening.
  Complete as of 2026-07-18; a much larger follow-on perf batch landed
  2026-07-26/27 and shipped as v0.2.0.

This doc is **not** about performance. Several items below would touch
per-frame hot paths, and the rule for every one of them is: *do not regress
the perf work that already landed.* Where an item has an allocation cost,
it's stated explicitly.

## Preceding work (context for the line numbers below)

A perf session on 2026-07-27/28 produced two changes. Both were
typecheck/lint/test green and visually verified on the iOS sim, and both
**measured no CPU delta** (three arms, Candles tab, Debug sim: before 65.4%,
after 66.9%, after-recheck 64.6% — the after arms bracket the before arm, so
any effect is below the measurement floor there).

- **Landed:** a candle-mode dead-work gate in `engine/step.ts` — the
  `wantLineVisible` guard around the two `lineVisible` builders, skipping an
  array the drawer was already discarding in steady candle mode. Every line
  number in this doc is verified against the tree *with* this applied.
- **Deliberately deferred:** pooled decimation scratch (`DecimateScratch` in
  `math/decimate.ts`, threaded through `engine/state.ts` → `draw/line.ts` →
  `draw/index.ts`, with six tests). Written, green, then reverted — see
  item 4 for why, and pick it back up there.

## How this doc came to be

A maintainability survey of all of `src/` (47 files, ~15.5k lines) run on
2026-07-28, prompted by the observation that the 2026-07-26/27 perf batch
optimized aggressively *within* existing structures without revisiting the
structures themselves. Method: structural mapping of the two largest files,
a `difflib` similarity measurement between the three pipelines in
`engine/step.ts`, a scan for functions with ≥9 positional parameters, a
source-file-to-test-file coverage map, and targeted greps for copy-pasted
idioms. Item 3 below is a real (small) bug found by that survey, not a
hypothetical.

## Findings & plan, ranked by impact

### 1. `engineStep` is a ~1700-line function containing three inline pipelines

**Problem:** `src/engine/step.ts:120` (`engineStep`) runs to the end of an
1818-line file. Inside one function body:

- shared preamble: ~120–402
- CANDLE MODE PIPELINE: 403–1054
- MULTI-SERIES LINE MODE PIPELINE: 1055–1516
- LINE MODE PIPELINE: 1517–end

Measured with `difflib.SequenceMatcher` over the multi-series pipeline (466
lines) against the single-line pipeline (274 lines): **132 identical lines,
48% of the smaller pipeline.** The largest identical run is **53 consecutive
lines** — the `updateRange` call through the `layout` literal through the
grid-layer sync — at `step.ts:1339` and `step.ts:1607`. Also duplicated: an
18-line reveal/empty-overlay tail block, and the 9-line
`updateWindowTransition` call.

**Plan:**
- Extract `stepCandle`, `stepMulti`, `stepLine` into
  `engine/pipelines/candle.ts` / `multi.ts` / `line.ts`. Each takes the
  already-computed preamble results plus `(ctx, cfg, s, layout, …)` and
  returns the same `StepResult` shape `engineStep` returns today.
- Extract the 53-line shared run as `prepareChartFrame()` in
  `engine/frame.ts` — it is `updateRange` → destructure → `makeLayout`
  (item 2) → grid-layer sync. The one real difference between the three
  call sites is the `dt` passed to `updateGridLayer` (candle mode passes
  `pausedDt`, the other two pass `dt`), so that's a parameter, not a
  divergence to paper over.
- `engineStep` itself becomes: preamble → dispatch to one of three.
- **Do this last.** It is the highest-value item and the highest-risk one;
  item 6 (tests) is the prerequisite that makes it safe.

**Verification:** this is a pure refactor — no behavior change is intended.
Beyond typecheck/lint/test, run the iOS sim check across all three modes
(Line tab, Candles tab, Multi tab) and compare against screenshots taken
before starting. Also re-run the Part 2 CPU A/B from the `run-and-profile`
skill: a pure refactor must not move CPU, and if it does, something was
changed that shouldn't have been.

### 2. The `layout` object is constructed byte-identically three times

**Problem:** `step.ts:758`, `:1360`, `:1628` — the same 15-line
`const layout: ChartLayout = { … }` literal, including both the `toX` and
`toY` closures, three times over. Verified byte-identical.

**Plan:** extract `makeLayout(w, h, pad, chartW, chartH, leftEdge,
rightEdge, rangeResult): ChartLayout` into `engine/helpers.ts` (or
`engine/frame.ts` if item 1 lands first — it's a natural part of
`prepareChartFrame`). Zero risk, mechanical, and it removes the possibility
of the three drifting apart silently.

**Note:** keep the two closures as closures. They're allocated once per
frame per chart, which is already the case today; do not try to "optimize"
them into a shared object with mutable captured state.

### 3. Copy-pasted per-series map pruning — has already caused a leak

**Problem:** `step.ts:1098-1118` prunes per-series Maps when series are
removed, as four near-identical hand-written loops (`s.displayValues`,
`s.lineCaches`, `s.multiVisibleScratch`, `s.multiSeriesEntryScratch`).

`EngineState` declares **eight** per-series `Map<string, …>` fields
(`state.ts:49,50,56,97,105,128,172,173`). `s.seriesAlpha` (`state.ts:50`)
has exactly the same lifecycle as the four that are pruned — written per
series at `step.ts:1167`, read at `:1160` and `:1259` — but it is **never
pruned or cleared anywhere in the codebase** (confirmed: the only
references are its declaration, its construction at `state.ts:253`, and
those three uses).

So a long-lived chart whose series ids churn accumulates dead `seriesAlpha`
entries forever. The impact is small — one number per dead id, and ids are
stable across renders in normal use — but it is a real unbounded-growth bug,
and it exists *because* adding a fifth map means remembering to hand-write a
fifth loop.

**Plan:**
- Add `pruneByIds(currentIds: Set<string>, maps: Map<string, unknown>[])`
  as a worklet helper (probably `engine/state.ts`, next to the state it
  serves).
- Better: give `EngineState` a `perSeriesMaps` accessor returning the array
  of maps that must be pruned together, so the registration lives next to
  the field declarations and a new map is one line in one place.
- Add `seriesAlpha` to that set — **this is the actual bug fix.**
- Audit the other three unpruned per-series maps while you're there
  (`smoothValuesScratch` is cleared per frame so it's fine;
  `lastMultiStashRevs`/`lastMultiStashData` are pruned separately at
  `step.ts:310-312`; confirm that's genuinely sufficient rather than
  assuming it).

**Verification:** unit-testable without the worklet runtime — construct an
`EngineState`, populate the maps with ids, prune against a smaller id set,
assert every map shrank. This is the cheapest real test in this whole doc.

### 4. Positional-parameter soup — 11 functions with ≥9 parameters

**Problem:** a scan of `src/` (excluding tests) for functions with ≥9
positional parameters:

| params | location | function |
|---|---|---|
| 19 | `engine/candleHelpers.ts:126` | `updateCandleWindowTransition` |
| 16 | `draw/line.ts:205` | `drawLine` |
| 15 | `draw/candlestick.ts:140` | `drawCandlesticks` |
| 14 | `engine/candleHelpers.ts:59` | `updateCandleRange` |
| 13 | `engine/step.ts:120` | `engineStep` |
| 12 | `engine/helpers.ts:104` | `updateRange` |
| 12 | `engine/helpers.ts:183` | `updateHoverState` |
| 11 | `draw/line.ts:166` | `paintLineCurve` |
| 11 | `engine/badge.ts:36` | `drawBadge` |
| 11 | `engine/helpers.ts:43` | `updateWindowTransition` |
| 9 | `draw/empty.ts:19` | `drawEmpty` |

Many of these take long runs of consecutive `number` arguments, so a
transposed pair type-checks silently and fails only visually, at runtime, on
one device mode.

**This item already blocked a change once.** A pooled-decimation-scratch
perf change (see "Preceding work" above) needed one more value inside
`drawLine`, which meant a 17th positional parameter and a matching edit at
all three call sites. It was written, tested, and green — then reverted
specifically because paying that cost for an unmeasurable win was the wrong
trade while the signature is this shape. **Land this item, then re-do the
scratch pooling as a field on the options object**, where it costs nothing
structurally. That's the intended sequencing, not an abandoned idea.

**The fix already exists in this codebase and is applied inconsistently:**
`draw/index.ts` defines `DrawOptions` (`:135`), `MultiSeriesDrawOptions`
(`:422`), and `CandleDrawOptions` (`:675`) and passes options objects to
`drawFrame`/`drawMultiFrame`/`drawCandleFrame`. The functions those three
*call* are the ones still taking positional soup.

**Plan:**
- Convert the table above to options objects, following the existing
  `*Options` interface naming and the existing convention of documenting
  each field on the interface.
- Start with `updateCandleWindowTransition` (19) and `drawLine` (17) —
  worst offenders, biggest readability win.
- **Allocation note, read before starting:** every one of these is called
  at most a couple of times per frame, not per point. An options object per
  call is roughly ten small short-lived objects per frame, against a shim
  that already pools far more than that per frame. This is not a hot-loop
  concern. It *would* be if any of these moved inside a per-point loop —
  none are, and none should be.
- Do **not** convert per-point helpers (`math/lerp.ts`, `math/color.ts`,
  the spline emit functions) to options objects. Those genuinely are hot.

### 5. The two cross-frame path caches have drifted apart

**Problem:** `draw/lineCache.ts:68-80` and `draw/candleCache.ts:84-97`
declare overlapping flat invalidation-key fields with inconsistent names —
`kMin`/`kMax` in one, `kMinVal`/`kMaxVal` in the other, for the same
`layout.minVal`/`layout.maxVal`. Eight fields are common to both
(`kDataSource`, `kWindow`, `kH`, `kPadTop`, `kPadBottom`, `kChartW`, plus
the min/max pair).

`draw/pathCache.ts` already established the precedent for factoring shared
cache machinery out of the two cache modules (`CachePath`, `ensured`) and
explains in its docblock why it stays free of Skia imports — so jest can
exercise cache logic with fake path recorders. That reasoning extends
cleanly to the key comparison.

**Plan:**
- Add a `LayoutKey` struct + `writeLayoutKey(key, layout)` +
  `layoutKeyMatches(key, layout)` to `draw/pathCache.ts`.
- Embed it in both slot types, leaving each cache's *own* data-identity
  fields (`kDataRev`/`kLen`/`kFirstT`/… for the line, `kCandlesRev`/
  `kClosedCount`/`kRadius`/… for candles) where they are.
- Keep the comparison allocation-free and field-by-field — read the
  docblock on `LineCacheSlot`'s key before touching this; the "flat numbers
  only, compared field-by-field so a per-frame check allocates nothing"
  property is deliberate and load-bearing.
- Both cache modules already have real test files
  (`lineCache.test.ts` 667 lines, `candleCache.test.ts` 433 lines) — they
  should keep passing unchanged. If they don't, the refactor changed
  behavior.

### 6. Test coverage is inverted — and it is the prerequisite for item 1

**Problem:** only 8 of 47 source files have tests, and the coverage is
concentrated in the small, already-safe modules:

| file | lines | tests |
|---|---|---|
| `engine/step.ts` | 1818 | none |
| `draw/index.ts` | 1036 | none |
| `draw/canvas2d.ts` | 916 | none |
| `Liveline.tsx` | 642 | none |
| `useLivelineEngine.ts` | 589 | none |
| `draw/candlestick.ts` | 671 | yes |
| `engine/helpers.ts` | 253 | **none** |
| `engine/candleHelpers.ts` | 194 | **none** |
| `engine/quiescence.ts` | 87 | **none** |

The three bolded ones matter most: they are **pure functions** with no Skia
dependency, they are the shared logic all three pipelines call, and they are
currently untested. `quiescence.ts` in particular is an 87-line pure
predicate that gates whether the engine skips picture re-recording at all —
a silent regression there is a perf cliff with no visual symptom.

**Plan:**
- Write `engine/__tests__/helpers.test.ts` covering `updateRange`,
  `updateWindowTransition`, `updateHoverState`. Follow the existing style
  in `math/__tests__/math.test.ts` — plain function calls, no worklet
  runtime, no Skia.
- Write `engine/__tests__/quiescence.test.ts` for `isQuiescentCandidate`:
  assert each break condition independently forces `false`, and that the
  all-static case returns `true`.
- Write `engine/__tests__/candleHelpers.test.ts` for `updateCandleRange`,
  `updateCandleWindowTransition`, `candleAtX`.
- **Note what jest cannot reach:** the worklet runtime. See
  `.claude/skills/run-and-profile` — the SharedValue-closure failure
  documented there shipped green tests, clean tsc, clean eslint, and
  passing screenshots, and still failed on the second frame in a real
  launch. Tests are the safety net for *logic*, not for the Reanimated
  boundary. An on-device check is still mandatory after item 1.

### 7. `Liveline.tsx` writes the same pill bar three times

**Problem:** `Liveline.tsx:408-580` — the window-selector pills, the
line/candle mode toggle, and the series-toggle chips are three
near-identical blocks of the same shape: a `<View style={[styles.bar,
{gap, backgroundColor, borderRadius, padding}]}>` wrapping a
`<SlidingIndicator>` (two of the three) and a `.map()` of `<Pressable>`s.
The bar `<View>` opens at `:413`, `:465`, and `:508` with the same four
computed style values each time.

Above them, seven style scalars are recomputed inline on every render:
`activeColor`, `inactiveColor`, `barBg`, `barRadius`, `barPadding`,
`barGap`, `btnRadius` (`:357-368`). The file carries a top-level
`/* eslint-disable react-native/no-inline-styles */` to accommodate this.

**Plan:**
- Extract a `<PillBar>` component (own file, `src/components/PillBar.tsx`
  or similar — there is no components dir yet, so this establishes one)
  taking the bar chrome + children, owning the `SlidingIndicator`.
- Extract `useBarStyle(windowStyle, isDark)` returning the seven scalars
  memoized on its two inputs.
- The three call sites become the three distinct bits: which items, which
  is active, what each renders.
- This should let the file-level eslint-disable narrow or disappear. If it
  can't, say so in the commit message rather than leaving it silently.

**Note:** this is the only item touching rendered UI rather than engine
internals. Screenshot the three control bars in both themes and all three
`windowStyle` values (`default` / `rounded` / `text`) before and after —
the styling branches on all of those.

## Suggested execution order

1. **#6 tests** (helpers, quiescence, candleHelpers) — cheap, no
   behavior change, and the safety net everything else leans on.
2. **#3 map pruning** — small, self-contained, and ships an actual bug fix
   (`seriesAlpha`). Unit-testable immediately after #6 establishes the
   `engine/__tests__` directory.
3. **#2 `makeLayout`** — mechanical, five minutes, removes three-way drift
   risk.
4. **#5 cache key unification** — contained to two modules that both
   already have thorough tests.
5. **#4 options objects** — mostly mechanical but touches many call sites;
   do it in separate commits per function, not one sweep.
6. **#7 `PillBar`** — independent of everything above; can be done at any
   point by someone who'd rather work in the React layer than the engine.
7. **#1 pipeline extraction** — last, with #6 and #2 behind you.

Items #4, #5, and #7 are mutually independent and independent of #1 — they
can be picked up in any order or in parallel by different people. #1 should
not start until #6 is done.

## Rules for whoever picks this up

- **Commit each item separately.** Same rule `PLAN_PERF.md` set, same
  reason: a regression in one should be trivially bisectable. Do not bundle.
- **After every item**, from the repo root (yarn 4 is vendored, there is no
  global yarn):
  ```
  node .yarn/releases/yarn-4.11.0.cjs typecheck
  node .yarn/releases/yarn-4.11.0.cjs lint
  node .yarn/releases/yarn-4.11.0.cjs test
  ```
  plus an iOS sim check via the `run-and-profile` skill for anything
  touching `engine/` or `draw/`.
- **Carry the comments.** This codebase's comment density is an asset, not
  noise. Several comments encode findings that cost real debugging time —
  the SharedValue-closure trap, the measured-and-refuted `for...of`
  pessimization, the `LEFT_EDGE_EPSILON` rationale, the pooled-rect safety
  argument in `canvas2d.ts`. A refactor that drops them is a net loss even
  if the code is shorter. When you move a block, move its comment; when you
  merge two commented blocks, merge the comments.
- **This is a maintainability pass, not a perf pass.** If an item tempts
  you into a perf change, note it and move on — `PLAN_PERF.md` is where
  that conversation lives, and the standing open perf item is "Release
  build on physical Android hardware remains unmeasured," not anything in
  this doc.
- **Do not change public API.** Nothing here should alter `LivelineProps`
  or anything exported from `src/index.tsx`. If an item seems to require
  it, stop and raise it.
