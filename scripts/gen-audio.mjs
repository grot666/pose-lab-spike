#!/usr/bin/env node
// Procedurally synthesises the lab's ambience + UI cues into public/audio/*.wav.
// Pure Node, no dependencies, deterministic (seeded PRNG) -> re-running produces
// byte-identical files. Run with:  npm run gen-audio
//
// Output: 16-bit mono PCM WAV @ 22.05 kHz (plays everywhere, incl. iOS Safari).
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DIR } from './assets.mjs';

export const AUDIO_DIR = path.join(PUBLIC_DIR, 'audio');
const SR = 22050;
const TAU = Math.PI * 2;

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function writeWav(file, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
  return buf.length;
}

function normalize(x, peak) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  return x;
}

/** Feedback delay ("lab room" echo). Buffer must already include tail room. */
function echo(x, delayS, feedback, mix) {
  const d = Math.round(delayS * SR);
  const y = Float32Array.from(x);
  for (let i = d; i < y.length; i++) y[i] += y[i - d] * feedback;
  for (let i = 0; i < x.length; i++) y[i] = x[i] * (1 - mix) + y[i] * mix;
  return y;
}

// --------------------------------------------------------------- ambience loop
/**
 * Seamless drone: every tonal partial completes an integer number of cycles in
 * LOOP_S, so the waveform is exactly periodic; the filtered-noise "air handler"
 * bed is rendered longer and its tail cross-faded into its head.
 */
function droneLoop() {
  const LOOP_S = 8;
  const N = LOOP_S * SR;
  const XF = Math.round(1.5 * SR);
  const rnd = mulberry32(0x1ab5);
  // [freq Hz (f*LOOP_S integer), amp, AM rate Hz (k/LOOP_S), AM depth]
  const partials = [
    [55, 0.3, 0.125, 0.15],
    [55.125, 0.22, 0, 0], // 0.125 Hz beating against 55 Hz
    [110, 0.14, 0.25, 0.3],
    [110.25, 0.07, 0, 0],
    [165, 0.045, 0.375, 0.5],
    [220, 0.025, 0.125, 0.8],
    [880, 0.006, 0.125, 1], // faint glassy shimmer
    [1320.375, 0.004, 0.25, 1],
  ];
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    let s = 0;
    for (const [f, a, r, d] of partials) {
      const am = r ? 1 - d * 0.5 * (1 + Math.sin(TAU * r * t)) : 1;
      s += a * am * Math.sin(TAU * f * t);
    }
    out[i] = s;
  }
  // noise bed: white -> two one-pole low-passes (~350 Hz) -> high-pass (~60 Hz)
  const M = N + XF;
  const noise = new Float32Array(M);
  let lp1 = 0;
  let lp2 = 0;
  let hpPrev = 0;
  let hp = 0;
  const aLp = 1 - Math.exp((-TAU * 350) / SR);
  const aHp = Math.exp((-TAU * 60) / SR);
  for (let i = 0; i < M + SR; i++) {
    const w = rnd() * 2 - 1;
    lp1 += aLp * (w - lp1);
    lp2 += aLp * (lp1 - lp2);
    hp = aHp * (hp + lp2 - hpPrev);
    hpPrev = lp2;
    if (i >= SR) noise[i - SR] = hp; // discard 1 s filter warm-up
  }
  normalize(noise, 1);
  const bed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let v = noise[i];
    if (i < XF) {
      // equal-power cross-fade: the head fades in while the rendered-past-the-end
      // tail (noise[N..N+XF)) fades out, so sample N-1 flows straight into sample 0
      const k = i / XF;
      v = noise[i] * Math.sin((k * Math.PI) / 2) + noise[N + i] * Math.cos((k * Math.PI) / 2);
    }
    const swell = 0.7 + 0.3 * Math.sin(TAU * 0.25 * (i / SR) + 1.3);
    bed[i] = v * 0.09 * swell;
  }
  for (let i = 0; i < N; i++) out[i] += bed[i];
  for (let i = 0; i < N; i++) out[i] = Math.tanh(out[i] * 1.4); // gentle warmth
  return normalize(out, 0.7);
}

// --------------------------------------------------------------- UI cues
function render(durS, voices) {
  const out = new Float32Array(Math.round(durS * SR));
  for (const v of voices) {
    const { t0, dur, f0, f1 = f0, amp, attack = 0.004, wave = 'sine', trem = 0 } = v;
    const s0 = Math.round(t0 * SR);
    const n = Math.round(dur * SR);
    let phase = 0;
    for (let i = 0; i < n && s0 + i < out.length; i++) {
      const t = i / SR;
      const k = i / n;
      const f = f0 * Math.pow(f1 / f0, k); // exponential glide
      phase += (TAU * f) / SR;
      const env = Math.min(1, t / attack) * Math.pow(1 - k, 2.2);
      const tr = trem ? 0.6 + 0.4 * Math.sin(TAU * trem * t) : 1;
      let s = Math.sin(phase) + 0.18 * Math.sin(2 * phase);
      if (wave === 'soft-tri') s = Math.sin(phase) + 0.11 * Math.sin(3 * phase) + 0.04 * Math.sin(5 * phase);
      out[s0 + i] += s * env * tr * amp;
    }
  }
  return out;
}

const CUES = {
  // two-tone rising chirp: "new instruction"
  cue_command: () =>
    normalize(
      echo(
        render(0.55, [
          { t0: 0, dur: 0.09, f0: 1046.5, amp: 0.8 },
          { t0: 0.085, dur: 0.16, f0: 1568, amp: 0.7 },
        ]),
        0.11,
        0.28,
        0.35,
      ),
      0.55,
    ),
  // soft ascending triad: "compliance confirmed"
  cue_success: () =>
    normalize(
      echo(
        render(0.85, [
          { t0: 0, dur: 0.12, f0: 1046.5, amp: 0.6 },
          { t0: 0.08, dur: 0.12, f0: 1318.5, amp: 0.6 },
          { t0: 0.16, dur: 0.36, f0: 1568, amp: 0.7 },
        ]),
        0.13,
        0.3,
        0.35,
      ),
      0.55,
    ),
  // low descending two-tone: "non-compliance logged"
  cue_fail: () =>
    normalize(
      echo(
        render(0.7, [
          { t0: 0, dur: 0.16, f0: 392, amp: 0.8, wave: 'soft-tri' },
          { t0: 0.17, dur: 0.3, f0: 277.2, f1: 261.6, amp: 0.8, wave: 'soft-tri' },
        ]),
        0.12,
        0.25,
        0.3,
      ),
      0.6,
    ),
  // downward warbling sweep: "signal lost"
  cue_track_lost: () =>
    normalize(
      echo(render(0.7, [{ t0: 0, dur: 0.42, f0: 880, f1: 330, amp: 0.8, trem: 28, attack: 0.01 }]), 0.1, 0.25, 0.3),
      0.5,
    ),
};

function main() {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  let total = 0;
  const files = { lab_drone_loop: droneLoop, ...CUES };
  for (const [name, fn] of Object.entries(files)) {
    const file = path.join(AUDIO_DIR, `${name}.wav`);
    const bytes = writeWav(file, fn());
    total += bytes;
    console.log(`[gen-audio] public/audio/${name}.wav  ${(bytes / 1024).toFixed(1)} KB`);
  }
  console.log(`[gen-audio] total ${(total / 1024).toFixed(1)} KB`);
}

main();
