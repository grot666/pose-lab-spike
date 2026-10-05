import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AudioBank, type AudioBackend, type AudioCue, type StartOptions } from '../src/audio/audioBank';
import { loadAudioPrefs, saveAudioPrefs } from '../src/audio/audioPrefs';
import { LAB_CUE, LAB_CUES } from '../src/audio/labCues';

interface Started {
  buffer: unknown;
  opts: StartOptions;
  stopped: number | null;
}

class FakeBackend implements AudioBackend {
  unlocked = false;
  state = 'fake';
  started: Started[] = [];
  master: number[] = [];
  loads: string[] = [];
  closed = false;
  suspended = false;
  pending = new Map<string, () => void>();
  /** when true, load() waits until release(src) is called */
  manual = false;
  fail = new Set<string>();

  unlock() {
    this.unlocked = true;
  }
  load(src: string): Promise<unknown> {
    this.loads.push(src);
    if (this.fail.has(src)) return Promise.reject(new Error('404'));
    if (!this.manual) return Promise.resolve(`buf:${src}`);
    return new Promise((res) => this.pending.set(src, () => res(`buf:${src}`)));
  }
  release(src: string) {
    this.pending.get(src)?.();
  }
  start(buffer: unknown, opts: StartOptions) {
    const s: Started = { buffer, opts, stopped: null };
    this.started.push(s);
    return { stop: (fadeMs = 0) => void (s.stopped = fadeMs) };
  }
  setMaster(g: number) {
    this.master.push(g);
  }
  suspend() {
    this.suspended = true;
  }
  resume() {
    this.suspended = false;
  }
  close() {
    this.closed = true;
  }
}

