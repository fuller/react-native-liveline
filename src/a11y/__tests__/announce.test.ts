import {
  ANNOUNCE_INTERVAL_MS,
  announceDirection,
  nextAnnouncement,
  resolveLiveValue,
  type Announcement,
} from '../announce';

const fmt = (v: number) => v.toFixed(2);

describe('ANNOUNCE_INTERVAL_MS', () => {
  it('is a human-readable cadence, not a frame cadence', () => {
    expect(ANNOUNCE_INTERVAL_MS).toBeGreaterThanOrEqual(500);
  });
});

describe('resolveLiveValue', () => {
  it('uses the value prop in line mode', () => {
    expect(resolveLiveValue({ value: 12.5 })).toBe(12.5);
    expect(resolveLiveValue({ value: 12.5, mode: 'line' })).toBe(12.5);
  });

  it('prefers the live candle close in candle mode', () => {
    expect(
      resolveLiveValue({
        value: 1,
        mode: 'candle',
        liveCandle: { close: 9 },
        candles: [{ close: 5 }],
      })
    ).toBe(9);
  });

  it('falls back to the last closed candle when there is no live candle', () => {
    expect(
      resolveLiveValue({
        value: 1,
        mode: 'candle',
        candles: [{ close: 5 }, { close: 7 }],
      })
    ).toBe(7);
  });

  it('falls back to the value prop when candle mode has no candles', () => {
    expect(resolveLiveValue({ value: 1, mode: 'candle', candles: [] })).toBe(1);
  });

  it('ignores candles once the chart has morphed to line mode', () => {
    expect(
      resolveLiveValue({
        value: 1,
        mode: 'candle',
        lineMode: true,
        lineValue: 3,
        liveCandle: { close: 9 },
      })
    ).toBe(3);
  });

  it('returns null when no usable number exists', () => {
    expect(resolveLiveValue({})).toBeNull();
    expect(resolveLiveValue({ value: Number.NaN })).toBeNull();
    expect(resolveLiveValue({ value: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe('announceDirection', () => {
  it('reports steady for the first reading', () => {
    expect(announceDirection(null, 5)).toBe('steady');
  });

  it('reports rising, falling and steady', () => {
    expect(announceDirection(4, 5)).toBe('rising');
    expect(announceDirection(6, 5)).toBe('falling');
    expect(announceDirection(5, 5)).toBe('steady');
  });
});

describe('nextAnnouncement', () => {
  it('returns null when there is nothing to read', () => {
    expect(nextAnnouncement(null, null, fmt)).toBeNull();
  });

  it('formats the first reading without a direction', () => {
    expect(nextAnnouncement(null, 1.5, fmt)).toEqual({
      value: 1.5,
      formatted: '1.50',
      text: '1.50',
    });
  });

  it('appends the momentum direction on subsequent readings', () => {
    const first = nextAnnouncement(null, 1.5, fmt)!;
    expect(nextAnnouncement(first, 2, fmt)).toEqual({
      value: 2,
      formatted: '2.00',
      text: '2.00, rising',
    });
    expect(nextAnnouncement(first, 1, fmt)).toEqual({
      value: 1,
      formatted: '1.00',
      text: '1.00, falling',
    });
  });

  it('stays silent when the reading is unchanged', () => {
    const prev: Announcement = { value: 1.5, formatted: '1.50', text: '1.50' };
    expect(nextAnnouncement(prev, 1.5, fmt)).toBeNull();
  });

  it('stays silent on jitter below the formatter precision', () => {
    // The single most important case: a live feed moves constantly, but a
    // reader must not be told "1.50, rising" once a second forever.
    const prev: Announcement = { value: 1.5, formatted: '1.50', text: '1.50' };
    expect(nextAnnouncement(prev, 1.5004, fmt)).toBeNull();
    expect(nextAnnouncement(prev, 1.4999, fmt)).toBeNull();
  });

  it('respects the consumer formatter', () => {
    expect(nextAnnouncement(null, 1234.5, (v) => `$${v.toFixed(0)}`)).toEqual({
      value: 1234.5,
      formatted: '$1235',
      text: '$1235',
    });
  });
});
