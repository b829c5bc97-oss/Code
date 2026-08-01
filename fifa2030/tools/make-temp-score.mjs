/**
 * Generates `public/audio/temp-score.mp3` — the 120 BPM temp track the whole
 * film is cut to.
 *
 *   node tools/make-temp-score.mjs
 *
 * This is a SCRATCH TRACK. It exists so that editing, the beat grid and the
 * audio-reactive elements (crowd wave, particle burst) have real amplitude
 * data to lock against, and so the film can be reviewed with sound. It is
 * written to be REPLACED — see README §Audio.
 *
 * It is, however, actually composed rather than beeped: one key (A minor), one
 * chord progression carried through every section, and a melody that returns
 * at the swell. A temp track that is merely rhythmically correct lets you
 * check the cut; a temp track with harmony lets you feel whether the cut
 * works, which is a different and more useful question at this stage.
 *
 * Structure (matches the brief):
 *   0:00–0:14  sparse percussion
 *   0:14–0:36  building strings + drums
 *   0:36–1:12  six cultural instrument features, one per nation, 6s each
 *   1:12–1:24  full orchestral + choir swell
 *   1:24–1:30  a single sustained note into silence
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
const BAR = BEAT * 4; // 2s
const N = SR * DURATION;

const buf = new Float32Array(N);

const add = (t, v) => {
  const i = Math.floor(t * SR);
  if (i >= 0 && i < N) buf[i] += v;
};

// ── Notes (A natural minor) ─────────────────────────────────────────────────
const N_ = {
  A1: 55, C2: 65.41, D2: 73.42, E2: 82.41, F2: 87.31, G2: 98,
  A2: 110, C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196,
  A3: 220, B3: 246.94, C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392,
  A4: 440, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.26, A5: 880,
};

/**
 * The progression the whole film sits on: i – VI – III – VII. Four bars,
 * looped. Every section below draws its chords from here, which is what makes
 * ninety seconds of very different material sound like one piece.
 */
const PROGRESSION = [
  [N_.A2, N_.C4, N_.E4], // Am
  [N_.F2, N_.A3, N_.C4], // F
  [N_.C3, N_.E4, N_.G4], // C
  [N_.G2, N_.B3, N_.D4], // G
];
const chordAt = (t) => PROGRESSION[Math.floor(t / BAR) % PROGRESSION.length];

// ── Synthesis ───────────────────────────────────────────────────────────────

/** ADSR. Real envelopes are most of what separates an instrument from a beep. */
const env = (x, dur, a, d, s, r) => {
  if (x < 0 || x > dur) return 0;
  if (x < a) return x / a;
  if (x < a + d) return 1 - (1 - s) * ((x - a) / d);
  if (x < dur - r) return s;
  return s * Math.max(0, (dur - x) / r);
};

/** Harmonic-rich tone. `bright` controls how many partials survive. */
const voice = (t0, dur, freq, gain, {a = 0.01, d = 0.1, s = 0.7, r = 0.2, bright = 6, vib = 0} = {}) => {
  const steps = Math.floor(dur * SR);
  for (let i = 0; i < steps; i++) {
    const x = i / SR;
    const e = env(x, dur, a, d, s, r);
    if (e <= 0) continue;
    // Slight vibrato on sustained voices; strings and reeds are never static.
    const f = freq * (1 + Math.sin(2 * Math.PI * 5.2 * x) * vib);
    let v = 0;
    for (let h = 1; h <= bright; h++) {
      v += Math.sin(2 * Math.PI * f * h * x) / h;
    }
    add(t0 + x, (v / Math.log2(bright + 1)) * gain * e * 0.5);
  }
};

/** Plucked string: bright attack, fast decay, inharmonic shimmer. */
const pluck = (t0, freq, gain, dur = 1.1) => {
  const steps = Math.floor(dur * SR);
  for (let i = 0; i < steps; i++) {
    const x = i / SR;
    const decay = Math.exp(-x * 4.2);
    const bite = Math.exp(-x * 40);
    const v =
      Math.sin(2 * Math.PI * freq * x) * 0.6 +
      Math.sin(2 * Math.PI * freq * 2 * x) * 0.22 * decay +
      Math.sin(2 * Math.PI * freq * 3.02 * x) * 0.12 * bite +
      Math.sin(2 * Math.PI * freq * 4.9 * x) * 0.08 * bite;
    add(t0 + x, v * gain * decay);
  }
};

