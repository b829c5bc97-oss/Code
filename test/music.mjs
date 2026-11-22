// Songs on Reels: mixing a song into the video from the chosen second, reusing a mix made in the
// editor, and Instagram-library songs turning the Instagram part into a reminder.
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 node test/music.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { upsertConnected } from "../netlify/lib/accounts.mjs";
import { createPost, getPost, updatePost } from "../netlify/lib/posts.mjs";
import { publishPost } from "../netlify/lib/jobs.mjs";
import { initUpload, saveBuffer, readAll } from "../netlify/lib/media.mjs";
import { normaliseMusic, musicProblems, mixKey, mixSong, probe, buildFilter } from "../netlify/lib/music.mjs";
import { overview } from "../netlify/lib/views.mjs";

const ffmpeg = createRequire(import.meta.url)("ffmpeg-static");

// --- settings ---
assert.equal(normaliseMusic(null), null);
assert.equal(normaliseMusic({ mode: "radio" }), null);
const n = normaliseMusic({ mode: "mix", mediaId: "s1", startSec: 45.27, musicVol: 9, voiceVol: -1 });
assert.deepEqual([n.startSec, n.musicVol, n.voiceVol, n.duck, n.fade], [45.3, 2, 0, true, true]);
const app = normaliseMusic({ mode: "app", name: "Kesariya", part: "from 0:45", mediaId: "ignored" });
assert.equal(app.mediaId, undefined);
assert.equal(app.part, "from 0:45");
console.log("✓ song settings are cleaned and kept in range");

await upsertConnected({ platform: "instagram", kind: "ig_business", remoteId: "800", name: "Coinwise", handle: "@coinwise", token: "T" });
await upsertConnected({ platform: "facebook", kind: "page", remoteId: "801", name: "Coinwise FB", token: "T" });
const byId = { "instagram-800": { id: "instagram-800", platform: "instagram", name: "Coinwise" }, "facebook-801": { id: "facebook-801", platform: "facebook", name: "Coinwise FB" } };
const one = [{ id: "v1", kind: "video" }];
assert.match(musicProblems({ music: normaliseMusic({ mode: "mix" }), media: one, accountIds: ["instagram-800"] }, byId).join(" "), /Pick the song file/);
assert.match(musicProblems({ music: normaliseMusic({ mode: "mix", mediaId: "s" }), media: [...one, { id: "i", kind: "image" }], accountIds: ["instagram-800"] }, byId).join(" "), /exactly one video/);
assert.match(musicProblems({ music: normaliseMusic({ mode: "app", name: "X" }), media: one, accountIds: ["facebook-801"] }, byId).join(" "), /needs an Instagram account/);
assert.deepEqual(musicProblems({ music: normaliseMusic({ mode: "app", name: "X" }), media: one, accountIds: ["instagram-800"] }, byId), []);
console.log("✓ clear problems for a song on the wrong kind of post");

