/**
 * Performance meters + numbers-only round report builder.
 * The JSON written to the console contains numeric VALUES only (no copy,
 * no pose names): poses are referenced by index in poses.yaml, outcomes
 * and tiers by numeric codes (see README "Metrics JSON").
 */
import { FAIL_REASON_CODE, OUTCOME_CODE, type RoundSummary } from './session';

export class RollingStat {
  private buf: number[] = [];
  constructor(private size = 300) {}
  push(v: number): void {
    if (!Number.isFinite(v)) return;
    this.buf.push(v);
    if (this.buf.length > this.size) this.buf.shift();
  }
  clear(): void {
    this.buf = [];
  }
  get count(): number {
    return this.buf.length;
  }
  get mean(): number {
    return this.buf.length ? this.buf.reduce((a, b) => a + b, 0) / this.buf.length : 0;
  }
  get last(): number {
    return this.buf.length ? this.buf[this.buf.length - 1] : 0;
  }
  percentile(p: number): number {
    if (!this.buf.length) return 0;
    const s = [...this.buf].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
    return s[idx];
  }
}

/** FPS from frame timestamps (EMA of instantaneous rate). */
export class FpsMeter {
  private last: number | null = null;
  private ema = 0;
  readonly stat = new RollingStat(600);
  tick(nowMs: number): number {
    if (this.last !== null) {
      const dt = nowMs - this.last;
      if (dt > 0) {
        const fps = 1000 / dt;
        this.ema = this.ema === 0 ? fps : 0.1 * fps + 0.9 * this.ema;
        this.stat.push(fps);
      }
    }
    this.last = nowMs;
    return this.ema;
  }
  get fps(): number {
    return this.ema;
  }
  reset(): void {
    this.last = null;
    this.ema = 0;
    this.stat.clear();
  }
}

export interface PerfContext {
  fpsMean: number;
  inferMsMean: number;
  inferMsP95: number;
  /** 0 lite, 1 full, 2 heavy */
  modelTier: number;
  /** 1 GPU, 0 CPU */
  gpu: number;
  jitterRawMm: number;
  jitterFilteredMm: number;
  minCutoff: number;
  beta: number;
  dCutoff: number;
  enterFrames: number;
  leaveFrames: number;
  trackLostEvents: number;
  trackLostMs: number;
  trackedRatio: number;
  wristHiddenRatio: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function buildRoundReport(summary: RoundSummary, perf: PerfContext) {
  const a = summary.attempts;
  const success = a.filter((x) => x.outcome === 'success').length;
  const entered = a.filter((x) => x.enterLatencyMs >= 0);
  return {
    v: 1,
    round: summary.round,
    durationMs: summary.durationMs,
    commands: a.length,
    success,
    fail: a.length - success,
    successRate: a.length ? r3(success / a.length) : 0,
    leaves: a.reduce((s, x) => s + x.leaves, 0),
    trackLosses: a.reduce((s, x) => s + x.trackLosses, 0),
    trackLossMs: Math.round(a.reduce((s, x) => s + x.trackLossMs, 0)),
    meanEnterLatencyMs: entered.length ? Math.round(entered.reduce((s, x) => s + x.enterLatencyMs, 0) / entered.length) : -1,
    meanHoldRatio: a.length ? r3(a.reduce((s, x) => s + x.holdAchievedMs / x.holdTargetMs, 0) / a.length) : 0,
    perf: {
      fpsMean: r1(perf.fpsMean),
      inferMsMean: r1(perf.inferMsMean),
      inferMsP95: r1(perf.inferMsP95),
      modelTier: perf.modelTier,
      gpu: perf.gpu,
      jitterRawMm: r1(perf.jitterRawMm),
      jitterFilteredMm: r1(perf.jitterFilteredMm),
      trackLostEvents: perf.trackLostEvents,
      trackLostMs: Math.round(perf.trackLostMs),
      trackedRatio: r3(perf.trackedRatio),
      wristHiddenRatio: r3(perf.wristHiddenRatio),
    },
    params: {
      minCutoff: perf.minCutoff,
      beta: perf.beta,
      dCutoff: perf.dCutoff,
      enterFrames: perf.enterFrames,
      leaveFrames: perf.leaveFrames,
    },
    attempts: a.map((x) => ({
      pose: x.poseIndex,
      outcome: OUTCOME_CODE[x.outcome],
      failReason: FAIL_REASON_CODE[x.failReason],
      enterLatencyMs: x.enterLatencyMs,
      holdTargetMs: x.holdTargetMs,
      holdAchievedMs: x.holdAchievedMs,
      leaves: x.leaves,
      trackLosses: x.trackLosses,
      trackLossMs: Math.round(x.trackLossMs),
      matchRatio: x.frames ? r3(x.matchFrames / x.frames) : 0,
      unknownRatio: x.frames ? r3(x.unknownFrames / x.frames) : 0,
      wristHiddenRatio: x.frames ? r3(x.wristHiddenFrames / x.frames) : 0,
      frames: x.frames,
    })),
  };
}

export type RoundReport = ReturnType<typeof buildRoundReport>;

/** Recursively assert the report contains only numbers (guards the "numbers only" contract). */
export function isNumbersOnly(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isNumbersOnly);
  if (typeof v === 'object' && v !== null) return Object.values(v).every(isNumbersOnly);
  return false;
}
