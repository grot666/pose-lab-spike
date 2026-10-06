import { describe, expect, it } from 'vitest';
import { nextVideoTimestampMs } from '../src/core/videoTimestamp';

describe('nextVideoTimestampMs', () => {
  it('floors fractional performance.now values', () => {
    expect(nextVideoTimestampMs(1000.9, -1)).toBe(1000);
  });

  it('bumps when floored value would reuse lastTs (same wall-clock ms)', () => {
    expect(nextVideoTimestampMs(1000.1, 1000)).toBe(1001);
    expect(nextVideoTimestampMs(1000.9, 1000)).toBe(1001);
  });

  it('advances normally across distinct milliseconds', () => {
    expect(nextVideoTimestampMs(1005.2, 1000)).toBe(1005);
  });

  it('is strictly increasing across a burst inside one ms', () => {
    let last = -1;
    const out: number[] = [];
    for (let i = 0; i < 5; i++) {
      last = nextVideoTimestampMs(50.1 + i * 0.01, last);
      out.push(last);
    }
    expect(out).toEqual([50, 51, 52, 53, 54]);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1]);
  });
});
