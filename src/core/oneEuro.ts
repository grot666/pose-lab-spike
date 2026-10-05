/**
 * One Euro Filter (Casiez, Roussel, Vogel - CHI 2012).
 * Low jitter at low speed (minCutoff), low lag at high speed (beta).
 * Timestamps are in SECONDS.
 */
import { JOINT_COUNT, type Landmark, type PoseFrame } from './landmarks';

export interface OneEuroParams {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}

function smoothingFactor(dt: number, cutoff: number): number {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
}

export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(public params: OneEuroParams) {}

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }

  filter(x: number, tSec: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = tSec;
      this.dxPrev = 0;
      return x;
    }
    const dt = tSec - this.tPrev;
    if (!(dt > 0)) return this.xPrev; // duplicate / out-of-order timestamp
    const { minCutoff, beta, dCutoff } = this.params;
    const dx = (x - this.xPrev) / dt;
    const aD = smoothingFactor(dt, dCutoff);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = minCutoff + beta * Math.abs(dxHat);
    const a = smoothingFactor(dt, cutoff);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = tSec;
    return xHat;
  }
}

/** Filters a whole PoseFrame: 33 joints x (x,y,z) for both image and world spaces. */
export class PoseSmoother {
  private image: OneEuroFilter[];
  private world: OneEuroFilter[];
  enabled = true;

  constructor(private params: OneEuroParams) {
    const make = () => Array.from({ length: JOINT_COUNT * 3 }, () => new OneEuroFilter(this.params));
    this.image = make();
    this.world = make();
  }

  /** Live-update parameters (sliders). Filters share the same params object. */
  setParams(p: Partial<OneEuroParams>): void {
    Object.assign(this.params, p);
  }

  getParams(): OneEuroParams {
    return { ...this.params };
  }

  /** Call on track loss so re-acquisition does not smear from a stale pose. */
  reset(): void {
    this.image.forEach((f) => f.reset());
    this.world.forEach((f) => f.reset());
  }

  private run(filters: OneEuroFilter[], lms: Landmark[], t: number): Landmark[] {
    return lms.map((l, i) => ({
      x: filters[i * 3].filter(l.x, t),
      y: filters[i * 3 + 1].filter(l.y, t),
      z: filters[i * 3 + 2].filter(l.z, t),
      visibility: l.visibility,
    }));
  }

  apply(frame: PoseFrame): PoseFrame {
    if (!this.enabled) return frame;
    const t = frame.timestampMs / 1000;
    return { timestampMs: frame.timestampMs, image: this.run(this.image, frame.image, t), world: this.run(this.world, frame.world, t) };
  }
}
