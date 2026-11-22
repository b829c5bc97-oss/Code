// Songs on Reels. Two ways to add one:
//   "mix" – the song (an MP3/M4A/WAV, or the sound of another video) is mixed into the video file
//           before posting, from the second you pick. Works on Instagram, Facebook and YouTube.
//   "app" – Instagram's own music library can only be used inside the Instagram app (no app can add
//           those songs through Meta's API). Instagram is sent a reminder instead of an automatic post,
//           with the video, caption and the song + part you picked, so you add it in the app.

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { clean, env, HttpError } from "./util.mjs";

const require = createRequire(import.meta.url);

function ffmpegPath() {
  if (env("FFMPEG_PATH")) return env("FFMPEG_PATH");
  try {
    const p = require("ffmpeg-static");
    if (p) return p;
  } catch (_) { /* fall back to the system one */ }
  return "ffmpeg";
}

const num = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

// The song settings saved on a post (or null for no song).
export function normaliseMusic(m) {
  if (!m || !["mix", "app"].includes(m.mode)) return null;
  const out = { mode: m.mode, name: clean(m.name, 120), startSec: Math.round(num(m.startSec, 0, 3600, 0) * 10) / 10 };
  // Lengths, only so the editor can draw the song and the part used.
  if (num(m.videoSec, 0, 3600, 0)) out.videoSec = Math.round(num(m.videoSec, 0, 3600, 0) * 10) / 10;
  if (num(m.songSec, 0, 36000, 0)) out.songSec = Math.round(num(m.songSec, 0, 36000, 0) * 10) / 10;
  if (m.mode === "mix") {
    out.mediaId = clean(m.mediaId, 60);
    out.musicVol = num(m.musicVol, 0, 2, 0.7);
    out.voiceVol = num(m.voiceVol, 0, 2, 1);
    out.duck = m.duck !== false;
    out.fade = m.fade !== false;
    if (m.mixedId && m.mixedKey) {
      out.mixedId = clean(m.mixedId, 60);
      out.mixedKey = clean(m.mixedKey, 300);
    }
  } else {
    out.part = clean(m.part, 200);
  }
  return out;
}

// Identifies one exact mix, so a mix made in the editor is reused at posting time only if nothing changed.
export function mixKey(videoId, m) {
  if (!m || m.mode !== "mix") return "";
  return [videoId, m.mediaId, m.startSec, m.musicVol, m.voiceVol, m.duck ? 1 : 0, m.fade ? 1 : 0].join("|");
}

export function musicProblems(post, accountsById) {
  const m = post.music;
  if (!m) return [];
  const out = [];
  const videos = (post.media || []).filter((x) => x.kind === "video");
  if (videos.length !== 1 || post.media.length !== 1) out.push("A song can only be added to a post with exactly one video.");
  if (m.mode === "mix" && !m.mediaId) out.push("Pick the song file to mix in, or choose \"No song\".");
  if (m.mode === "app") {
    if (!post.accountIds.some((id) => accountsById[id]?.platform === "instagram")) out.push("\"Add the song in the Instagram app\" needs an Instagram account in the post.");
    if (!m.name) out.push("Write which song to add in the Instagram app.");
  }
  return out;
}

function run(args, { timeoutMs = 150000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    const t = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error("Adding the song took too long."));
    }, timeoutMs);
    p.stderr.on("data", (d) => {
      err += d;
      if (err.length > 200000) err = err.slice(-100000);
    });
    p.on("error", (e) => {
      clearTimeout(t);
      reject(new Error(`The sound tool could not start (${e.message}).`));
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, err });
    });
  });
}

// Length in seconds and whether the file has sound, read from ffmpeg's own report.
export async function probe(path) {
  const { err } = await run(["-hide_banner", "-i", path], { timeoutMs: 30000 });
  const d = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  return { duration, hasAudio: /Stream #\d+:\d+[^\n]*Audio:/.test(err), hasVideo: /Stream #\d+:\d+[^\n]*Video:/.test(err) };
}

// The ffmpeg filter that trims the song to the chosen part, sets the volumes, fades it, lowers it
// while someone talks (ducking) and mixes it with the video's own sound.
export function buildFilter({ duration, hasAudio, musicVol, voiceVol, duck, fade }) {
  const D = Math.max(0.5, duration);
  const fades = fade ? `,afade=t=in:st=0:d=0.4,afade=t=out:st=${Math.max(0, D - 1.5).toFixed(2)}:d=1.5` : "";
  const music = `[1:a]atrim=duration=${D.toFixed(2)},asetpts=PTS-STARTPTS,aresample=48000,volume=${musicVol}${fades},apad`;
  if (!hasAudio || voiceVol <= 0) return `${music},atrim=duration=${D.toFixed(2)},alimiter=limit=0.95[a]`;
  if (duck) {
    return `${music}[m];[0:a]aresample=48000,asplit=2[v0][sc];[v0]volume=${voiceVol}[v];[m][sc]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=500[md];[v][md]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[a]`;
  }
  return `${music}[m];[0:a]aresample=48000,volume=${voiceVol}[v];[v][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[a]`;
}

// Mixes the song into the video. The picture is copied as it is (no quality loss, fast);
// only the sound is rebuilt.
export async function mixSong({ video, song, startSec = 0, musicVol = 0.7, voiceVol = 1, duck = true, fade = true }) {
  const dir = await mkdtemp(join(tmpdir(), "hq-music-"));
  try {
    const vPath = join(dir, "video.mp4");
    const sPath = join(dir, "song");
    const out = join(dir, "out.mp4");
    await writeFile(vPath, video);
    await writeFile(sPath, song);
    const v = await probe(vPath);
    const s = await probe(sPath);
    if (!v.hasVideo || !v.duration) throw new HttpError(400, "The video file could not be read.");
    if (!s.hasAudio) throw new HttpError(400, "The song file has no sound in it.");
    if (s.duration && startSec >= s.duration - 0.5) throw new HttpError(400, `The song is only ${Math.floor(s.duration)} seconds long, so it can't start at ${startSec} seconds.`);
    const filter = buildFilter({ duration: v.duration, hasAudio: v.hasAudio, musicVol, voiceVol, duck, fade });
    const { code, err } = await run([
      "-hide_banner", "-y",
      "-i", vPath,
      "-ss", String(startSec), "-i", sPath,
      "-filter_complex", filter,
      "-map", "0:v:0", "-map", "[a]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-t", v.duration.toFixed(2),
      "-movflags", "+faststart",
      out,
    ]);
    if (code !== 0) throw new Error(`The song could not be mixed in: ${err.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
    const buf = await readFile(out);
    return { buf, duration: v.duration, songDuration: s.duration, hadVoice: v.hasAudio };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
