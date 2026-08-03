// `EngineState` pulls in the draw layer, which imports Skia's ESM build —
// untransformed by the react-native jest preset. None of it is exercised by
// state construction (the Skia handles are all created lazily at draw time),
// so a bare stub is enough to get the real `createEngineState` under test.
jest.mock('@shopify/react-native-skia', () => ({
  Skia: new Proxy({}, { get: () => () => ({}) }) as unknown as Record<
    string,
    unknown
  >,
  BlendMode: {},
  ClipOp: {},
  PaintStyle: {},
  StrokeCap: {},
  StrokeJoin: {},
  TileMode: {},
  FilterMode: {},
  MipmapMode: {},
  FontSlant: {},
  PathOp: {},
}));

import {
  createEngineState,
  perSeriesMaps,
  pruneByIds,
  type EngineState,
} from '../state';

/**
 * Per-series maps on `EngineState` are keyed by series id, and a chart whose
 * series set churns must not accumulate entries for ids that no longer
 * exist. This used to be four hand-written delete loops in `engineStep`, and
 * `seriesAlpha` — same lifecycle, same keys — was simply never added to them,
 * so it grew without bound for the life of the chart.
 *
 * These tests pin the registration itself (`perSeriesMaps`) rather than the
 * call site, because the bug was a missing registration, not a broken loop.
 */
function populate(s: EngineState, ids: string[]): void {
  for (const id of ids) {
    s.displayValues.set(id, 1);
    s.seriesAlpha.set(id, 1);
    s.multiVisibleScratch.set(id, []);
    // Shape-irrelevant here — pruning only ever looks at keys.
    s.multiSeriesEntryScratch.set(
      id,
      {} as ReturnType<EngineState['multiSeriesEntryScratch']['get']> & object
    );
    s.lineCaches.set(
      id,
      {} as ReturnType<EngineState['lineCaches']['get']> & object
    );
  }
}

describe('per-series map pruning', () => {
  it('drops dead ids from every registered map', () => {
    const s = createEngineState(0, 60, false, 8);
    populate(s, ['a', 'b', 'c']);
    for (const map of perSeriesMaps(s)) expect(map.size).toBe(3);

    pruneByIds(new Set(['a']), perSeriesMaps(s));

    for (const map of perSeriesMaps(s)) {
      expect(map.size).toBe(1);
      expect([...map.keys()]).toEqual(['a']);
    }
  });

  it('registers seriesAlpha — the map that leaked', () => {
    const s = createEngineState(0, 60, false, 8);
    populate(s, ['a', 'b']);

    pruneByIds(new Set(['b']), perSeriesMaps(s));

    // Guard against a future map being added to EngineState and silently
    // left out of the array, which is exactly how seriesAlpha leaked.
    expect(perSeriesMaps(s)).toContain(s.seriesAlpha);
    expect(s.seriesAlpha.has('a')).toBe(false);
    expect(s.seriesAlpha.get('b')).toBe(1);
  });

  it('keeps ids that are still live and is a no-op when nothing died', () => {
    const s = createEngineState(0, 60, false, 8);
    populate(s, ['a', 'b']);

    pruneByIds(new Set(['a', 'b', 'unseen']), perSeriesMaps(s));

    for (const map of perSeriesMaps(s)) expect(map.size).toBe(2);
  });

  it('leaves the per-frame scratch map out of the pruned set', () => {
    // smoothValuesScratch is .clear()-ed every multi frame, so pruning it
    // here would be redundant; assert the registration reflects that rather
    // than someone adding it later on a hunch.
    const s = createEngineState(0, 60, false, 8);
    expect(perSeriesMaps(s)).not.toContain(s.smoothValuesScratch);
    expect(perSeriesMaps(s)).not.toContain(s.lastMultiStashData);
    expect(perSeriesMaps(s)).not.toContain(s.lastMultiStashRevs);
  });
});
