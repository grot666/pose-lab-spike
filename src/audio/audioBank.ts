/**
 * Extensible audio cue bank (same spirit as ReversGame's SfxBank).
 *
 * Callers only ever say `bank.play('success')` / `bank.loop('ambience')` /
 * `bank.stop('ambience')` - asset paths live in the cue manifest
 * (src/audio/labCues.ts), never in render widgets or the orchestrator.
 * Register / replace cues at runtime without touching callers.
 *
 * Pure logic: the actual sound output is behind {@link AudioBackend}
 * (Web Audio in the browser, a silent/fake backend in tests). Everything
 * fails soft - audio problems never throw into the pose loop.
 */

export type AudioBus = 'ambience' | 'sfx';

export interface AudioCue {
  id: string;
  /** Path relative to Vite BASE_URL (served from public/), e.g. `audio/cue_success.wav`. */
  src: string;
  bus?: AudioBus;
  /** Per-cue gain 0..1 (multiplied by bus + master gain). */
  volume?: number;
  /** Loop cues are started with loop() and run until stop(). */
  loop?: boolean;
  /** One-shots: ignore repeat play() calls within this window (anti-spam). */
  cooldownMs?: number;
}

export interface AudioVoice {
  stop(fadeMs?: number): void;
}

export interface StartOptions {
  bus: AudioBus;
  gain: number;
  loop: boolean;
  fadeInMs: number;
}

export interface AudioBackend {
  /** Must be called synchronously inside a user gesture (autoplay policies). */
  unlock(): void;
  readonly unlocked: boolean;
  /** Human-readable state for the debug panel ("running", "suspended", "unsupported", …). */
  readonly state: string;
  load(src: string): Promise<unknown>;
  start(buffer: unknown, opts: StartOptions): AudioVoice;
  setMaster(gain: number, rampMs: number): void;
  suspend(): void;
  resume(): void;
  close(afterMs?: number): void;
}

/** No-op backend (tests, or browsers without Web Audio). */
export class SilentAudioBackend implements AudioBackend {
  unlocked = false;
  state = 'silent';
  unlock(): void {
    this.unlocked = true;
  }
  async load(): Promise<unknown> {
    return null;
  }
  start(): AudioVoice {
    return { stop() {} };
  }
  setMaster(): void {}
  suspend(): void {}
  resume(): void {}
  close(): void {}
}

export interface AudioBankOptions {
  backend: AudioBackend;
  cues?: AudioCue[];
  volume?: number;
  muted?: boolean;
  /** Injectable clock (ms) for cooldowns. */
  now?: () => number;
  /** Ramp used for mute / volume changes. */
  masterRampMs?: number;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

interface LoopSlot {
  /** Bumped by every loop()/stop() so a slow load can't resurrect a stopped loop. */
  gen: number;
  voice: AudioVoice | null;
}

export class AudioBank {
  private readonly backend: AudioBackend;
  private readonly cueMap = new Map<string, AudioCue>();
  private readonly buffers = new Map<string, Promise<unknown>>();
  private readonly loops = new Map<string, LoopSlot>();
  private readonly lastPlayed = new Map<string, number>();
  private readonly warned = new Set<string>();
  private readonly now: () => number;
  private readonly rampMs: number;
  private _volume: number;
  private _muted: boolean;
  private _disposed = false;

  constructor(opts: AudioBankOptions) {
    this.backend = opts.backend;
    this.now = opts.now ?? (() => performance.now());
    this.rampMs = opts.masterRampMs ?? 120;
    this._volume = clamp01(opts.volume ?? 1);
    this._muted = !!opts.muted;
    for (const c of opts.cues ?? []) this.register(c);
    this.backend.setMaster(this.masterGain, 0);
  }

  // ------------------------------------------------------------- registry
  register(cue: AudioCue): void {
    this.cueMap.set(cue.id, { ...cue });
  }

  registerAll(cues: Iterable<AudioCue>): void {
    for (const c of cues) this.register(c);
  }

  /** Swap the whole manifest (running loops keep playing until stopped). */
  replaceAll(cues: Iterable<AudioCue>): void {
    this.cueMap.clear();
    this.registerAll(cues);
  }

  unregister(id: string): void {
    this.stop(id, 0);
    this.cueMap.delete(id);
  }

  has(id: string): boolean {
    return this.cueMap.has(id);
  }

  get cues(): readonly AudioCue[] {
    return [...this.cueMap.values()];
  }

