// Photo and video uploads. The browser sends files in 3 MB pieces (Netlify functions take
// about 4.5 MB per request), we keep the pieces in Blobs and join them when posting.

import { getJSON, setJSON, del, putChunk, getChunk, delMedia, listMediaKeys } from "./store.mjs";
import { randomId } from "./crypto.mjs";
import { HttpError, clean } from "./util.mjs";

export const CHUNK_SIZE = 3 * 1024 * 1024;
const MAX_SIZE = 500 * 1024 * 1024;

export async function initUpload({ name, size, mime }) {
  size = Number(size) || 0;
  if (!size) throw new HttpError(400, "That file is empty.");
  if (size > MAX_SIZE) throw new HttpError(400, "That file is bigger than 500 MB.");
  mime = clean(mime, 80) || "application/octet-stream";
  const kind = mime.startsWith("video/") ? "video" : mime.startsWith("image/") ? "image" : null;
  if (!kind) throw new HttpError(400, "Only photos and videos can be uploaded.");
  const id = randomId(18);
  const meta = { id, name: clean(name, 200), size, mime, kind, chunks: Math.ceil(size / CHUNK_SIZE), complete: false, createdAt: new Date().toISOString() };
  await setJSON(`media/${id}`, meta);
  return { id, chunkSize: CHUNK_SIZE, chunks: meta.chunks, kind };
}

export async function putPart(id, index, body) {
  const meta = await getJSON(`media/${id}`);
  if (!meta) throw new HttpError(404, "Upload not found.");
  index = parseInt(index, 10);
  if (!(index >= 0 && index < meta.chunks)) throw new HttpError(400, "Wrong piece number.");
  const buf = Buffer.from(body);
  if (!buf.length || buf.length > CHUNK_SIZE) throw new HttpError(400, "Wrong piece size.");
  await putChunk(`c/${id}/${String(index).padStart(5, "0")}`, buf);
  return { ok: true };
}

export async function completeUpload(id) {
  const meta = await getJSON(`media/${id}`);
  if (!meta) throw new HttpError(404, "Upload not found.");
  const keys = await listMediaKeys(`c/${id}/`);
  if (keys.length !== meta.chunks) throw new HttpError(400, `Upload incomplete (${keys.length} of ${meta.chunks} pieces). Try again.`);
  meta.complete = true;
  await setJSON(`media/${id}`, meta);
  return { id, kind: meta.kind, name: meta.name, size: meta.size, mime: meta.mime };
}

export async function mediaMeta(id) {
  const meta = await getJSON(`media/${id}`);
  if (!meta || !meta.complete) throw new HttpError(404, "File not found.");
  return meta;
}

export async function readPart(id, index) {
  const data = await getChunk(`c/${id}/${String(index).padStart(5, "0")}`);
  if (!data) throw new HttpError(404, "File piece not found.");
  return Buffer.from(data);
}

export async function readAll(id) {
  const meta = await mediaMeta(id);
  const parts = [];
  for (let i = 0; i < meta.chunks; i++) parts.push(await readPart(id, i));
  return Buffer.concat(parts);
}

export async function deleteMedia(id) {
  const keys = await listMediaKeys(`c/${id}/`);
  for (const k of keys) await delMedia(k);
  await del(`media/${id}`);
}
