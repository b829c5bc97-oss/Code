// Profile pictures, kept on Social HQ's own storage: Instagram and Facebook picture links
// expire after a few days, so a saved copy keeps every account's photo showing.

import crypto from "node:crypto";
import { putChunk, getChunk } from "./store.mjs";
import { listAccounts, saveAccount } from "./accounts.mjs";
import { getSettings } from "./settings.mjs";
import { platforms } from "./platforms/index.mjs";

export async function cacheAvatar(account, url) {
  if (!url || !/^https:\/\//.test(url)) return false;
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const type = res.headers.get("content-type") || "image/jpeg";
    if (!type.startsWith("image/")) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 3 * 1024 * 1024 || buf.length < 100) return false;
    const v = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 10);
    if (account.avatarCached !== v) {
      await putChunk(`av/${account.id}`, buf);
      account.avatarCached = v;
      account.avatarType = type;
    }
    account.avatar = url;
    account.avatarAt = new Date().toISOString();
    return true;
  } catch (_) {
    return false;
  }
}

export async function readAvatar(id) {
  const buf = await getChunk(`av/${id}`);
  return buf ? Buffer.from(buf) : null;
}

// Fetch fresh profile pictures for every connected account.
export async function refreshAvatars({ impl = platforms } = {}) {
  const settings = await getSettings();
  const out = [];
  for (const a of await listAccounts()) {
    const p = impl[a.platform];
    if (!p?.profile) continue;
    try {
      const { account, changed } = await p.ensureToken({ account: a, settings });
      const prof = await p.profile({ settings, account });
      const ok = await cacheAvatar(account, prof.avatar);
      if (ok || changed) await saveAccount(account);
      out.push({ id: a.id, ok });
    } catch (e) {
      out.push({ id: a.id, ok: false, error: e.message });
    }
  }
  return out;
}