// --- real mixing with ffmpeg ---
const dir = mkdtempSync(join(tmpdir(), "music-test-"));
const make = (args) => assert.equal(spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]).status, 0);
make(["-f", "lavfi", "-i", "testsrc=size=180x320:rate=25:duration=6", "-f", "lavfi", "-i", "sine=frequency=300:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "v.mp4")]);
make(["-f", "lavfi", "-i", "testsrc=size=180x320:rate=25:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "silent.mp4")]);
make(["-f", "lavfi", "-i", "sine=frequency=880:duration=30", "-c:a", "libmp3lame", join(dir, "s.mp3")]);
const video = readFileSync(join(dir, "v.mp4")), silent = readFileSync(join(dir, "silent.mp4")), song = readFileSync(join(dir, "s.mp3"));

for (const opts of [{ startSec: 10, duck: true }, { startSec: 3, duck: false }, { voiceVol: 0 }]) {
  const r = await mixSong({ video, song, ...opts });
  assert.ok(Math.abs(r.duration - 6) < 0.2 && r.hadVoice);
}
const r2 = await mixSong({ video: silent, song, startSec: 2 });
assert.equal(r2.hadVoice, false);
const outPath = join(dir, "out.mp4");
(await import("node:fs")).writeFileSync(outPath, r2.buf);
const pr = await probe(outPath);
assert.ok(pr.hasAudio && pr.hasVideo && Math.abs(pr.duration - 4) < 0.2, "a silent video gets the song as its sound, same length");
await assert.rejects(mixSong({ video, song, startSec: 29.9 }), /only 30 seconds long/);
assert.match(buildFilter({ duration: 6, hasAudio: true, musicVol: 0.7, voiceVol: 1, duck: true, fade: true }), /sidechaincompress/);
assert.doesNotMatch(buildFilter({ duration: 6, hasAudio: true, musicVol: 0.7, voiceVol: 1, duck: false, fade: false }), /sidechaincompress|afade/);
console.log("✓ the song is mixed in from the chosen second, same length as the video (with or without its own sound)");

// --- uploads accept songs ---
const up = await initUpload({ name: "song.mp3", size: 1000, mime: "audio/mpeg" });
assert.equal(up.kind, "audio");
console.log("✓ song files can be uploaded");

// --- posting with a mixed song ---
// Each post gets its own files: posting frees them once everything is out.
let vMeta, sMeta, media;
async function freshFiles() {
  vMeta = await saveBuffer({ name: "reel.mp4", mime: "video/mp4", buf: Buffer.from("ORIGINAL-VIDEO") });
  sMeta = await saveBuffer({ name: "song.mp3", mime: "audio/mpeg", buf: Buffer.from("SONG") });
  media = [{ id: vMeta.id, kind: "video", name: "reel.mp4", mime: "video/mp4" }];
}
await freshFiles();
const seen = [];
const fake = (platform) => ({
  ensureToken: async ({ account }) => ({ account, changed: false }),
  publish: async ({ post, ctx }) => {
    seen.push({ platform, bytes: String(await ctx.bytes(post.media[0].id)) });
    return { remoteId: "r", url: `https://${platform}.test/1` };
  },
});
const impl = { instagram: fake("instagram"), facebook: fake("facebook") };
const mixCalls = [];
const fakeMix = async (args) => {
  mixCalls.push({ start: args.startSec, video: String(args.video), song: String(args.song) });
  return { buf: Buffer.from(`MIXED@${args.startSec}`), duration: 6 };
};
const past = () => new Date(Date.now() - 60000).toISOString();

let p = await createPost({ accountIds: ["instagram-800", "facebook-801"], type: "reel", caption: "DEBT", media, music: { mode: "mix", mediaId: sMeta.id, startSec: 45 }, scheduledAt: past() });
await publishPost(p.id, "https://hq.test", { platformsOverride: impl, mix: fakeMix });
p = await getPost(p.id);
assert.deepEqual(mixCalls, [{ start: 45, video: "ORIGINAL-VIDEO", song: "SONG" }], "mixed once for all platforms");
assert.deepEqual(seen.map((x) => x.bytes), ["MIXED@45", "MIXED@45"]);
assert.equal(p.targets["instagram-800"].status, "posted");
await assert.rejects(readAll(sMeta.id), "the song file is freed once everything is out");
console.log("✓ posting mixes the song in once and every platform gets the video with the song");

// A mix made in the editor is reused when nothing changed, and remade when something did.
seen.length = 0;
mixCalls.length = 0;
await freshFiles();
let ready = await saveBuffer({ name: "reel (with song).mp4", mime: "video/mp4", buf: Buffer.from("EDITOR-MIX") });
let music = normaliseMusic({ mode: "mix", mediaId: sMeta.id, startSec: 12 });
p = await createPost({ accountIds: ["instagram-800"], type: "reel", caption: "x", media, music: { ...music, mixedId: ready.id, mixedKey: mixKey(vMeta.id, music) }, scheduledAt: past() });
await publishPost(p.id, "https://hq.test", { platformsOverride: impl, mix: fakeMix });
assert.deepEqual(mixCalls, []);
assert.equal(seen[0].bytes, "EDITOR-MIX");
seen.length = 0;
await freshFiles();
ready = await saveBuffer({ name: "reel (with song).mp4", mime: "video/mp4", buf: Buffer.from("EDITOR-MIX") });
music = normaliseMusic({ mode: "mix", mediaId: sMeta.id, startSec: 12 });
p = await createPost({ accountIds: ["instagram-800"], type: "reel", caption: "x", media, music: { ...music, startSec: 20, mixedId: ready.id, mixedKey: mixKey(vMeta.id, music) }, scheduledAt: past() });
await publishPost(p.id, "https://hq.test", { platformsOverride: impl, mix: fakeMix });
assert.equal(mixCalls.length, 1);
assert.equal(seen[0].bytes, "MIXED@20");
console.log("✓ the final video made in the editor is reused, and remade if the part changed");

// If the song can't be added, nothing goes out without it.
seen.length = 0;
await freshFiles();
p = await createPost({ accountIds: ["instagram-800"], type: "reel", caption: "x", media, music: { mode: "mix", mediaId: sMeta.id }, scheduledAt: past() });
await publishPost(p.id, "https://hq.test", { platformsOverride: impl, mix: async () => { throw new Error("broken file"); } });
p = await getPost(p.id);
assert.equal(seen.length, 0, "nothing posted without the song");
assert.match(p.targets["instagram-800"].lastError || p.targets["instagram-800"].error, /song could not be added/);
console.log("✓ if the song can't be added, the post doesn't go out without it");

// --- Instagram-library song: Instagram becomes a reminder, Facebook still posts ---
seen.length = 0;
await freshFiles();
mixCalls.length = 0;
p = await createPost({ accountIds: ["instagram-800", "facebook-801"], type: "reel", caption: "Can you spot it?", captions: { instagram: "IG caption" }, media, music: { mode: "app", name: "Kesariya – Arijit Singh", part: "from 0:45 (chorus)" }, scheduledAt: past() });
await publishPost(p.id, "https://hq.test", { platformsOverride: impl, mix: fakeMix });
p = await getPost(p.id);
assert.equal(p.targets["instagram-800"].status, "reminder");
assert.equal(p.targets["instagram-800"].song, true);
assert.equal(p.targets["facebook-801"].status, "posted");
assert.deepEqual(seen.map((x) => [x.platform, x.bytes]), [["facebook", "ORIGINAL-VIDEO"]]);
assert.deepEqual(mixCalls, []);
assert.equal(String(await readAll(vMeta.id)), "ORIGINAL-VIDEO", "the video stays for downloading while the reminder is open");
const ov = await overview();
const rem = ov.reminders.find((r) => r.post.id === p.id);
assert.deepEqual(rem.song, { name: "Kesariya – Arijit Singh", part: "from 0:45 (chorus)" });
assert.equal(rem.caption, "IG caption");
console.log("✓ an Instagram-library song turns Instagram into a reminder with the song, part and caption; Facebook posts by itself");

// Switching the song off.
p = await createPost({ accountIds: ["instagram-800"], type: "reel", caption: "x", media, music: { mode: "app", name: "X" } });
p = await updatePost(p.id, { music: null });
assert.equal(p.music, null);
console.log("✓ a song can be removed again");

// --- the editor's "Make the final video" button, through the API ---
const { handle } = await import("../netlify/functions/api.mjs");
let cookie = "";
async function call(method, path, body) {
  const init = { method, headers: { cookie } };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
  const res = await handle(new Request("https://hq.test" + path, init), { site: { url: "https://hq.test" } });
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
let r = await call("POST", "/api/auth/setup", { code: "123456", password: "longpassword" });
assert.equal(r.status, 200, JSON.stringify(r.data));
const realV = await saveBuffer({ name: "reel.mp4", mime: "video/mp4", buf: video });
const realS = await saveBuffer({ name: "song.mp3", mime: "audio/mpeg", buf: song });
r = await call("POST", "/api/music/mix", { videoId: realV.id, music: { mediaId: realS.id, startSec: 8, musicVol: 0.8 } });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.ok(Math.abs(r.data.duration - 6) < 0.2 && r.data.size > 1000);
assert.equal(r.data.key, mixKey(realV.id, normaliseMusic({ mode: "mix", mediaId: realS.id, startSec: 8, musicVol: 0.8 })));
const first = r.data.id;
r = await call("POST", "/api/music/mix", { videoId: realV.id, music: { mediaId: realS.id, startSec: 2 }, previousId: first });
assert.equal(r.status, 200);
await assert.rejects(readAll(first), "the old final video is cleaned up when a new one is made");
r = await call("POST", "/api/music/mix", { videoId: realV.id, music: { mediaId: realS.id, startSec: 50 } });
assert.equal(r.status, 400);
assert.match(r.data.error, /only 30 seconds long/);
console.log("✓ \"Make the final video\" returns a playable mix, replaces the old one, and explains a start past the song's end");
