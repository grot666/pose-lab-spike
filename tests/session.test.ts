import { describe, expect, it } from 'vitest';
import { PoseSession, type SessionEvent, type SessionOptions } from '../src/core/session';
import type { RuleStatus } from '../src/core/poseRules';
import type { TrackState } from '../src/core/tracking';
import { buildRoundReport, isNumbersOnly } from '../src/core/metrics';

const OPTS: SessionOptions = {
  sequenceMode: 'sequential',
  posesPerRound: 2,
  enterTimeoutMs: 10_000,
  holdMinMs: 5_000,
  holdMaxMs: 5_000,
  personDetectFrames: 3,
  commandAnnounceMs: 1_000,
  resultShowMs: 1_000,
  enterFrames: 10,
  leaveFrames: 15,
};

function harness(opts: Partial<SessionOptions> = {}) {
  const s = new PoseSession(['a', 'b', 'c'], { ...OPTS, ...opts }, () => 0.5);
  const events: SessionEvent[] = [];
  s.on((e) => events.push(e));
  let t = 0;
  const step = (n: number, targetStatus: RuleStatus | null, track: TrackState = 'tracking', dt = 100) => {
    let snap = s.snapshot();
    for (let i = 0; i < n; i++) {
      t += dt;
      snap = s.update({ nowMs: t, track, targetStatus, wristsHidden: false });
    }
    return snap;
  };
  return { s, events, step, types: () => events.map((e) => e.type) };
}

function toEntering(h: ReturnType<typeof harness>) {
  h.s.start();
  h.step(3, null); // person found -> command
  h.step(10, null); // 1s announce -> entering (transition on the 10th frame)
  expect(h.s.currentPhase).toBe('entering');
}

describe('PoseSession', () => {
  it('searching -> command once a person is stable', () => {
    const h = harness();
    h.s.start();
    h.step(2, null, 'lost');
    expect(h.s.currentPhase).toBe('searching');
    h.step(3, null);
    expect(h.s.currentPhase).toBe('command');
    expect(h.s.targetPoseId).toBe('a');
  });

  it('success: enter (10 frames) then hold for the target duration', () => {
    const h = harness();
    toEntering(h);
    h.step(10, 'pass');
    expect(h.s.currentPhase).toBe('holding');
    h.step(50, 'pass');
    expect(h.s.currentPhase).toBe('result');
    expect(h.s.snapshot().lastOutcome).toBe('success');
  });

  it('fail: enter timeout after 10s', () => {
    const h = harness();
    toEntering(h);
    h.step(99, 'fail');
    expect(h.s.currentPhase).toBe('entering');
    h.step(2, 'fail');
    expect(h.s.currentPhase).toBe('result');
    expect(h.s.snapshot().lastFailReason).toBe('enter_timeout');
  });

  it('leave (15 misses) resets hold and returns to entering with a fresh window', () => {
    const h = harness();
    toEntering(h);
    h.step(10, 'pass');
    h.step(20, 'pass'); // 2s held
    h.step(15, 'fail');
    expect(h.s.currentPhase).toBe('entering');
    expect(h.types()).toContain('leave');
    expect(h.s.snapshot().enterRemainingMs).toBe(10_000);
    h.step(10, 'pass');
    expect(h.s.snapshot().holdElapsedMs).toBe(0);
    h.step(50, 'pass');
    expect(h.s.snapshot().lastOutcome).toBe('success');
  });

  it('short misses (<15 frames) during hold do not leave', () => {
    const h = harness({ holdMinMs: 15_000, holdMaxMs: 15_000 });
    toEntering(h);
    h.step(10, 'pass');
    for (let i = 0; i < 4; i++) {
      h.step(8, 'pass');
      h.step(10, 'fail');
    }
    expect(h.s.currentPhase).toBe('holding');
  });

  it('track loss pauses timers, never fails, and is reported separately', () => {
    const h = harness();
    toEntering(h);
    h.step(50, 'fail'); // 5s of 10s used
    h.step(300, null, 'lost'); // 30s lost -> must not time out
    expect(h.s.currentPhase).toBe('entering');
    expect(h.s.snapshot().paused).toBe(true);
    expect(h.s.snapshot().enterRemainingMs).toBe(5_000);
    h.step(1, null, 'tracking');
    expect(h.s.snapshot().paused).toBe(false);
    h.step(10, 'pass');
    h.step(50, 'pass');
    const res = h.events.find((e) => e.type === 'result');
    expect(res && res.type === 'result' && res.outcome).toBe('success');
    expect(h.types()).toContain('track_lost');
    expect(h.types()).toContain('track_regained');
  });

  it('unknown (hidden joints) during hold keeps the hold alive', () => {
    const h = harness();
    toEntering(h);
    h.step(10, 'pass');
    h.step(30, 'unknown');
    expect(h.s.currentPhase).toBe('holding');
  });

  it('completes a round and produces a numbers-only report', () => {
    const h = harness();
    toEntering(h);
    h.step(10, 'pass');
    h.step(50, 'pass'); // success a
    h.step(10, null); // result shown 1s
    h.step(10, null); // announce b
    h.step(101, 'fail'); // timeout b
    h.step(10, null);
    expect(h.s.currentPhase).toBe('report');
    const done = h.events.find((e) => e.type === 'round_complete');
    expect(done?.type).toBe('round_complete');
    if (done?.type !== 'round_complete') return;
    expect(done.summary.attempts.map((a) => a.outcome)).toEqual(['success', 'fail']);
    const report = buildRoundReport(done.summary, {
      fpsMean: 30,
      inferMsMean: 12,
      inferMsP95: 20,
      modelTier: 1,
      gpu: 1,
      jitterRawMm: 8,
      jitterFilteredMm: 3,
      minCutoff: 1,
      beta: 0.05,
      dCutoff: 1,
      enterFrames: 10,
      leaveFrames: 15,
      trackLostEvents: 0,
      trackLostMs: 0,
      trackedRatio: 1,
      wristHiddenRatio: 0,
    });
    expect(isNumbersOnly(report)).toBe(true);
    expect(report.success).toBe(1);
    expect(report.fail).toBe(1);
    expect(report.attempts[0].enterLatencyMs).toBe(1000);
  });

  it('random mode covers every pose once per bag', () => {
    let seed = 1;
    const s = new PoseSession(['a', 'b', 'c', 'd'], { ...OPTS, sequenceMode: 'random', posesPerRound: 0 }, () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    });
    const seen: string[] = [];
    s.on((e) => e.type === 'command' && seen.push(e.poseId));
    s.start();
    let t = 0;
    for (let i = 0; i < 2000 && s.currentPhase !== 'report'; i++) {
      t += 100;
      s.update({ nowMs: t, track: 'tracking', targetStatus: 'fail', wristsHidden: false });
    }
    expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('hold duration is drawn within the configured range', () => {
    const s = new PoseSession(['a'], { ...OPTS, holdMinMs: 5000, holdMaxMs: 15000 }, () => 0.999);
    let hold = 0;
    s.on((e) => e.type === 'command' && (hold = e.holdTargetMs));
    s.start();
    for (let i = 1; i <= 5; i++) s.update({ nowMs: i * 100, track: 'tracking', targetStatus: null, wristsHidden: false });
    expect(hold).toBeGreaterThanOrEqual(5000);
    expect(hold).toBeLessThanOrEqual(15000);
  });

  it('stop() is final', () => {
    const h = harness();
    toEntering(h);
    h.s.stop();
    h.s.start();
    expect(h.s.currentPhase).toBe('stopped');
  });
});
