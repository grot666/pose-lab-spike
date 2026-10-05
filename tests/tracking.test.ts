import { describe, expect, it } from 'vitest';
import { TrackingMonitor } from '../src/core/tracking';
import { J, cloneLandmarks } from '../src/core/landmarks';
import { FIXTURES, toFrame } from './fixtures/skeletons';

const opts = { visibilityThreshold: 0.5, coreVisibility: 0.5, lostAfterMs: 400, regainFrames: 3 };

describe('TrackingMonitor', () => {
  it('distinguishes hidden wrists (partial) from full track loss', () => {
    const m = new TrackingMonitor(opts);
    const l = cloneLandmarks(FIXTURES.attention);
    l[J.left_wrist].visibility = 0.1;
    const s = m.update(toFrame(l), 0);
    expect(s.state).toBe('partial');
    expect(s.wristsHidden).toBe(true);
    expect(s.wristHidden).toEqual([true, false]);
    expect(m.stats.lostEvents).toBe(0);
  });

  it('declares loss only after lostAfterMs of no person, then regains after N good frames', () => {
    const m = new TrackingMonitor(opts);
    m.update(toFrame(FIXTURES.attention), 0);
    expect(m.update(null, 100).state).toBe('tracking');
    expect(m.update(null, 300).state).toBe('tracking');
    expect(m.update(null, 500).state).toBe('lost');
    expect(m.stats.lostEvents).toBe(1);
    expect(m.update(toFrame(FIXTURES.attention), 600).state).toBe('lost');
    expect(m.update(toFrame(FIXTURES.attention), 633).state).toBe('lost');
    expect(m.update(toFrame(FIXTURES.attention), 666).state).toBe('tracking');
    expect(m.stats.lostMsTotal).toBe(566); // from first bad frame (100) to regain (666)
  });

  it('core body invisible counts as loss even if a frame exists', () => {
    const m = new TrackingMonitor(opts);
    const l = cloneLandmarks(FIXTURES.attention);
    for (const j of [J.left_shoulder, J.right_shoulder, J.left_hip, J.right_hip]) l[j].visibility = 0.1;
    m.update(toFrame(l), 0);
    expect(m.update(toFrame(l), 500).state).toBe('lost');
  });

  it('brief dropouts shorter than lostAfterMs never register', () => {
    const m = new TrackingMonitor(opts);
    for (let t = 0; t < 3000; t += 33) m.update(t % 330 < 200 ? toFrame(FIXTURES.attention) : null, t);
    expect(m.stats.lostEvents).toBe(0);
  });
});
