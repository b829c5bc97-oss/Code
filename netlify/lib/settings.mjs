// Platform app keys (from each developer site) and reminder settings.
// Stored in Blobs; secrets are encrypted. Changing them needs no redeploy.

import { getJSON, setJSON } from "./store.mjs";
import { encrypt, decrypt } from "./crypto.mjs";
import { clean } from "./util.mjs";

const KEY = "settings/apps";

// Field definitions per section. secret: true -> encrypted, never sent back to the browser.
export const SECTIONS = {
  instagram: { label: "Instagram (Meta app, Unified login)", fields: { appId: {}, appSecret: { secret: true }, configId: {} } },
  facebook: { label: "Facebook Pages (same Meta app)", fields: { appId: {}, appSecret: { secret: true }, configId: {} } },
  linkedin: {
    label: "LinkedIn",
    fields: { clientId: {}, clientSecret: { secret: true }, orgAccess: { bool: true }, version: {} },
  },
  youtube: { label: "YouTube (Google Cloud)", fields: { clientId: {}, clientSecret: { secret: true } } },
  pinterest: { label: "Pinterest", fields: { appId: {}, appSecret: { secret: true }, sandbox: { bool: true } } },
  reminders: { label: "Reminder emails (Resend)", fields: { resendKey: { secret: true }, to: {}, from: {} } },
  general: { label: "General", fields: { graphVersion: {} } },
};

const DEFAULTS = {
  linkedin: { version: "202608", orgAccess: false },
  pinterest: { sandbox: true },
  general: { graphVersion: "v25.0" },
};

async function raw() {
  return (await getJSON(KEY)) || {};
}

// Full settings with secrets decrypted — server-side use only.
export async function getSettings() {
  const r = await raw();
  const out = {};
  for (const [section, def] of Object.entries(SECTIONS)) {
    out[section] = { ...(DEFAULTS[section] || {}) };
    for (const [field, fdef] of Object.entries(def.fields)) {
      const v = r[section]?.[field];
      if (v === undefined) continue;
      out[section][field] = fdef.secret ? decrypt(v) : v;
    }
  }
  return out;
}

// Safe view for the browser.
export async function publicSettings(siteUrl) {
  const r = await raw();
  const out = {};
  for (const [section, def] of Object.entries(SECTIONS)) {
    out[section] = { label: def.label };
    for (const [field, fdef] of Object.entries(def.fields)) {
      const v = r[section]?.[field] ?? DEFAULTS[section]?.[field];
      if (fdef.secret) out[section][field + "Set"] = !!r[section]?.[field];
      else out[section][field] = v ?? (fdef.bool ? false : "");
    }
  }
  out.redirects = {
    instagram: `${siteUrl}/api/oauth/instagram/callback`,
    facebook: `${siteUrl}/api/oauth/facebook/callback`,
    linkedin: `${siteUrl}/api/oauth/linkedin/callback`,
    youtube: `${siteUrl}/api/oauth/youtube/callback`,
    pinterest: `${siteUrl}/api/oauth/pinterest/callback`,
  };
  out.siteUrl = siteUrl;
  return out;
}

export async function updateSettings(patch) {
  const r = await raw();
  for (const [section, values] of Object.entries(patch || {})) {
    const def = SECTIONS[section];
    if (!def || typeof values !== "object") continue;
    r[section] = r[section] || {};
    for (const [field, value] of Object.entries(values)) {
      const fdef = def.fields[field];
      if (!fdef) continue;
      if (fdef.secret) {
        if (value === null) delete r[section][field];
        else if (typeof value === "string" && value.trim()) r[section][field] = encrypt(value.trim());
      } else if (fdef.bool) {
        r[section][field] = !!value;
      } else {
        r[section][field] = clean(value, 300).trim();
      }
    }
  }
  await setJSON(KEY, r);
}

// Instagram and Facebook Pages run on the same Meta app, so the App ID and secret only
// need typing once: whichever section is empty borrows them from the other.
export function metaKeys(settings, platform) {
  const own = settings[platform] || {};
  const other = settings[platform === "instagram" ? "facebook" : "instagram"] || {};
  const shared = own.appId && own.appSecret ? own : other.appId && other.appSecret ? other : own;
  return { appId: shared.appId || "", appSecret: shared.appSecret || "", configId: own.configId || "" };
}

export function configured(settings, platform) {
  const s = settings[platform] || {};
  if (platform === "linkedin" || platform === "youtube") return !!(s.clientId && s.clientSecret);
  if (platform === "instagram") {
    const k = metaKeys(settings, "instagram");
    return !!(k.appId && k.appSecret && k.configId);
  }
  if (platform === "facebook") {
    const k = metaKeys(settings, "facebook");
    return !!(k.appId && k.appSecret);
  }
  return !!(s.appId && s.appSecret);
}