let noiseSeed = 12345;
const rnd = () => {
  noiseSeed = (noiseSeed * 1664525 + 1013904223) % 4294967296;
  return noiseSeed / 2147483648 - 1;
};

/** Filtered noise burst — the basis of every drum here except the kick. */
const noiseHit = (t0, dur, gain, decay, tone = 0) => {
  let lp = 0;
  const steps = Math.floor(dur * SR);
  for (let i = 0; i < steps; i++) {
    const x = i / SR;
    const raw = rnd();
    // One-pole low-pass; `tone` 0 = dark (snare body), 1 = bright (hats).
    lp += (raw - lp) * (0.04 + tone * 0.85);
    add(t0 + x, lp * gain * Math.exp(-x * decay));
  }
};

const kick = (t0, gain = 1) => {
  const steps = Math.floor(0.4 * SR);
  for (let i = 0; i < steps; i++) {
    const x = i / SR;
    // Pitch envelope from 150Hz down to 45Hz — the thump.
    const f = 45 + 110 * Math.exp(-x * 26);
    const click = Math.exp(-x * 260) * 0.3;
    add(t0 + x, (Math.sin(2 * Math.PI * f * x) + click) * gain * Math.exp(-x * 7.5));
  }
};

const snare = (t0, gain = 0.5) => {
  noiseHit(t0, 0.2, gain, 22, 0.45);
  voice(t0, 0.09, 190, gain * 0.35, {a: 0.001, d: 0.05, s: 0.1, r: 0.03, bright: 2});
};

const hat = (t0, gain = 0.18, open = false) =>
  noiseHit(t0, open ? 0.24 : 0.06, gain, open ? 14 : 60, 0.95);

const clap = (t0, gain = 0.4) => {
  // Three quick bursts — a clap is never one transient.
  for (const o of [0, 0.012, 0.026]) noiseHit(t0 + o, 0.13, gain * (o ? 0.7 : 1), 34, 0.5);
};

/** Sustained pad from a chord. */
const pad = (t0, dur, chord, gain, opts = {}) => {
  for (const f of chord) {
    voice(t0, dur, f, gain / chord.length, {a: 1.1, d: 0.6, s: 0.85, r: 1.6, bright: 8, vib: 0.004, ...opts});
    // Octave doubling gives the strings some air.
    voice(t0, dur, f * 2, gain / chord.length / 2.6, {a: 1.5, d: 0.6, s: 0.7, r: 1.8, bright: 4, vib: 0.005, ...opts});
  }
};

/** Choir: narrow-band, slow, heavily detuned unison. */
const choir = (t0, dur, chord, gain) => {
  for (const f of chord) {
    for (const detune of [0.997, 1, 1.003]) {
      voice(t0, dur, f * detune, (gain / chord.length) * 0.34, {
        a: 1.8, d: 1, s: 0.9, r: 2.4, bright: 3, vib: 0.006,
      });
    }
  }
};

// ═══ ARRANGEMENT ════════════════════════════════════════════════════════════

// ── 0:00–0:14 · sparse percussion ───────────────────────────────────────────
// Almost nothing. The first touch is the loudest event in the section.
kick(0.6, 1.15);
noiseHit(0.62, 1.1, 0.3, 4.5, 0.3);
for (let b = 4; b * BEAT < 13.5; b += 4) kick(b * BEAT, 0.42);
for (let b = 6; b * BEAT < 13.5; b += 8) hat(b * BEAT, 0.1);
pad(1.5, 12, [N_.A2, N_.E3], 0.1, {a: 3.5, r: 3.5});

