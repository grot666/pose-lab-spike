/**
 * Track-quality classifier. Separates three situations that must NOT be confused:
 *   tracking  - body (shoulders+hips) visible; all good
 *   partial   - body visible but extremities hidden (wrists and/or lower body).
 *               Rules needing those joints return "unknown"; this is NOT track loss.
 *   lost      - no person, or the core body is not visible, for > lostAfterMs.
 *               The session pauses timers and speaks in-character; no fail/score impact.
 */
import { CORE_JOINTS, LOWER_BODY_JOINTS, WRIST_JOINTS, type PoseFrame } from './landmarks';

export type TrackState = 'idle' | 'tracking' | 'partial' | 'lost';

export interface TrackingOptions {
  visibilityThreshold: number;
  coreVisibility: number;
  lostAfterMs: number;
  regainFrames: number;
}

export interface TrackSnapshot {
  state: TrackState;
  /** Raw per-frame verdict before debouncing. */
  rawPresent: boolean;
  wristsHidden: boolean;
  /** Which wrists are hidden: [left, right]. */
  wristHidden: [boolean, boolean];
  lowerBodyHidden: boolean;
  coreVisibility: number;
}

export interface TrackStats {
  frames: number;
  trackedFrames: number;
  partialFrames: number;
  lostFrames: number;
  wristHiddenFrames: number;
  lostEvents: number;
  lostMsTotal: number;
  /** Current lost streak in ms (0 when tracked). */
  currentLostMs: number;
}

export class TrackingMonitor {
  private state: TrackState = 'idle';
  private badSince: number | null = null;
  private goodRun = 0;
  private lostStartedAt: number | null = null;
  readonly stats: TrackStats = {
    frames: 0,
    trackedFrames: 0,
    partialFrames: 0,
    lostFrames: 0,
    wristHiddenFrames: 0,
    lostEvents: 0,
    lostMsTotal: 0,
    currentLostMs: 0,
  };

  constructor(public opts: TrackingOptions) {}

  get current(): TrackState {
    return this.state;
  }

  resetStats(nowMs: number = performance.now()): void {
    Object.assign(this.stats, {
      frames: 0,
      trackedFrames: 0,
      partialFrames: 0,
      lostFrames: 0,
      wristHiddenFrames: 0,
      lostEvents: 0,
      lostMsTotal: 0,
      currentLostMs: 0,
    });
    if (this.state === 'lost' && this.lostStartedAt !== null) this.lostStartedAt = nowMs;
  }

  /** frame = null when the detector found no person. */
  update(frame: PoseFrame | null, nowMs: number): TrackSnapshot {
    const thr = this.opts.visibilityThreshold;
    let coreVis = 0;
    let wristHidden: [boolean, boolean] = [true, true];
    let lowerHidden = true;
    if (frame) {
      coreVis = CORE_JOINTS.reduce((s, j) => s + frame.image[j].visibility, 0) / CORE_JOINTS.length;
      wristHidden = [frame.image[WRIST_JOINTS[0]].visibility < thr, frame.image[WRIST_JOINTS[1]].visibility < thr];
      lowerHidden = LOWER_BODY_JOINTS.every((j) => frame.image[j].visibility < thr);
    }
    const present = !!frame && coreVis >= this.opts.coreVisibility;
    this.stats.frames++;

    if (present) {
      this.badSince = null;
      this.goodRun++;
      if (this.state === 'idle') {
        this.state = 'tracking';
      } else if (this.state === 'lost' && this.goodRun >= this.opts.regainFrames) {
        if (this.lostStartedAt !== null) this.stats.lostMsTotal += nowMs - this.lostStartedAt;
        this.lostStartedAt = null;
        this.state = 'tracking';
      }
      if (this.state !== 'lost') {
        this.state = wristHidden[0] || wristHidden[1] || lowerHidden ? 'partial' : 'tracking';
      }
    } else {
      this.goodRun = 0;
      if (this.badSince === null) this.badSince = nowMs;
      if (this.state !== 'lost' && nowMs - this.badSince >= this.opts.lostAfterMs) {
        this.state = 'lost';
        this.lostStartedAt = this.badSince;
        this.stats.lostEvents++;
      }
    }

    if (this.state === 'tracking') this.stats.trackedFrames++;
    else if (this.state === 'partial') this.stats.partialFrames++;
    else if (this.state === 'lost') this.stats.lostFrames++;
    if (present && (wristHidden[0] || wristHidden[1])) this.stats.wristHiddenFrames++;
    this.stats.currentLostMs = this.state === 'lost' && this.lostStartedAt !== null ? nowMs - this.lostStartedAt : 0;

    return {
      state: this.state,
      rawPresent: present,
      wristsHidden: present && (wristHidden[0] || wristHidden[1]),
      wristHidden,
      lowerBodyHidden: present && lowerHidden,
      coreVisibility: coreVis,
    };
  }
}
