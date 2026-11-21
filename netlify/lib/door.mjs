// The private upload door: a secret link that lets you (or another Claude chat, or a script)
// drop finished photos and videos straight into Social HQ without logging in. Files land in
// the Inbox, ready to be turned into posts. Also: download a file from a link (Google Drive,
// Dropbox, any public https link) straight into Social HQ.

import { getJSON, setJSON, del, listKeys } from "./store.mjs";
import { randomId } from "./crypto.mjs";
import { initUpload, putPart, completeUpload, mediaMeta, CHUNK_SIZE } from "./media.mjs";
import { HttpError, clean } from "./util.mjs";

const MAX_LINK = 500 * 1024 * 1024;

export async function doorKey() {
  let rec = await getJSON("door/key");
  if (!rec?.key) {
    rec = { key: randomId(32), at: new Date().toISOString() };
    await setJSON("door/key", rec);
  }
  return rec.key;
}

export async function rotateDoorKey() {
  const rec = { key: randomId(32), at: new Date().toISOString() };
  await setJSON("door/key", rec);
  return rec.key;
}

function safeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length || !a) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

export async function checkDoor(key) {
  const rec = await getJSON("door/key");
  if (!rec?.key || !safeEqual(key, rec.key)) throw new HttpError(403, "This upload link is not valid any more. Ask for the new one in Social HQ → Settings.");
}

export async function addToInbox(media, { caption = "", note = "", source = "upload" } = {}) {
  const item = { id: media.id, kind: media.kind, name: media.name, size: media.size, mime: media.mime, caption: clean(caption, 5000), note: clean(note, 300), source, at: new Date().toISOString() };
  await setJSON(`inbox/${media.id}`, item);
  return item;
}

export async function listInbox() {
  const keys = await listKeys("inbox/");
  const items = [];
  for (const k of keys) {
    const it = await getJSON(k);
    if (it) items.push(it);
  }
  return items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export async function removeFromInbox(id) {
  await del(`inbox/${clean(id, 60)}`);
}

// Turn share links into direct download links.
export function directLink(url) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch (_) {
    throw new HttpError(400, `Not a web address: ${url}`);
  }
  if (u.protocol !== "https:") throw new HttpError(400, "Links must start with https://");
  const host = u.hostname.replace(/^www\./, "");
  if (host === "drive.google.com" || host === "docs.google.com") {
    const id = u.pathname.match(/\/d\/([\w-]{10,})/)?.[1] || u.searchParams.get("id");
    if (!id) throw new HttpError(400, "That Google Drive link has no file id. Use the file's Share → Copy link.");
    return { url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, drive: true };
  }
  if (host.endsWith("dropbox.com")) {
    u.searchParams.delete("dl");
    u.searchParams.set("dl", "1");
    return { url: u.toString() };
  }
  return { url: u.toString() };
}

const EXT = { mp4: "video/mp4", mov: "video/quicktime", m4v: "video/mp4", webm: "video/webm", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

function nameFrom(res, url, fallback) {
  const cd = res.headers.get("content-disposition") || "";
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
  if (m) return decodeURIComponent(m[1]).slice(0, 160);
  if (fallback) return fallback;
  return decodeURIComponent(new URL(url).pathname.split("/").pop() || "file").slice(0, 160);
}

// Download a photo or video from a link into Social HQ, piece by piece (up to 500 MB).
export async function importFromLink(rawUrl, { name: wantName = "", fetchImpl = fetch } = {}) {
  const { url, drive } = directLink(rawUrl);
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok) throw new HttpError(400, `Could not download the file (HTTP ${res.status}).${drive ? " In Google Drive, set sharing to 'Anyone with the link'." : ""}`);
  let mime = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const name = nameFrom(res, url, clean(wantName, 160));
  if (!/^(image|video)\//.test(mime)) {
    const byExt = EXT[(name.split(".").pop() || "").toLowerCase()];
    if (byExt && (mime === "application/octet-stream" || mime === "binary/octet-stream" || !mime)) mime = byExt;
    else if (mime === "text/html") throw new HttpError(400, drive ? "Google Drive sent a web page instead of the file. Set sharing to 'Anyone with the link' and try again." : "That link opens a web page, not a photo or video.");
    else throw new HttpError(400, `That link is not a photo or video (it is ${mime || "unknown"}).`);
  }
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_LINK) throw new HttpError(400, "That file is over 500 MB.");

  const reader = res.body.getReader();
  let up;
  if (len > 0) {
    // Size known: write each 3 MB piece as it arrives (keeps memory low for big videos).
    up = await initUpload({ name, size: len, mime });
    let pending = Buffer.alloc(0);
    let index = 0;
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        pending = Buffer.concat([pending, Buffer.from(value)]);
        total += value.length;
      }
      while (pending.length >= CHUNK_SIZE || (done && pending.length)) {
        await putPart(up.id, index++, pending.subarray(0, CHUNK_SIZE));
        pending = pending.subarray(Math.min(CHUNK_SIZE, pending.length));
      }
      if (done) break;
    }
    if (total !== len) throw new HttpError(400, "The download stopped part-way. Try again.");
  } else {
    // Size unknown: collect first (still capped at 500 MB), then store.
    const pieces = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pieces.push(Buffer.from(value));
      total += value.length;
      if (total > MAX_LINK) throw new HttpError(400, "That file is over 500 MB.");
    }
    if (!total) throw new HttpError(400, "The link gave an empty file.");
    const buf = Buffer.concat(pieces, total);
    up = await initUpload({ name, size: total, mime });
    for (let i = 0; i < up.chunks; i++) await putPart(up.id, i, buf.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
  }
  const done = await completeUpload(up.id);
  return { ...done, warn: done.kind === "image" && mime !== "image/jpeg" ? `${name} is ${mime}; Instagram only takes JPEG photos.` : "" };
}

export async function mediaForIds(ids) {
  const out = [];
  for (const id of ids || []) {
    try {
      const m = await mediaMeta(clean(id, 60));
      out.push({ id: m.id, kind: m.kind, name: m.name, size: m.size, mime: m.mime });
    } catch (_) { /* unknown id */ }
  }
  return out;
}
