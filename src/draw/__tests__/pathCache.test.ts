import { ensured, type CachePath } from '../pathCache';

class FakePath implements CachePath {
  moveTo() {}
  lineTo() {}
  cubicTo() {}
  arcToTangent() {}
  close() {}
  rewind() {}
  addPath() {}
  offset() {}
}

describe('ensured', () => {
  it('returns the existing path unchanged when non-null', () => {
    const existing = new FakePath();
    const makePath = jest.fn(() => new FakePath());
    expect(ensured(existing, makePath)).toBe(existing);
    expect(makePath).not.toHaveBeenCalled();
  });

  it('calls makePath exactly once when the slot is null', () => {
    const fresh = new FakePath();
    const makePath = jest.fn(() => fresh);
    expect(ensured(null, makePath)).toBe(fresh);
    expect(makePath).toHaveBeenCalledTimes(1);
  });
});
