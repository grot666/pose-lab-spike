/**
 * Test-loop state machine (pure logic, injectable clock + RNG => unit-testable).
 *
 *  idle -> searching -(person stable)-> command -> entering -(debounced enter)-> holding
 *                                         ^           |  (enter timeout => fail)    |  (hold done => success)
 *                                         |           v                             |  (debounced leave => back to entering, timer reset)
 *                                         +------- result <-------------------------+
 *                                    (after last pose) -> report
 *  any -> stopped (safeword)
 *
 * Track loss (TrackState 'lost') while command/entering/holding PAUSES all
 * timers and freezes the debouncer: it never counts as leave/fail and is
 * reported separately (trackLosses / trackLossMs).
 */
import { EnterLeaveDebouncer } from './debounce';
import type { RuleStatus } from './poseRules';
import type { TrackState } from './tracking';

export type SessionPhase = 'idle' | 'searching' | 'command' | 'entering' | 'holding' | 'result' | 'report' | 'stopped';
export type Outcome = 'success' | 'fail';
/** Numeric codes so console metrics stay numbers-only. */
export const OUTCOME_CODE: Record<Outcome, number> = { fail: 0, success: 1 };
export const FAIL_REASON_CODE = { none: 0, enter_timeout: 1 } as const;
export type FailReason = keyof typeof FAIL_REASON_CODE;

export interface SessionOptions {
  sequenceMode: 'random' | 'sequential';
  posesPerRound: number;
  enterTimeoutMs: number;
  holdMinMs: number;
  holdMaxMs: number;
  personDetectFrames: number;
  commandAnnounceMs: number;
  resultShowMs: number;
  enterFrames: number;
  leaveFrames: number;
}

export interface SessionInput {
  nowMs: number;
  track: TrackState;
  /** Evaluation status of the CURRENT target pose (null when there is no target). */
  targetStatus: RuleStatus | null;
  wristsHidden: boolean;
}

export interface AttemptRecord {
  poseIndex: number;
  poseId: string;
  outcome: Outcome;
  failReason: FailReason;
  /** Active (non-paused) ms from enter-phase start to first debounced enter; -1 if never entered. */
  enterLatencyMs: number;
  holdTargetMs: number;
  /** Longest continuous debounced hold achieved. */
  holdAchievedMs: number;
  leaves: number;
  trackLosses: number;
  trackLossMs: number;
  matchFrames: number;
  missFrames: number;
  unknownFrames: number;
  wristHiddenFrames: number;
  frames: number;
}

export interface RoundSummary {
  round: number;
  durationMs: number;
  attempts: AttemptRecord[];
}

export interface SessionSnapshot {
  phase: SessionPhase;
  round: number;
  poseId: string | null;
  poseIndex: number;
  /** 0-based position within the round and total commands. */
  step: number;
  total: number;
  paused: boolean;
  enterRemainingMs: number;
  holdElapsedMs: number;
  holdTargetMs: number;
  debounceIn: boolean;
  debounceProgress: number;
  lastOutcome: Outcome | null;
  lastFailReason: FailReason;
  leavesThisAttempt: number;
  personFrames: number;
}

export type SessionEvent =
  | { type: 'phase'; phase: SessionPhase }
  | { type: 'person_found' }
  | { type: 'command'; poseId: string; step: number; total: number; holdTargetMs: number }
  | { type: 'enter'; poseId: string }
  | { type: 'leave'; poseId: string; leaves: number }
  | { type: 'result'; poseId: string; outcome: Outcome; reason: FailReason }
  | { type: 'track_lost' }
  | { type: 'track_regained' }
  | { type: 'round_complete'; summary: RoundSummary };

/** Largest time step the session accepts per update (ms). */
export const MAX_DT_MS = 500;

export type SessionListener = (e: SessionEvent) => void;

export class PoseSession {
  private phase: SessionPhase = 'idle';
  private poseIds: string[] = [];
  private queue: number[] = [];
  private step = 0;
  private round = 0;
  private roundStartedAt = 0;
  private lastNow: number | null = null;
  /** Active (non-paused) time in the current phase. */
  private phaseMs = 0;
  private holdMs = 0;
  private holdTargetMs = 0;
  private paused = false;
  private pausedAt = 0;
  private personFrames = 0;
  private attempt: AttemptRecord | null = null;
  private attempts: AttemptRecord[] = [];
  private enterActiveMs = 0;
  private lastOutcome: Outcome | null = null;
  private lastFailReason: FailReason = 'none';
  private listeners = new Set<SessionListener>();
  readonly debouncer: EnterLeaveDebouncer;