  // ------------------------------------------------------------- state
  get volume(): number {
    return this._volume;
  }
  get muted(): boolean {
    return this._muted;
  }
  get disposed(): boolean {
    return this._disposed;
  }
  get state(): string {
    return this._disposed ? 'closed' : this.backend.state;
  }
  get masterGain(): number {
    return this._muted ? 0 : this._volume;
  }

  setVolume(v: number): void {
    this._volume = clamp01(v);
    this.backend.setMaster(this.masterGain, this.rampMs);
  }

  setMuted(m: boolean): void {
    this._muted = m;
    this.backend.setMaster(this.masterGain, this.rampMs);
  }

  toggleMuted(): boolean {
    this.setMuted(!this._muted);
    return this._muted;
  }

  isLooping(id: string): boolean {
    return !!this.loops.get(id)?.voice;
  }

  // ------------------------------------------------------------- lifecycle
  /** Call synchronously from a click / tap handler before any await. */
  unlock(): void {
    if (this._disposed) return;
    try {
      this.backend.unlock();
    } catch (err) {
      this.warn('unlock', err);
    }
  }

  /** Decode cues ahead of time (no sound). Defaults to every registered cue. */
  async preload(ids?: string[]): Promise<void> {
    const list = ids ?? [...this.cueMap.keys()];
    await Promise.all(list.map((id) => this.buffer(id).catch(() => null)));
  }

  /** Pause output (tab hidden) without losing loop state. */
  setSuspended(s: boolean): void {
    if (this._disposed) return;
    if (s) this.backend.suspend();
    else this.backend.resume();
  }

  /** Final teardown (safeword / page hide): fade everything and refuse further playback. */
  shutdown(fadeMs = 0): void {
    if (this._disposed) return;
    this.stopAll(fadeMs);
    this._disposed = true;
    this.backend.close(fadeMs + 50);
  }

  // ------------------------------------------------------------- playback
  /** Fire a one-shot cue. Resolves true if it actually started. Never throws. */
  async play(id: string): Promise<boolean> {
    const cue = this.cueMap.get(id);
    if (!cue || this._disposed || this._muted) return false;
    const t = this.now();
    const last = this.lastPlayed.get(id);
    if (cue.cooldownMs && last !== undefined && t - last < cue.cooldownMs) return false;
    this.lastPlayed.set(id, t);
    try {
      const buf = await this.buffer(id);
      if (this._disposed || this._muted) return false;
      this.backend.start(buf, { bus: cue.bus ?? 'sfx', gain: clamp01(cue.volume ?? 1), loop: false, fadeInMs: 0 });
      return true;
    } catch (err) {
      this.warn(id, err);
      return false;
    }
  }

  /** Start a looping cue (idempotent while already playing). Never throws. */
  async loop(id: string, fadeInMs = 1500): Promise<boolean> {
    const cue = this.cueMap.get(id);
    if (!cue || this._disposed) return false;
    const slot = this.loops.get(id) ?? { gen: 0, voice: null };
    this.loops.set(id, slot);
    if (slot.voice) return true;
    const gen = ++slot.gen;
    try {
      const buf = await this.buffer(id);
      // stop() / shutdown() / another loop() happened while decoding
      if (this._disposed || slot.gen !== gen || slot.voice) return false;
      slot.voice = this.backend.start(buf, { bus: cue.bus ?? 'ambience', gain: clamp01(cue.volume ?? 1), loop: true, fadeInMs });
      return true;
    } catch (err) {
      this.warn(id, err);
      return false;
    }
  }

  stop(id: string, fadeMs = 600): void {
    const slot = this.loops.get(id);
    if (!slot) return;
    slot.gen++;
    const v = slot.voice;
    slot.voice = null;
    try {
      v?.stop(fadeMs);
    } catch (err) {
      this.warn(id, err);
    }
  }

  stopAll(fadeMs = 600): void {
    for (const id of this.loops.keys()) this.stop(id, fadeMs);
  }

  // ------------------------------------------------------------- internals
  private buffer(id: string): Promise<unknown> {
    const cue = this.cueMap.get(id);
    if (!cue) return Promise.reject(new Error(`unknown cue ${id}`));
    let p = this.buffers.get(cue.src);
    if (!p) {
      p = this.backend.load(cue.src);
      this.buffers.set(cue.src, p);
      p.catch(() => this.buffers.delete(cue.src)); // allow a retry later
    }
    return p;
  }

  private warn(id: string, err: unknown): void {
    if (this.warned.has(id)) return;
    this.warned.add(id);
    console.warn(`[pose-lab] audio cue "${id}" failed:`, (err as Error)?.message ?? err);
  }
}