// ── 0:14–0:36 · building strings + drums ────────────────────────────────────
for (let bar = 7; bar * BAR < 36; bar++) {
  const t0 = bar * BAR;
  const grow = Math.min(1, (t0 - 14) / 18);
  pad(t0, BAR + 0.4, chordAt(t0), 0.14 + grow * 0.12);

  for (let b = 0; b < 4; b++) {
    const t = t0 + b * BEAT;
    if (t < 14 || t >= 36) continue;
    if (b === 0 || b === 2) kick(t, 0.5 + grow * 0.35);
    if (b === 1 || b === 3) snare(t, (0.12 + grow * 0.3) * (b === 3 ? 1 : 0.7));
    hat(t + BEAT / 2, 0.06 + grow * 0.1);
  }
}
// The rail's tick under the timeline, on every beat.
for (let b = Math.ceil(14 / BEAT); b * BEAT < 36; b++) {
  voice(b * BEAT, 0.05, 2100, 0.035, {a: 0.002, d: 0.02, s: 0.1, r: 0.02, bright: 2});
}

// ── 0:36–1:12 · six cultural features, 6s each ──────────────────────────────
// Each keeps the progression underneath, so the film does not lurch key six
// times in thirty-six seconds.
const FEATURES = [
  // Morocco — Gnawa: krakeb triplets over a guembri bassline.
  (t0) => {
    for (let i = 0; i * (BEAT / 3) < 6; i++) {
      noiseHit(t0 + i * (BEAT / 3), 0.045, 0.13, 95, 0.92);
    }
    for (let b = 0; b * BEAT < 6; b++) {
      const root = chordAt(t0 + b * BEAT)[0];
      voice(t0 + b * BEAT, 0.42, b % 2 ? root : root * 1.5, 0.34, {a: 0.005, d: 0.14, s: 0.4, r: 0.12, bright: 3});
      if (b % 2 === 0) kick(t0 + b * BEAT, 0.6);
    }
  },
  // Spain — flamenco palmas (12-beat compás accents) and a rasgueado.
  (t0) => {
    for (const p of [0, 0.75, 1.25, 2, 2.75, 3.25, 4, 4.75, 5.25]) clap(t0 + p, 0.32);
    for (let s = 0; s < 4; s++) {
      const chord = chordAt(t0 + s * 1.5);
      // Rasgueado: the strings are struck in a fast sweep, not together.
      [...chord, chord[1] * 2, chord[2] * 2].forEach((f, i) =>
        pluck(t0 + s * 1.5 + i * 0.028, f, 0.16, 0.8),
      );
    }
    for (let b = 0; b * BEAT < 6; b += 2) kick(t0 + b * BEAT, 0.42);
  },
  // Portugal — fado guitarra: a descending melody, doubled a sixth below.
  (t0) => {
    const mel = [N_.E5, N_.D5, N_.C5, N_.B4, N_.A4, N_.G4, N_.E4, N_.D4];
    mel.forEach((f, i) => {
      pluck(t0 + i * 0.7, f, 0.3, 1.3);
      pluck(t0 + i * 0.7 + 0.02, f * 0.6, 0.14, 1.1);
    });
    pad(t0, 6, chordAt(t0), 0.12);
  },
  // Uruguay — candombe: chico, repique and piano tamboriles.
  (t0) => {
    for (let b = 0; b * (BEAT / 2) < 6; b++) {
      const t = t0 + b * (BEAT / 2);
      noiseHit(t, 0.07, 0.17, 48, 0.6); // chico, constant
      if (b % 4 === 1) noiseHit(t + 0.11, 0.1, 0.2, 32, 0.4); // repique answers
      if (b % 4 === 0) kick(t, 0.68); // piano on the downbeat
    }
    pad(t0, 6, chordAt(t0), 0.1);
  },
  // Argentina — bandoneón: a reedy chord with the tango's 3-3-2 accent.
  (t0) => {
    for (let bar = 0; bar < 3; bar++) {
      const t = t0 + bar * 2;
      voice(t, 1.9, chordAt(t)[0] * 2, 0.13, {a: 0.35, d: 0.3, s: 0.8, r: 0.5, bright: 9, vib: 0.008});
      chordAt(t).forEach((f) =>
        voice(t, 1.9, f * 2, 0.09, {a: 0.4, d: 0.3, s: 0.75, r: 0.6, bright: 7, vib: 0.007}),
      );
      // 3-3-2.
      for (const p of [0, 0.75, 1.5]) {
        kick(t + p, 0.44);
        noiseHit(t + p, 0.09, 0.1, 40, 0.3);
      }
    }
  },
  // Paraguay — Paraguayan harp: a climbing arpeggio across the progression.
  (t0) => {
    for (let bar = 0; bar < 3; bar++) {
      const t = t0 + bar * 2;
      const c = chordAt(t);
      const run = [c[0] * 2, c[1], c[2], c[1] * 2, c[2] * 2, c[1] * 4, c[2] * 2, c[1] * 2];
      run.forEach((f, i) => pluck(t + i * 0.24, f, 0.17, 1));
      kick(t, 0.36);
    }
  },
];
FEATURES.forEach((fn, i) => fn(36 + i * 6));

