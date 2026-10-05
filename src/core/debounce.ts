/**
 * Enter/leave hysteresis debouncer.
 *  - state flips OUT -> IN after `enterFrames` consecutive matching frames (default N=10)
 *  - state flips IN -> OUT after `leaveFrames` consecutive non-matching frames (default M=15)
 *  - `null` samples (unknown: joints not visible / tracking paused) freeze both counters
 */
export type DebounceEvent = 'enter' | 'leave' | null;

export class EnterLeaveDebouncer {
  private inside = false;
  private matchRun = 0;
  private missRun = 0;

  constructor(
    public enterFrames = 10,
    public leaveFrames = 15,
  ) {}

  get isIn(): boolean {
    return this.inside;
  }

  /** Progress toward the next transition, 0..1 (for UI). */
  get progress(): number {
    return this.inside ? this.missRun / this.leaveFrames : this.matchRun / this.enterFrames;
  }

  get counters(): { match: number; miss: number } {
    return { match: this.matchRun, miss: this.missRun };
  }

  setFrames(enterFrames: number, leaveFrames: number): void {
    this.enterFrames = Math.max(1, Math.round(enterFrames));
    this.leaveFrames = Math.max(1, Math.round(leaveFrames));
  }

  reset(inside = false): void {
    this.inside = inside;
    this.matchRun = 0;
    this.missRun = 0;
  }

  update(sample: boolean | null): DebounceEvent {
    if (sample === null) return null;
    if (sample) {
      this.matchRun++;
      this.missRun = 0;
      if (!this.inside && this.matchRun >= this.enterFrames) {
        this.inside = true;
        return 'enter';
      }
    } else {
      this.missRun++;
      this.matchRun = 0;
      if (this.inside && this.missRun >= this.leaveFrames) {
        this.inside = false;
        return 'leave';
      }
    }
    return null;
  }
}
