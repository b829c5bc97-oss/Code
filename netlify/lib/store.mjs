// Storage. Two stores:
//   "hq"       – small JSON records (settings, accounts, posts, insights)
//   "hq-media" – uploaded photo/video chunks and saved profile pictures
// Backends: Supabase (Postgres table "kv" + Storage bucket "media") when SUPABASE_URL is set,
// Netlify Blobs otherwise, and an in-memory store for local tests (HQ_LOCAL).

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

// ---------- Supabase ----------
function sb() {
  const url = (env("SUPABASE_URL") || "").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SECRET_KEY") || env("SUPABASE_SERVICE_KEY");
  // New-style secret keys (sb_secret_…) go only in "apikey"; older service_role keys are JWTs.
  const headers = String(key || "").startsWith("sb_") ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` };
  return { url, headers };
}
async function sbFetch(path, init = {}, tries = 3) {
  const { url, headers } = sb();
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url + path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
      if (res.status >= 500 && i < tries - 1) { last = new Error(`Storage ${res.status}`); await new Promise((r) => setTimeout(r, 300 * (i + 1))); continue; }
      return res;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw last;
}
async function rpc(fn, args) {
  const res = await sbFetch(`/rest/v1/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Storage error (${fn} ${res.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
function sbKv() {
  return {
    async get(key) {
      return await rpc("kv_get", { k: key });
    },
    async setJSON(key, value, opts = {}) {
      if (opts.onlyIfNew) return { modified: !!(await rpc("kv_set_new", { k: key, v: value })) };
      await rpc("kv_set", { k: key, v: value });
      return { modified: true };
    },
    async delete(key) {
      await rpc("kv_del", { k: key });
    },
    async list({ prefix = "" } = {}) {
      const keys = (await rpc("kv_list", { p: prefix })) || [];
      return { blobs: keys.map((k) => ({ key: typeof k === "string" ? k : k.kv_list })) };
    },
    async getMany(keys) {
      return (await rpc("kv_get_many", { ks: keys })) || [];
    },
    async setMany(items) {
      for (let i = 0; i < items.length; i += 200) await rpc("kv_set_many", { items: items.slice(i, i + 200) });
    },
  };
}
const objPath = (key) => key.split("/").map(encodeURIComponent).join("/");
function sbMedia() {
  return {
    async get(key) {
      const res = await sbFetch(`/storage/v1/object/media/${objPath(key)}`);
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw new Error(`Media read failed (${res.status})`);
      return await res.arrayBuffer();
    },
    async set(key, data) {
      const body = data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data : Buffer.from(await data.arrayBuffer());
      const res = await sbFetch(`/storage/v1/object/media/${objPath(key)}`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-upsert": "true", "cache-control": "no-cache" }, body });
      if (!res.ok) throw new Error(`Media save failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      return { modified: true };
    },
    async delete(key) {
      await sbFetch(`/storage/v1/object/media`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ prefixes: [key] }) });
    },
    async list({ prefix = "" } = {}) {
      // Storage lists one folder at a time: list the folder part, keep names starting with the rest.
      const cut = prefix.lastIndexOf("/");
      const folder = cut >= 0 ? prefix.slice(0, cut) : "";
      const start = cut >= 0 ? prefix.slice(cut + 1) : prefix;
      const out = [];
      for (let offset = 0; offset < 100000; offset += 1000) {
        const res = await sbFetch(`/storage/v1/object/list/media`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prefix: folder, limit: 1000, offset, search: start, sortBy: { column: "name", order: "asc" } }) });
        if (!res.ok) break;
        const items = await res.json();
        for (const it of items) if (it.id && it.name.startsWith(start)) out.push({ key: (folder ? folder + "/" : "") + it.name });
        if (items.length < 1000) break;
      }
      return { blobs: out };
    },
  };
}

function open(name, consistency) {
  if (env("HQ_LOCAL")) return memStore(name);
  if (env("SUPABASE_URL")) return name === "hq" ? sbKv() : sbMedia();
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
  if (!keys.length) return [];
  const store = db();
  if (store.getMany) {
    const out = [];
    for (let i = 0; i < keys.length; i += 200) {
      const rows = await store.getMany(keys.slice(i, i + 200));
      const byKey = new Map(rows.map((r) => [r.key, r.value]));
      for (const k of keys.slice(i, i + 200)) if (byKey.has(k)) out.push(byKey.get(k));
    }
    return out;
  }
  const out = await Promise.all(keys.map((k) => getJSON(k).catch(() => null)));
  return out.filter(Boolean);
}

// Write many records at once (used when importing).
export async function setMany(items) {
  const store = db();
  if (store.setMany) return await store.setMany(items);
  for (const it of items) await store.setJSON(it.k, it.v);
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
