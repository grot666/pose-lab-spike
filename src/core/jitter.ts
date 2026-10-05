/**
 * Jitter meter: mean magnitude of the discrete second difference
 * |p[t] - 2p[t-1] + p[t-2]| over visible joints, in millimetres (world space).
 * Second difference suppresses smooth motion and isolates frame-to-frame noise.
 * Exponential moving average for a stable readout.
 */
import type { Landmark } from './landmarks';

export class JitterMeter {
  private prev: Landmark[] | null = null;
  private prev2: Landmark[] | null = null;
  private ema = 0;
  private samples = 0;
  private sum = 0;

  constructor(
    private joints: readonly number[],
    private alpha = 0.1,
    private visThreshold = 0.5,
  ) {}

  reset(): void {
    this.prev = null;
    this.prev2 = null;
  }

  /** Long-run mean since construction / clearStats (mm). */
  get mean(): number {
    return this.samples ? this.sum / this.samples : 0;
  }

  get value(): number {
    return this.ema;
  }

  clearStats(): void {
    this.samples = 0;
    this.sum = 0;
  }

  push(world: readonly Landmark[]): number {
    if (this.prev && this.prev2) {
      let acc = 0;
      let n = 0;
      for (const j of this.joints) {
        const a = world[j];
        const b = this.prev[j];
        const c = this.prev2[j];
        if (a.visibility < this.visThreshold) continue;
        acc += Math.hypot(a.x - 2 * b.x + c.x, a.y - 2 * b.y + c.y, a.z - 2 * b.z + c.z);
        n++;
      }
      if (n) {
        const mm = (acc / n) * 1000;
        this.ema = this.samples === 0 ? mm : this.alpha * mm + (1 - this.alpha) * this.ema;
        this.samples++;
        this.sum += mm;
      }
    }
    this.prev2 = this.prev;
    this.prev = world.map((l) => ({ ...l }));
    return this.ema;
  }
}
