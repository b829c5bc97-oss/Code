/**
 * Generates `public/audio/temp-score.mp3` — the 120 BPM temp track the whole
 * film is cut to.
 *
 * This is a SCRATCH TRACK, synthesised so that editing, the beat grid and the
 * audio-reactive elements (crowd wave, particle burst) have real amplitude data
 * to lock against. It is deliberately plain: it exists to be replaced.
 *
 *   node tools/make-temp-score.mjs
 *
 * See README §Audio for how the licensed score drops in.
 *
 * Structure (matches the brief):
 *   0:00–0:14  sparse percussion
 *   0:14–0:36  building strings + drums
 *   0:36–1:12  six cultural instrument features, one per nation, 6s each
 *   1:12–1:24  full orchestral + choir swell
 *   1:24–1:30  single sustained note into silence
 */

import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SR = 44100;
const DURATION = 90;
const BPM = 120;
const BEAT = 60 / BPM; // 0.5s
const N = SR * DURATION;

const buf = new Float32Array(N);

const clamp = (v) => Math.max(-1, Math.min(1, v));
const at = (t) => Math.floor(t * SR);
const add = (t, sample) => {
  const i = at(t);
  if (i >= 0 && i < N) buf[i] += sample;
};

/** Envelope: exponential decay. */
const decay = (x, k) => Math.exp(-x * k);

const tone = (start, dur, freq, gain, k, shape = Math.sin) => {
  for (let i = 0; i < dur * SR; i++) {
    const x = i / SR;
    add(start + x, shape(2 * Math.PI * freq * x) * gain * decay(x, k));
  }
};

const noise = (start, dur, gain, k, seed = 1) => {
  let s = seed;
  for (let i = 0; i < dur * SR; i++) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    const r = s / 2147483648 - 1;
    add(start + i / SR, r * gain * decay(i / SR, k));
  }
};

/** A sustained pad built from a few detuned partials. */
const pad = (start, dur, freqs, gain, attack = 1.2, release = 1.4) => {
  for (let i = 0; i < dur * SR; i++) {
    const x = i / SR;
    const env =
      Math.min(1, x / attack) * Math.min(1, Math.max(0, (dur - x) / release));
    let v = 0;
    for (const f of freqs) {
      v += Math.sin(2 * Math.PI * f * x) + 0.35 * Math.sin(2 * Math.PI * f * 2.01 * x);
    }
    add(start + x, (v / freqs.length) * gain * env);
  }
};

const pluck = (start, freq, gain, dur = 0.8) => {
  // Rough Karplus-Strong: a decaying tone with an inharmonic partial.
  for (let i = 0; i < dur * SR; i++) {
    const x = i / SR;
    const v =
      Math.sin(2 * Math.PI * freq * x) * 0.7 +
      Math.sin(2 * Math.PI * freq * 2 * x) * 0.2 +
      Math.sin(2 * Math.PI * freq * 3.01 * x) * 0.1;
    add(start + x, v * gain * decay(x, 5.5));
  }
};

const kick = (start, gain = 0.85) => {
  for (let i = 0; i < 0.32 * SR; i++) {
    const x = i / SR;
    const f = 118 * Math.exp(-x * 22) + 42;
    add(start + x, Math.sin(2 * Math.PI * f * x) * gain * decay(x, 9));
  }
};

const clap = (start, gain = 0.4) => noise(start, 0.14, gain, 34, Math.floor(start * 1000) + 7);

// A minor pentatonic-ish set, so every section sits in the same key.
const A2 = 110, E3 = 164.81, A3 = 220, C4 = 261.63, D4 = 293.66, E4 = 329.63, G4 = 392, A4 = 440, C5 = 523.25, E5 = 659.26;

// ── 0:00–0:14 · sparse percussion ────────────────────────────────────────────
// Almost nothing. One deep hit on the first touch, then a slow pulse.
kick(0.6, 1.0);
noise(0.62, 0.9, 0.22, 5, 3);
for (let b = 4; b * BEAT < 14; b += 4) kick(b * BEAT, 0.4);
for (let b = 6; b * BEAT < 14; b += 8) noise(b * BEAT, 0.2, 0.09, 26, b);
pad(2, 12, [A2, E3], 0.1, 3, 3);

// ── 0:14–0:36 · building strings + drums ─────────────────────────────────────
pad(14, 22, [A2, E3, A3], 0.16, 4, 2);
pad(20, 16, [C4, E4, G4], 0.1, 5, 2);
for (let b = 28; b * BEAT < 36; b += 2) {
  const grow = Math.min(1, (b * BEAT - 14) / 20);
  kick(b * BEAT, 0.45 + grow * 0.4);
  if (b % 4 === 2) clap(b * BEAT, 0.16 + grow * 0.2);
}
// The rail's tick, on every beat, under the timeline.
for (let b = 28; b * BEAT < 36; b++) tone(b * BEAT, 0.06, 1800, 0.05, 60);

