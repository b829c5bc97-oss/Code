// Storage on Netlify Blobs. Two stores:
//   "hq"       – small JSON records (settings, accounts, posts, insights), strong consistency
//   "hq-media" – uploaded photo/video chunks
// When HQ_LOCAL is set (local tests), an in-memory store with the same behaviour is used.

import { getStore } from "@netlify/blobs";
import { env } from "./util.mjs";

const memStores = new Map();

function memStore(name) {
  if (!memStores.has(name)) memStores.set(name, new Map());
  const m = memStores.get(name);
  return {
    async get(key, opts = {}) {
      if (!m.has(key)) return null;
      const { data } = m.get(key);
      if (opts.type === "json") return JSON.parse(Buffer.from(data).toString("utf8"));
      if (opts.type === "arrayBuffer") return Uint8Array.from(data).buffer;
      return Buffer.from(data).toString("utf8");
    },
    async getMetadata(key) {
      if (!m.has(key)) return null;
      return { etag: "x", metadata: m.get(key).metadata || {} };
    },
    async set(key, value, opts = {}) {
      if (opts.onlyIfNew && m.has(key)) return { modified: false };
      let data;
      if (typeof value === "string") data = Buffer.from(value, "utf8");
      else if (value instanceof ArrayBuffer) data = Buffer.from(value);
      else if (ArrayBuffer.isView(value)) data = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      else data = Buffer.from(await value.arrayBuffer());
      m.set(key, { data, metadata: opts.metadata || {} });
      return { modified: true, etag: "x" };
    },
    async setJSON(key, value, opts = {}) {
      return this.set(key, JSON.stringify(value), opts);
    },
    async delete(key) {
      m.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key, etag: "x" })) };
    },
  };
}

function open(name, consistency) {
  if (env("HQ_LOCAL")) return memStore(name);
  return getStore({ name, consistency });
}

const db = () => open("hq", "strong");
const mediaDb = () => open("hq-media", "strong");

export async function getJSON(key) {
  return await db().get(key, { type: "json" });
}

export async function setJSON(key, value, opts) {
  return await db().setJSON(key, value, opts);
}

export async function del(key) {
  await db().delete(key);
}

export async function listKeys(prefix) {
  const { blobs } = await db().list({ prefix });
  return blobs.map((b) => b.key);
}

export async function getMany(keys) {
  const out = await Promise.all(keys.map((k) => getJSON(k).catch(() => null)));
  return out.filter(Boolean);
}

// Media
export async function putChunk(key, data) {
  return await mediaDb().set(key, data);
}

export async function getChunk(key) {
  return await mediaDb().get(key, { type: "arrayBuffer" });
}

export async function delMedia(key) {
  await mediaDb().delete(key);
}

export async function listMediaKeys(prefix) {
  const { blobs } = await mediaDb().list({ prefix });
  return blobs.map((b) => b.key);
}
