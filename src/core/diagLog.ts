/**
 * Fixed-capacity ring buffer of timestamped diagnostic events for the debug
 * panel + clipboard copy. Shared across face/pose paths so a single "Copy logs"
 * button can dump the recent fail path.
 */
export interface DiagEvent {
  /** performance.now() at push time */
  t: number;
  /** Short category, e.g. camera | model | detect | reload | error */
  tag: string;
  msg: string;
  data?: Record<string, unknown>;
}

export class DiagLog {
  private buf: DiagEvent[] = [];
  private write = 0;
  private count = 0;

  constructor(readonly capacity = 250) {
    if (capacity < 1) throw new Error('DiagLog capacity must be >= 1');
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.buf = [];
    this.write = 0;
    this.count = 0;
  }

  push(tag: string, msg: string, data?: Record<string, unknown>): DiagEvent {
    const ev: DiagEvent = {
      t: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      tag,
      msg,
      ...(data ? { data } : {}),
    };
    if (this.buf.length < this.capacity) {
      this.buf.push(ev);
      this.write = this.buf.length % this.capacity;
    } else {
      this.buf[this.write] = ev;
      this.write = (this.write + 1) % this.capacity;
    }
    this.count = Math.min(this.count + 1, this.capacity);
    return ev;
  }

  /** Oldest → newest, optionally truncated to the last `n` events. */
  events(n = this.count): DiagEvent[] {
    const take = Math.min(Math.max(0, n), this.count);
    if (take === 0) return [];
    if (this.buf.length < this.capacity) return this.buf.slice(this.count - take);
    const start = (this.write - take + this.capacity) % this.capacity;
    const out: DiagEvent[] = [];
    for (let i = 0; i < take; i++) out.push(this.buf[(start + i) % this.capacity]!);
    return out;
  }

  formatLine(ev: DiagEvent): string {
    const ms = ev.t.toFixed(0).padStart(7, ' ');
    const data =
      ev.data && Object.keys(ev.data).length
        ? ' ' +
          Object.entries(ev.data)
            .map(([k, v]) => `${k}=${typeof v === 'number' ? (Number.isInteger(v) ? v : (v as number).toFixed(2)) : String(v)}`)
            .join(' ')
        : '';
    return `+${ms}ms [${ev.tag}] ${ev.msg}${data}`;
  }

  lines(n = this.count): string[] {
    return this.events(n).map((e) => this.formatLine(e));
  }

  text(n = this.count): string {
    return this.lines(n).join('\n');
  }
}

/** App-wide diagnostic buffer (face detect fail-path dumps). */
export const diagLog = new DiagLog(300);