  constructor(
    poseIds: string[],
    public opts: SessionOptions,
    private random: () => number = Math.random,
  ) {
    this.poseIds = [...poseIds];
    this.debouncer = new EnterLeaveDebouncer(opts.enterFrames, opts.leaveFrames);
  }

  on(fn: SessionListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: SessionEvent): void {
    this.listeners.forEach((l) => l(e));
  }

  private setPhase(p: SessionPhase): void {
    this.phase = p;
    this.phaseMs = 0;
    this.emit({ type: 'phase', phase: p });
  }

  /** Hot-reload of poses.yaml: keep running, new ids apply from the next round. */
  setPoseIds(ids: string[]): void {
    this.poseIds = [...ids];
  }

  setDebounceFrames(enter: number, leave: number): void {
    this.opts.enterFrames = enter;
    this.opts.leaveFrames = leave;
    this.debouncer.setFrames(enter, leave);
  }

  get currentPhase(): SessionPhase {
    return this.phase;
  }

  get targetPoseId(): string | null {
    if (this.phase === 'command' || this.phase === 'entering' || this.phase === 'holding' || this.phase === 'result') {
      return this.poseIds[this.queue[this.step]] ?? null;
    }
    return null;
  }

  /** Begin: wait for a person in front of the camera. */
  start(): void {
    if (this.phase === 'stopped') return;
    this.personFrames = 0;
    this.lastNow = null;
    this.setPhase('searching');
  }

  /** From the report screen: run another round (person is presumably still there). */
  nextRound(): void {
    if (this.phase === 'stopped') return;
    this.start();
  }

  /** Safeword / teardown. Final. */
  stop(): void {
    this.paused = false;
    this.setPhase('stopped');
  }

  private buildQueue(): number[] {
    const n = this.poseIds.length;
    const count = this.opts.posesPerRound > 0 ? this.opts.posesPerRound : n;
    const out: number[] = [];
    if (this.opts.sequenceMode === 'sequential') {
      for (let i = 0; i < count; i++) out.push(i % n);
      return out;
    }
    // random without repetition until the bag is exhausted; avoid back-to-back duplicates across bags
    let bag: number[] = [];
    while (out.length < count) {
      if (!bag.length) {
        bag = Array.from({ length: n }, (_, i) => i);
        for (let i = n - 1; i > 0; i--) {
          const j = Math.floor(this.random() * (i + 1));
          [bag[i], bag[j]] = [bag[j], bag[i]];
        }
        if (n > 1 && out.length && bag[0] === out[out.length - 1]) bag.push(bag.shift()!);
      }
      out.push(bag.shift()!);
    }
    return out;
  }

  private drawHold(): number {
    const { holdMinMs: a, holdMaxMs: b } = this.opts;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return Math.round((lo + this.random() * (hi - lo)) / 100) * 100;
  }

  private beginRound(now: number): void {
    this.round++;
    this.queue = this.buildQueue();
    this.step = 0;
    this.attempts = [];
    this.roundStartedAt = now;
    this.beginCommand();
  }

  private beginCommand(): void {
    const poseIndex = this.queue[this.step];
    this.holdTargetMs = this.drawHold();
    this.holdMs = 0;
    this.enterActiveMs = 0;
    this.debouncer.reset(false);
    this.attempt = {
      poseIndex,
      poseId: this.poseIds[poseIndex],
      outcome: 'fail',
      failReason: 'none',
      enterLatencyMs: -1,
      holdTargetMs: this.holdTargetMs,
      holdAchievedMs: 0,
      leaves: 0,
      trackLosses: 0,
      trackLossMs: 0,
      matchFrames: 0,
      missFrames: 0,
      unknownFrames: 0,
      wristHiddenFrames: 0,
      frames: 0,
    };
    this.setPhase('command');
    this.emit({
      type: 'command',
      poseId: this.poseIds[poseIndex],
      step: this.step,
      total: this.queue.length,
      holdTargetMs: this.holdTargetMs,
    });
  }

  private finishAttempt(outcome: Outcome, reason: FailReason): void {
    const a = this.attempt!;
    a.outcome = outcome;
    a.failReason = reason;
    this.attempts.push(a);
    this.lastOutcome = outcome;
    this.lastFailReason = reason;
    this.setPhase('result');
    this.emit({ type: 'result', poseId: a.poseId, outcome, reason });
  }