const CUES: AudioCue[] = [
  { id: 'hum', src: 'audio/hum.wav', bus: 'ambience', loop: true, volume: 0.5 },
  { id: 'beep', src: 'audio/beep.wav', volume: 0.4, cooldownMs: 1000 },
];

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('AudioBank', () => {
  it('registers, replaces and unregisters cues by id', () => {
    const bank = new AudioBank({ backend: new FakeBackend(), cues: CUES });
    expect(bank.has('hum')).toBe(true);
    bank.register({ id: 'beep', src: 'audio/other.wav' });
    expect(bank.cues.find((c) => c.id === 'beep')?.src).toBe('audio/other.wav');
    expect(bank.cues).toHaveLength(2);
    bank.unregister('hum');
    expect(bank.has('hum')).toBe(false);
    bank.replaceAll([{ id: 'x', src: 'x.wav' }]);
    expect(bank.cues.map((c) => c.id)).toEqual(['x']);
  });

  it('plays one-shots on the sfx bus with cue volume, caching decoded buffers', async () => {
    const be = new FakeBackend();
    let t = 0;
    const bank = new AudioBank({ backend: be, cues: CUES, now: () => t });
    expect(await bank.play('beep')).toBe(true);
    t = 2000;
    expect(await bank.play('beep')).toBe(true);
    expect(be.started).toHaveLength(2);
    expect(be.started[0].opts).toEqual({ bus: 'sfx', gain: 0.4, loop: false, fadeInMs: 0 });
    expect(be.loads).toEqual(['audio/beep.wav']);
  });

  it('enforces per-cue cooldown (no spam)', async () => {
    const be = new FakeBackend();
    let t = 0;
    const bank = new AudioBank({ backend: be, cues: CUES, now: () => t });
    await bank.play('beep');
    t = 500;
    expect(await bank.play('beep')).toBe(false);
    t = 1001;
    expect(await bank.play('beep')).toBe(true);
    expect(be.started).toHaveLength(2);
  });

  it('unknown cues and failed loads fail soft', async () => {
    const be = new FakeBackend();
    be.fail.add('audio/beep.wav');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bank = new AudioBank({ backend: be, cues: CUES });
    expect(await bank.play('nope')).toBe(false);
    expect(await bank.play('beep')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    be.fail.clear();
    expect(await bank.play('beep')).toBe(false); // still inside cooldown
    warn.mockRestore();
  });

  it('loop() is idempotent and stop() fades the voice', async () => {
    const be = new FakeBackend();
    const bank = new AudioBank({ backend: be, cues: CUES });
    await bank.loop('hum', 2000);
    await bank.loop('hum');
    expect(be.started).toHaveLength(1);
    expect(be.started[0].opts).toEqual({ bus: 'ambience', gain: 0.5, loop: true, fadeInMs: 2000 });
    expect(bank.isLooping('hum')).toBe(true);
    bank.stop('hum', 700);
    expect(be.started[0].stopped).toBe(700);
    expect(bank.isLooping('hum')).toBe(false);
    await bank.loop('hum');
    expect(be.started).toHaveLength(2);
  });

  it('stop() during a slow load prevents the loop from starting later', async () => {
    const be = new FakeBackend();
    be.manual = true;
    const bank = new AudioBank({ backend: be, cues: CUES });
    const p = bank.loop('hum');
    bank.stop('hum');
    be.release('audio/hum.wav');
    expect(await p).toBe(false);
    expect(be.started).toHaveLength(0);
  });

  it('mute: master gain 0, one-shots skipped, loops keep running silently', async () => {
    const be = new FakeBackend();
    const bank = new AudioBank({ backend: be, cues: CUES, volume: 0.6 });
    expect(be.master.at(-1)).toBe(0.6);
    await bank.loop('hum');
    bank.setMuted(true);
    expect(be.master.at(-1)).toBe(0);
    expect(await bank.play('beep')).toBe(false);
    expect(bank.isLooping('hum')).toBe(true);
    expect(bank.toggleMuted()).toBe(false);
    expect(be.master.at(-1)).toBe(0.6);
    bank.setVolume(7);
    expect(bank.volume).toBe(1);
    bank.setVolume(Number.NaN);
    expect(bank.volume).toBe(0);
  });

  it('shutdown() (safeword) stops loops, closes backend and refuses further playback', async () => {
    const be = new FakeBackend();
    be.manual = true;
    const bank = new AudioBank({ backend: be, cues: CUES });
    const pending = bank.loop('hum');
    bank.shutdown(200);
    be.release('audio/hum.wav');
    expect(await pending).toBe(false);
    expect(be.closed).toBe(true);
    expect(await bank.loop('hum')).toBe(false);
    expect(await bank.play('beep')).toBe(false);
    bank.unlock();
    expect(be.unlocked).toBe(false);
    expect(bank.state).toBe('closed');
    await flush();
    expect(be.started).toHaveLength(0);
  });

  it('suspends / resumes the backend (tab visibility)', () => {
    const be = new FakeBackend();
    const bank = new AudioBank({ backend: be, cues: CUES });
    bank.setSuspended(true);
    expect(be.suspended).toBe(true);
    bank.setSuspended(false);
    expect(be.suspended).toBe(false);
  });
});

describe('audio prefs', () => {
  const defaults = { muted: false, volume: 0.6 };
  it('round-trips through storage and validates', () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(loadAudioPrefs(store, 'k', defaults)).toEqual(defaults);
    saveAudioPrefs(store, 'k', { muted: true, volume: 0.25 });
    expect(loadAudioPrefs(store, 'k', defaults)).toEqual({ muted: true, volume: 0.25 });
    m.set('k', '{"muted":"yes","volume":9}');
    expect(loadAudioPrefs(store, 'k', defaults)).toEqual({ muted: false, volume: 1 });
    m.set('k', 'not json');
    expect(loadAudioPrefs(store, 'k', defaults)).toEqual(defaults);
    expect(loadAudioPrefs(null, 'k', defaults)).toEqual(defaults);
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadAudioPrefs(throwing, 'k', defaults)).toEqual(defaults);
    expect(() => saveAudioPrefs(throwing, 'k', defaults)).not.toThrow();
  });
});

describe('lab cue manifest', () => {
  const pub = path.resolve(__dirname, '../public');
  it('has ambience loop + state cues, unique ids, local files only', () => {
    const ids = LAB_CUES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of Object.values(LAB_CUE)) expect(ids).toContain(id);
    expect(LAB_CUES.find((c) => c.id === LAB_CUE.ambience)?.loop).toBe(true);
    for (const c of LAB_CUES) {
      expect(c.src).toMatch(/^audio\/[\w-]+\.(wav|ogg|mp3)$/);
      expect(fs.existsSync(path.join(pub, c.src)), c.src).toBe(true);
    }
  });

  it('keeps the audio bundle small (< 2 MB)', () => {
    const dir = path.join(pub, 'audio');
    const total = fs.readdirSync(dir).reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
    expect(total).toBeLessThan(2 * 1024 * 1024);
  });
});
