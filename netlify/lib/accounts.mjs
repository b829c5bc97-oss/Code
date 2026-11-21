// Connected accounts. One record per Instagram account, Facebook Page, LinkedIn profile/page,
// YouTube channel, Pinterest account, or reminder-only personal profile.

import { getJSON, setJSON, del, listKeys, getMany } from "./store.mjs";
import { encrypt, decrypt, randomId } from "./crypto.mjs";
import { HttpError, clean } from "./util.mjs";

export const PLATFORM_LABEL = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  pinterest: "Pinterest",
  manual: "Facebook profile",
};

function keyFor(id) {
  return `acct/${id}`;
}

export function accountId(platform, remoteId) {
  return `${platform}-${String(remoteId).replace(/[^a-zA-Z0-9_-]/g, "")}`.slice(0, 120);
}

export async function listAccounts() {
  const keys = await listKeys("acct/");
  const all = await getMany(keys);
  return all.sort((a, b) => (a.brand || "").localeCompare(b.brand || "") || a.platform.localeCompare(b.platform));
}

export async function getAccount(id) {
  const a = await getJSON(keyFor(id));
  if (!a) throw new HttpError(404, "Account not found.");
  return a;
}

export async function saveAccount(a) {
  a.updatedAt = new Date().toISOString();
  await setJSON(keyFor(a.id), a);
  return a;
}

// Insert or update after an OAuth login. Keeps brand/cadence the user already set.
export async function upsertConnected({ platform, kind, remoteId, name, handle, avatar, token, refreshToken, tokenExpiresAt, refreshExpiresAt, meta }) {
  const id = accountId(platform, remoteId);
  const existing = await getJSON(keyFor(id));
  const a = {
    id,
    platform,
    kind,
    remoteId: String(remoteId),
    name: name || existing?.name || handle || "Account",
    handle: handle || existing?.handle || "",
    avatar: avatar || existing?.avatar || "",
    brand: existing?.brand || guessBrand(name || handle || ""),
    cadence: existing?.cadence || 0,
    token: token ? encrypt(token) : existing?.token || null,
    refreshToken: refreshToken ? encrypt(refreshToken) : existing?.refreshToken || null,
    tokenExpiresAt: tokenExpiresAt || null,
    refreshExpiresAt: refreshExpiresAt || existing?.refreshExpiresAt || null,
    status: "ok",
    lastError: "",
    meta: { ...(existing?.meta || {}), ...(meta || {}) },
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  return await saveAccount(a);
}

export async function addReminderAccount({ name, brand }) {
  const id = `manual-${randomId(6)}`;
  const a = {
    id,
    platform: "manual",
    kind: "fb_profile",
    remoteId: id,
    name: clean(name, 80) || "Personal profile",
    handle: "",
    avatar: "",
    brand: clean(brand, 60) || "Personal",
    cadence: 0,
    token: null,
    refreshToken: null,
    tokenExpiresAt: null,
    status: "reminder",
    lastError: "",
    meta: {},
    createdAt: new Date().toISOString(),
  };
  return await saveAccount(a);
}

export async function updateAccount(id, patch) {
  const a = await getAccount(id);
  if (patch.brand !== undefined) a.brand = clean(patch.brand, 60).trim() || a.brand;
  if (patch.name !== undefined) a.name = clean(patch.name, 80).trim() || a.name;
  if (patch.cadence !== undefined) a.cadence = Math.max(0, Math.min(21, parseInt(patch.cadence, 10) || 0));
  if (patch.boardId !== undefined) a.meta = { ...(a.meta || {}), defaultBoardId: clean(patch.boardId, 40) };
  return await saveAccount(a);
}

export async function removeAccount(id) {
  await del(keyFor(id));
  await del(`ins/${id}/latest`);
  await del(`bt/${id}`);
}

export function tokenOf(a) {
  return decrypt(a.token);
}

export function refreshTokenOf(a) {
  return decrypt(a.refreshToken);
}

export function setTokens(a, { token, refreshToken, tokenExpiresAt, refreshExpiresAt }) {
  if (token) a.token = encrypt(token);
  if (refreshToken) a.refreshToken = encrypt(refreshToken);
  if (tokenExpiresAt !== undefined) a.tokenExpiresAt = tokenExpiresAt;
  if (refreshExpiresAt !== undefined) a.refreshExpiresAt = refreshExpiresAt;
  return a;
}

// What the browser may see.
export function publicAccount(a) {
  const now = Date.now();
  let loginNote = "";
  let status = a.status;
  if (a.platform === "manual") loginNote = "Reminder with caption and photo ready";
  else if (a.platform === "facebook") loginNote = "Page login doesn't expire";
  else if (a.platform === "linkedin" && a.tokenExpiresAt) {
    const days = Math.ceil((new Date(a.tokenExpiresAt).getTime() - now) / 86400000);
    loginNote = days > 0 ? `LinkedIn asks again in ${days} days` : "LinkedIn login ended — reconnect";
    if (days <= 0) status = "expired";
    else if (days <= 10 && status === "ok") status = "expiring";
  } else if (a.platform === "pinterest" && a.refreshExpiresAt) {
    const days = Math.ceil((new Date(a.refreshExpiresAt).getTime() - now) / 86400000);
    loginNote = days > 30 ? "Login renews by itself" : `Reconnect within ${Math.max(days, 0)} days`;
    if (days <= 10 && status === "ok") status = "expiring";
  } else loginNote = "Login renews by itself";
  return {
    id: a.id,
    platform: a.platform,
    kind: a.kind,
    name: a.name,
    handle: a.handle,
    avatar: a.avatarCached ? `/m/av/${encodeURIComponent(a.id)}?v=${a.avatarCached}` : a.avatar || "",
    brand: a.brand,
    cadence: a.cadence || 0,
    status,
    lastError: a.lastError || "",
    loginNote,
    meta: { defaultBoardId: a.meta?.defaultBoardId || "", boards: a.meta?.boards || [], isOrg: !!a.meta?.isOrg },
    tokenExpiresAt: a.tokenExpiresAt,
  };
}

const BRANDS = ["LIFTLINE", "MM Spares", "KAIU", "AdmitX", "Coinwise Kids", "Wrong Door", "The Backstory"];

function guessBrand(name) {
  const n = String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const b of BRANDS) {
    if (n.includes(b.toLowerCase().replace(/[^a-z0-9]/g, ""))) return b;
  }
  if (n.includes("liftline")) return "LIFTLINE";
  if (n.includes("mmspare") || n.includes("mahavir")) return "MM Spares";
  if (n.includes("coinwise")) return "Coinwise Kids";
  if (n.includes("wrongdoor")) return "Wrong Door";
  if (n.includes("backstory")) return "The Backstory";
  return "Personal";
}
