/**
 * Face presence tracker for expression mode.
 * Maps detector presence -> TrackState used by PoseSession (tracking | lost).
 */
import type { TrackState } from './tracking';

export interface FaceTrackOptions {
  lostAfterMs: number;
  regainFrames: number;
}

export interface FaceTrackSnapshot {
  state: TrackState;
  present: boolean;
}

export interface FaceTrackStats {
  frames: number;
  trackedFrames: number;
  lostFrames: number;
  lostEvents: number;
  lostMsTotal: number;
  currentLostMs: number;
}

export class FaceTrackingMonitor {
  private state: TrackState = 'idle';
  private badSince: number | null = null;
  private goodRun = 0;
  private lostStartedAt: number | null = null;
  readonly stats: FaceTrackStats = {
    frames: 0,
    trackedFrames: 0,
    lostFrames: 0,
    lostEvents: 0,
    lostMsTotal: 0,
    currentLostMs: 0,
  };

  constructor(public opts: FaceTrackOptions) {}

  resetStats(nowMs: number = performance.now()): void {
    Object.assign(this.stats, {
      frames: 0,
      trackedFrames: 0,
      lostFrames: 0,
      lostEvents: 0,
      lostMsTotal: 0,
      currentLostMs: 0,
    });
    if (this.state === 'lost' && this.lostStartedAt !== null) this.lostStartedAt = nowMs;
  }

  update(present: boolean, nowMs: number): FaceTrackSnapshot {
    this.stats.frames++;
    if (present) {
      this.goodRun++;
      this.badSince = null;
      if (this.state === 'lost' || this.state === 'idle') {
        if (this.goodRun >= this.opts.regainFrames) {
          if (this.state === 'lost' && this.lostStartedAt !== null) {
            this.stats.lostMsTotal += nowMs - this.lostStartedAt;
            this.lostStartedAt = null;
          }
          this.state = 'tracking';
          this.stats.currentLostMs = 0;
        }
      } else {
        this.state = 'tracking';
        this.stats.currentLostMs = 0;
      }
    } else {
      this.goodRun = 0;
      if (this.badSince === null) this.badSince = nowMs;
      const lostFor = nowMs - this.badSince;
      if (this.state !== 'lost' && lostFor >= this.opts.lostAfterMs) {
        this.state = 'lost';
        this.lostStartedAt = nowMs;
        this.stats.lostEvents++;
      }
      if (this.state === 'lost' && this.lostStartedAt !== null) {
        this.stats.currentLostMs = nowMs - this.lostStartedAt;
      }
    }
    if (this.state === 'tracking') this.stats.trackedFrames++;
    else if (this.state === 'lost') this.stats.lostFrames++;
    return { state: this.state === 'idle' ? (present ? 'tracking' : 'lost') : this.state, present };
  }
}
