import { describe, expect, it } from 'vitest';
import { OneEuroFilter, PoseSmoother } from '../src/core/oneEuro';
import { JitterMeter } from '../src/core/jitter';
import { FIXTURES, rng, toFrame } from './fixtures/skeletons';

const params = () => ({ minCutoff: 1.0, beta: 0.05, dCutoff: 1.0 });

describe('OneEuroFilter', () => {
  it('passes the first sample through unchanged', () => {
    const f = new OneEuroFilter(params());
    expect(f.filter(3.5, 0)).toBe(3.5);
  });

  it('converges to a constant signal', () => {
    const f = new OneEuroFilter(params());
    f.filter(0, 0);
    let y = 0;
    for (let i = 1; i <= 120; i++) y = f.filter(1, i / 30);
    expect(y).toBeCloseTo(1, 3);
  });

  it('reduces noise variance on a static signal', () => {
    const r = rng(42);
    const f = new OneEuroFilter(params());
    let rawVar = 0;
    let filtVar = 0;
    for (let i = 0; i < 600; i++) {
      const x = (r() - 0.5) * 0.02;
      const y = f.filter(x, i / 30);
      if (i > 30) {
        rawVar += x * x;
        filtVar += y * y;
      }
    }
    expect(filtVar).toBeLessThan(rawVar * 0.3);
  });

  it('higher beta = less lag on a fast ramp', () => {
    const lagFor = (beta: number) => {
      const f = new OneEuroFilter({ minCutoff: 1, beta, dCutoff: 1 });
      let y = 0;
      for (let i = 0; i <= 30; i++) y = f.filter(i * 0.1, i / 30); // 3 units/s ramp
      return 3 - y;
    };
    expect(lagFor(1)).toBeLessThan(lagFor(0));
  });

  it('ignores non-increasing timestamps and can be reset', () => {
    const f = new OneEuroFilter(params());
    f.filter(0, 1);
    expect(f.filter(10, 1)).toBe(0);
    f.reset();
    expect(f.filter(10, 2)).toBe(10);
  });
});

describe('PoseSmoother + JitterMeter', () => {
  it('cuts measured jitter of a noisy static skeleton', () => {
    const r = rng(7);
    const smoother = new PoseSmoother(params());
    const joints = [11, 12, 23, 24, 13, 14, 15, 16];
    const raw = new JitterMeter(joints, 0.05);
    const filt = new JitterMeter(joints, 0.05);
    for (let i = 0; i < 300; i++) {
      const noisy = FIXTURES.attention.map((l) => ({
        ...l,
        x: l.x + (r() - 0.5) * 0.01,
        y: l.y + (r() - 0.5) * 0.01,
        z: l.z + (r() - 0.5) * 0.02,
      }));
      const frame = toFrame(noisy, i * 33.3);
      raw.push(frame.world);
      filt.push(smoother.apply(frame).world);
    }
    expect(raw.mean).toBeGreaterThan(5);
    expect(filt.mean).toBeLessThan(raw.mean * 0.5);
  });

  it('live param updates propagate to all joint filters', () => {
    const s = new PoseSmoother(params());
    s.setParams({ minCutoff: 3 });
    expect(s.getParams().minCutoff).toBe(3);
  });

  it('disabled smoother is identity', () => {
    const s = new PoseSmoother(params());
    s.enabled = false;
    const f = toFrame(FIXTURES.nadu, 0);
    expect(s.apply(f)).toBe(f);
  });
});
