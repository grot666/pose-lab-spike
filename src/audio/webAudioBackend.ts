/**
 * Web Audio implementation of {@link AudioBackend}.
 * master gain -> destination, with one bus gain per {@link AudioBus}.
 * Buffers are fetched same-origin (CSP connect-src 'self') and decoded once;
 * looping via AudioBufferSourceNode is sample-accurate (no gap, unlike <audio loop>).
 */
import type { AudioBackend, AudioBus, AudioVoice, StartOptions } from './audioBank';

type Ctor = typeof AudioContext;

export class WebAudioBackend implements AudioBackend {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses = new Map<AudioBus, GainNode>();
  private masterGain = 1;
  private closed = false;
  private readonly Ctx: Ctor | undefined;

  constructor(
    /** Maps a cue src (relative to BASE_URL) to a fetchable URL. */
    private readonly resolve: (src: string) => string,
    private readonly busGain: Record<AudioBus, number>,
  ) {
    const w = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
    this.Ctx = w.AudioContext ?? w.webkitAudioContext;
  }

  get unlocked(): boolean {
    return this.ctx?.state === 'running';
  }

  get state(): string {
    if (!this.Ctx) return 'unsupported';
    if (this.closed) return 'closed';
    return this.ctx ? this.ctx.state : 'locked';
  }

  private ensure(): AudioContext | null {
    if (this.ctx || !this.Ctx || this.closed) return this.ctx;
    const ctx = new this.Ctx({ latencyHint: 'playback' });
    const master = ctx.createGain();
    master.gain.value = this.masterGain;
    master.connect(ctx.destination);
    for (const [bus, g] of Object.entries(this.busGain) as [AudioBus, number][]) {
      const node = ctx.createGain();
      node.gain.value = g;
      node.connect(master);
      this.buses.set(bus, node);
    }
    this.ctx = ctx;
    this.master = master;
    return ctx;
  }

  unlock(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    // older iOS only unlocks after a sound is started inside the gesture
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    src.connect(ctx.destination);
    src.start(0);
  }

  async load(src: string): Promise<unknown> {
    const ctx = this.ensure();
    if (!ctx) throw new Error('Web Audio unsupported');
    const res = await fetch(this.resolve(src));
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${src}`);
    return await ctx.decodeAudioData(await res.arrayBuffer());
  }

  start(buffer: unknown, o: StartOptions): AudioVoice {
    const ctx = this.ensure();
    const bus = this.buses.get(o.bus) ?? this.master;
    if (!ctx || !bus || !(buffer instanceof AudioBuffer)) return { stop() {} };
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = o.loop;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    if (o.fadeInMs > 0) {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(o.gain, t + o.fadeInMs / 1000);
    } else g.gain.value = o.gain;
    src.connect(g).connect(bus);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
    src.start(t);
    let stopped = false;
    return {
      stop: (fadeMs = 0) => {
        if (stopped) return;
        stopped = true;
        const now = ctx.currentTime;
        const end = now + Math.max(0.01, fadeMs / 1000);
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(g.gain.value, now);
        g.gain.linearRampToValueAtTime(0, end);
        try {
          src.stop(end + 0.02);
        } catch {
          /* already stopped */
        }
      },
    };
  }

  setMaster(gain: number, rampMs: number): void {
    this.masterGain = gain;
    const ctx = this.ctx;
    const m = this.master;
    if (!ctx || !m) return;
    const now = ctx.currentTime;
    m.gain.cancelScheduledValues(now);
    m.gain.setValueAtTime(m.gain.value, now);
    m.gain.linearRampToValueAtTime(gain, now + Math.max(0.005, rampMs / 1000));
  }

  suspend(): void {
    if (this.ctx?.state === 'running') void this.ctx.suspend().catch(() => {});
  }

  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => {});
  }

  close(afterMs = 0): void {
    if (this.closed) return;
    this.closed = true;
    const ctx = this.ctx;
    if (ctx) setTimeout(() => void ctx.close().catch(() => {}), afterMs);
  }
}