  update(input: SessionInput): SessionSnapshot {
    const now = input.nowMs;
    // Clamp: a backgrounded tab / stalled frame must not jump timers forward.
    const dt = this.lastNow === null ? 0 : Math.min(MAX_DT_MS, Math.max(0, now - this.lastNow));
    this.lastNow = now;
    const tracked = input.track === 'tracking' || input.track === 'partial';
    const inRound = this.phase === 'command' || this.phase === 'entering' || this.phase === 'holding';

    // ---- track loss handling: pause, never fail -------------------------------------------
    if (inRound) {
      const lost = input.track === 'lost';
      if (lost && !this.paused) {
        this.paused = true;
        this.pausedAt = now;
        this.attempt!.trackLosses++;
        this.emit({ type: 'track_lost' });
      } else if (!lost && this.paused) {
        this.paused = false;
        this.attempt!.trackLossMs += now - this.pausedAt;
        this.emit({ type: 'track_regained' });
      }
    } else if (this.paused) {
      this.paused = false;
    }

    const activeDt = this.paused ? 0 : dt;
    this.phaseMs += activeDt;

    switch (this.phase) {
      case 'searching': {
        this.personFrames = tracked ? this.personFrames + 1 : 0;
        if (this.personFrames >= this.opts.personDetectFrames) {
          this.emit({ type: 'person_found' });
          this.beginRound(now);
        }
        break;
      }
      case 'command': {
        if (this.phaseMs >= this.opts.commandAnnounceMs) this.setPhase('entering');
        break;
      }
      case 'entering':
      case 'holding': {
        if (this.paused) break;
        const a = this.attempt!;
        a.frames++;
        if (input.wristsHidden) a.wristHiddenFrames++;
        const st = input.targetStatus;
        if (st === 'pass') a.matchFrames++;
        else if (st === 'fail') a.missFrames++;
        else a.unknownFrames++;
        const ev = this.debouncer.update(st === 'pass' ? true : st === 'fail' ? false : null);

        if (this.phase === 'entering') {
          this.enterActiveMs += activeDt;
          if (ev === 'enter') {
            if (a.enterLatencyMs < 0) a.enterLatencyMs = Math.round(this.enterActiveMs);
            this.holdMs = 0;
            this.setPhase('holding');
            this.emit({ type: 'enter', poseId: a.poseId });
          } else if (this.phaseMs >= this.opts.enterTimeoutMs) {
            this.finishAttempt('fail', 'enter_timeout');
          }
        } else {
          if (ev === 'leave') {
            a.leaves++;
            a.holdAchievedMs = Math.max(a.holdAchievedMs, Math.round(this.holdMs));
            this.holdMs = 0;
            this.setPhase('entering'); // leave => reset: fresh enter window, hold restarts from 0
            this.emit({ type: 'leave', poseId: a.poseId, leaves: a.leaves });
          } else {
            this.holdMs += activeDt;
            a.holdAchievedMs = Math.max(a.holdAchievedMs, Math.round(this.holdMs));
            if (this.holdMs >= this.holdTargetMs) {
              a.holdAchievedMs = this.holdTargetMs;
              this.finishAttempt('success', 'none');
            }
          }
        }
        break;
      }
      case 'result': {
        if (this.phaseMs >= this.opts.resultShowMs) {
          this.step++;
          if (this.step >= this.queue.length) {
            const summary: RoundSummary = {
              round: this.round,
              durationMs: Math.round(now - this.roundStartedAt),
              attempts: [...this.attempts],
            };
            this.setPhase('report');
            this.emit({ type: 'round_complete', summary });
          } else {
            this.beginCommand();
          }
        }
        break;
      }
      default:
        break;
    }
    return this.snapshot();
  }

  snapshot(): SessionSnapshot {
    const poseIndex = this.queue[this.step] ?? -1;
    return {
      phase: this.phase,
      round: this.round,
      poseId: this.targetPoseId,
      poseIndex,
      step: this.step,
      total: this.queue.length,
      paused: this.paused,
      enterRemainingMs: this.phase === 'entering' ? Math.max(0, this.opts.enterTimeoutMs - this.phaseMs) : 0,
      holdElapsedMs: this.holdMs,
      holdTargetMs: this.holdTargetMs,
      debounceIn: this.debouncer.isIn,
      debounceProgress: this.debouncer.progress,
      lastOutcome: this.lastOutcome,
      lastFailReason: this.lastFailReason,
      leavesThisAttempt: this.attempt?.leaves ?? 0,
      personFrames: this.personFrames,
    };
  }
}
