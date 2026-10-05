import { describe, expect, it } from 'vitest';
import { EnterLeaveDebouncer } from '../src/core/debounce';

const feed = (d: EnterLeaveDebouncer, v: boolean | null, n: number) => {
  const events: string[] = [];
  for (let i = 0; i < n; i++) {
    const e = d.update(v);
    if (e) events.push(e);
  }
  return events;
};

describe('EnterLeaveDebouncer (N=10 enter, M=15 leave)', () => {
  it('enters only after 10 consecutive matches', () => {
    const d = new EnterLeaveDebouncer(10, 15);
    expect(feed(d, true, 9)).toEqual([]);
    expect(d.isIn).toBe(false);
    expect(feed(d, true, 1)).toEqual(['enter']);
    expect(d.isIn).toBe(true);
  });

  it('a single miss resets the enter run', () => {
    const d = new EnterLeaveDebouncer(10, 15);
    feed(d, true, 9);
    d.update(false);
    expect(feed(d, true, 9)).toEqual([]);
    expect(feed(d, true, 1)).toEqual(['enter']);
  });

  it('leaves only after 15 consecutive misses; matches in between reset', () => {
    const d = new EnterLeaveDebouncer(10, 15);
    feed(d, true, 10);
    expect(feed(d, false, 14)).toEqual([]);
    d.update(true);
    expect(feed(d, false, 14)).toEqual([]);
    expect(feed(d, false, 1)).toEqual(['leave']);
    expect(d.isIn).toBe(false);
  });

  it('null (unknown) samples freeze the counters', () => {
    const d = new EnterLeaveDebouncer(10, 15);
    feed(d, true, 5);
    feed(d, null, 100);
    expect(d.counters.match).toBe(5);
    expect(feed(d, true, 5)).toEqual(['enter']);
    feed(d, false, 10);
    feed(d, null, 100);
    expect(d.isIn).toBe(true);
    expect(feed(d, false, 5)).toEqual(['leave']);
  });

  it('frame counts are adjustable at runtime and progress is reported', () => {
    const d = new EnterLeaveDebouncer(10, 15);
    d.setFrames(3, 2);
    feed(d, true, 2);
    expect(d.progress).toBeCloseTo(2 / 3);
    expect(feed(d, true, 1)).toEqual(['enter']);
    expect(feed(d, false, 2)).toEqual(['leave']);
  });
});