// ── 1:12–1:24 · full orchestral + choir swell ───────────────────────────────
// The melody arrives here for the first time, over the same four chords.
const MELODY = [
  [N_.E4, 1], [N_.G4, 0.5], [N_.A4, 1.5], [N_.G4, 0.5], [N_.E4, 0.5],
  [N_.D4, 1], [N_.C4, 1], [N_.E4, 2],
  [N_.A4, 1], [N_.B4, 0.5], [N_.C5, 1.5], [N_.B4, 0.5], [N_.A4, 0.5],
  [N_.G4, 1], [N_.E4, 1], [N_.A4, 2],
];
let mt = 72;
for (const [f, beats] of MELODY) {
  const dur = beats * BEAT;
  voice(mt, dur * 0.96, f, 0.16, {a: 0.06, d: 0.2, s: 0.72, r: 0.25, bright: 7, vib: 0.005});
  voice(mt, dur * 0.96, f / 2, 0.07, {a: 0.08, d: 0.2, s: 0.7, r: 0.3, bright: 5});
  mt += dur;
}

for (let bar = 36; bar * BAR < 84; bar++) {
  const t0 = bar * BAR;
  const grow = Math.min(1, (t0 - 72) / 8);
  pad(t0, BAR + 0.4, chordAt(t0), 0.2 + grow * 0.12);
  choir(t0, BAR + 0.4, chordAt(t0).map((f) => f * 2), 0.12 + grow * 0.08);
  for (let b = 0; b < 4; b++) {
    const t = t0 + b * BEAT;
    if (t >= 84) break;
    kick(t, 0.62 + grow * 0.3);
    if (b % 2 === 1) snare(t, 0.34 + grow * 0.2);
    hat(t + BEAT / 2, 0.12, b === 3);
  }
}
// Crowd bed under the swell — this is what the wave intensity reads.
noiseHit(77.5, 6.5, 0.055, 0.32, 0.25);

// ── 1:24–1:30 · a single sustained note into silence ────────────────────────
kick(84, 1.0);
pad(84, 6, [N_.A2, N_.A3, N_.E4], 0.28, {a: 0.5, d: 1, s: 0.85, r: 4.6});
choir(84, 6, [N_.A4, N_.C5, N_.E5], 0.1);

// ── Master ──────────────────────────────────────────────────────────────────

/**
 * A short reverb tail. Three taps is not a convolution, but dry synthesis in a
 * film like this sounds like a phone speaker — some sense of a room is the
 * single cheapest quality win available here.
 */
const wet = new Float32Array(N);
for (const [delayMs, gain] of [[71, 0.26], [113, 0.19], [173, 0.13], [271, 0.08]]) {
  const d = Math.floor((delayMs / 1000) * SR);
  for (let i = d; i < N; i++) wet[i] += buf[i - d] * gain;
}
// One-pole low-pass on the tail: reverb is darker than the source.
let lp = 0;
for (let i = 0; i < N; i++) {
  lp += (wet[i] - lp) * 0.22;
  buf[i] += lp;
}

let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(buf[i]));
const norm = peak > 0 ? 0.92 / peak : 1;
for (let i = 0; i < N; i++) {
  // Soft-clip rather than hard-limit, so the swell compresses instead of
  // splintering.
  let v = Math.tanh(buf[i] * norm * 1.25) / Math.tanh(1.25);
  const remaining = (N - i) / SR;
  if (remaining < 0.7) v *= remaining / 0.7;
  if (i < 0.02 * SR) v *= i / (0.02 * SR);
  buf[i] = v;
}

// ── Write ───────────────────────────────────────────────────────────────────
const pcm = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(buf[i] * 32767))), i * 2);

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

console.log(`Wrote ${mp3Path} — ${DURATION}s at ${BPM} BPM, A minor, i–VI–III–VII`);