// ── 0:36–1:12 · six cultural features, 6s each ───────────────────────────────
const FEATURES = [
  // Morocco — Gnawa: krakeb (metal castanets) triplets over a guembri bassline.
  (t0) => {
    for (let i = 0; i * 0.1667 < 6; i++) {
      noise(t0 + i * 0.1667, 0.05, 0.16, 90, i + 11);
    }
    for (let b = 0; b * BEAT < 6; b++) {
      tone(t0 + b * BEAT, 0.44, b % 2 ? A2 : E3, 0.4, 6);
      kick(t0 + b * BEAT, 0.5);
    }
  },
  // Spain — flamenco palmas and a rasgueado.
  (t0) => {
    const pattern = [0, 0.75, 1.25, 2, 2.75, 3.25, 4, 4.75, 5.25];
    for (const p of pattern) clap(t0 + p, 0.34);
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < 5; i++) {
        pluck(t0 + s * 1.5 + i * 0.035, [A3, C4, E4, A4, C5][i], 0.16, 0.6);
      }
    }
    for (let b = 0; b * BEAT < 6; b += 2) kick(t0 + b * BEAT, 0.4);
  },
  // Portugal — fado guitarra: a plucked descending melody.
  (t0) => {
    const mel = [E5, D4 * 2, C5, A4, G4, E4, D4, C4];
    mel.forEach((f, i) => pluck(t0 + i * 0.72, f, 0.3, 1.1));
    pad(t0, 6, [A2, E3], 0.13, 1, 1.4);
  },
  // Uruguay — candombe: the three tamboriles, chico/repique/piano.
  (t0) => {
    for (let b = 0; b * (BEAT / 2) < 6; b++) {
      const t = t0 + b * (BEAT / 2);
      noise(t, 0.09, 0.2, 42, b + 3); // chico
      if (b % 4 === 1) noise(t + 0.12, 0.11, 0.24, 30, b + 21); // repique
      if (b % 4 === 0) kick(t, 0.62); // piano
    }
    pad(t0, 6, [A2, A3], 0.1, 1, 1);
  },
  // Argentina — bandoneón: a sustained reedy chord with a tango accent.
  (t0) => {
    pad(t0, 5.6, [A3, C4, E4, A4], 0.2, 0.7, 1.6);
    for (const p of [0, 1.5, 2.25, 3, 4.5]) {
      tone(t0 + p, 0.3, A2, 0.34, 7);
      kick(t0 + p, 0.42);
    }
  },
  // Paraguay — Paraguayan harp: a climbing arpeggio.
  (t0) => {
    const scale = [A3, C4, E4, A4, C5, E5, A4, E4];
    for (let r = 0; r < 6; r++) {
      scale.forEach((f, i) => pluck(t0 + r * 1 + i * 0.115, f, 0.17, 0.9));
    }
    for (let b = 0; b * BEAT < 6; b += 4) kick(t0 + b * BEAT, 0.34);
  },
];
FEATURES.forEach((fn, i) => fn(36 + i * 6));

// ── 1:12–1:24 · full orchestral + choir swell ────────────────────────────────
pad(72, 12, [A2, E3, A3, C4, E4, A4], 0.3, 2.5, 2);
pad(74, 10, [E4, A4, C5, E5], 0.16, 3, 2); // "choir"
for (let b = 144; b * BEAT < 84; b++) {
  const grow = Math.min(1, (b * BEAT - 72) / 10);
  kick(b * BEAT, 0.5 + grow * 0.5);
  if (b % 2 === 1) clap(b * BEAT, 0.14 + grow * 0.24);
}
// The crowd swell the wave is locked to.
noise(78, 6, 0.05, 0.35, 99);

// ── 1:24–1:30 · a single sustained note into silence ─────────────────────────
pad(84, 6, [A2, A3, E4], 0.26, 0.6, 4.4);
kick(84, 0.9);

// ── Master: soft-clip, normalise, fade the tail. ─────────────────────────────
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(buf[i]));
const norm = peak > 0 ? 0.89 / peak : 1;
for (let i = 0; i < N; i++) {
  let v = clamp(buf[i] * norm);
  v = Math.tanh(v * 1.15) / Math.tanh(1.15);
  // Hard fade to silence over the last 0.6s.
  const remaining = (N - i) / SR;
  if (remaining < 0.6) v *= remaining / 0.6;
  buf[i] = v;
}

// ── Write a 16-bit mono WAV, then encode with Remotion's bundled ffmpeg. ─────
const pcm = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) pcm.writeInt16LE(Math.round(buf[i] * 32767), i * 2);

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);

mkdirSync(join(ROOT, 'public/audio'), {recursive: true});
const wavPath = join(ROOT, 'public/audio/temp-score.wav');
const mp3Path = join(ROOT, 'public/audio/temp-score.mp3');
writeFileSync(wavPath, Buffer.concat([header, pcm]));

execFileSync(
  'npx',
  ['remotion', 'ffmpeg', '-y', '-i', wavPath, '-codec:a', 'libmp3lame', '-b:a', '192k', mp3Path],
  {cwd: ROOT, stdio: 'inherit'},
);
rmSync(wavPath);

console.log(`Wrote ${mp3Path} — ${DURATION}s at ${BPM} BPM`);
