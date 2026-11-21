// Lets Claude connect to Social HQ (OAuth 2.1 with PKCE, as the MCP standard asks).
// Claude registers itself, sends you to Social HQ's approval page, and only gets a key
// after you type your Social HQ password (and 6-digit code when 2-step login is on).
// Only Claude's own return addresses are accepted. Every connection can be cut off.

import crypto from "node:crypto";
import { getJSON, setJSON, del, listKeys, getMany } from "./store.mjs";
import { sign, verify, randomId } from "./crypto.mjs";
import { HttpError, clean } from "./util.mjs";
import { verifyOwner, securityStatus } from "./auth.mjs";
import { logEvent } from "./audit.mjs";

const ACCESS_MIN = 60;
const REFRESH_DAYS = 60;
const CODE_MIN = 5;

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

export function allowedRedirect(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:" && ["claude.ai", "claude.com"].includes(u.hostname)) return true;
    // Claude Code and Claude Desktop on your own computer return to a local address.
    if (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

export function resourceMetadata(base) {
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    resource_name: "Social HQ",
  };
}

export function serverMetadata(base) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["social-hq"],
    service_documentation: base,
  };
}

// ----- client registration -----
export async function register(body) {
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.map((u) => clean(u, 500)) : [];
  if (!uris.length) throw new OAuthError("invalid_redirect_uri", "redirect_uris is required.");
  const bad = uris.filter((u) => !allowedRedirect(u));
  if (bad.length) throw new OAuthError("invalid_redirect_uri", "Social HQ only connects to Claude.");
  const id = "hqc_" + randomId(12);
  const client = { client_id: id, client_name: clean(body.client_name || "Claude", 80), redirect_uris: uris, createdAt: new Date().toISOString() };
  await setJSON(`oauth/client/${id}`, client);
  return {
    client_id: id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client.client_name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export class OAuthError extends Error {
  constructor(code, description, status = 400) {
    super(description);
    this.code = code;
    this.status = status;
  }
}

// ----- approval page -----
export async function readAuthorizeRequest(params) {
  const p = (k) => clean(params.get ? params.get(k) : params[k], 1000);
  const req = {
    client_id: p("client_id"),
    redirect_uri: p("redirect_uri"),
    response_type: p("response_type"),
    code_challenge: p("code_challenge"),
    code_challenge_method: p("code_challenge_method") || "S256",
    state: p("state"),
    scope: p("scope"),
    resource: p("resource"),
  };
  const client = req.client_id ? await getJSON(`oauth/client/${req.client_id}`) : null;
  if (!client) throw new HttpError(400, "This connection request is not from a registered Claude app. Start again from Claude.");
  if (!client.redirect_uris.includes(req.redirect_uri)) throw new HttpError(400, "The return address does not match. Start again from Claude.");
  if (req.response_type !== "code") throw new HttpError(400, "Unsupported request.");
  if (!req.code_challenge || req.code_challenge_method !== "S256") throw new HttpError(400, "Missing PKCE challenge.");
  return { req, client };
}

export function packRequest(req) {
  return sign({ ...req, exp: Date.now() + 15 * 60000 }, "oauth-consent");
}

export function unpackRequest(token) {
  const r = verify(token, "oauth-consent");
  if (!r) throw new HttpError(400, "This approval page expired. Start again from Claude.");
  return r;
}

export function redirectWith(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
}

export async function approve({ token, password, code }, req) {
  const r = unpackRequest(token);
  const client = await getJSON(`oauth/client/${r.client_id}`);
  if (!client || !client.redirect_uris.includes(r.redirect_uri)) throw new HttpError(400, "Start again from Claude.");
  try {
    await verifyOwner({ password, code });
  } catch (e) {
    await logEvent("security", `Wrong password or code when approving ${client.client_name}`, req);
    throw e;
  }
  const authCode = randomId(32);
  await setJSON(`oauth/code/${sha(authCode)}`, {
    client_id: r.client_id,
    client_name: client.client_name,
    redirect_uri: r.redirect_uri,
    challenge: r.code_challenge,
    exp: Date.now() + CODE_MIN * 60000,
  });
  return { redirect: redirectWith(r.redirect_uri, { code: authCode, state: r.state }), clientName: client.client_name };
}

export async function deny({ token }) {
  const r = unpackRequest(token);
  return redirectWith(r.redirect_uri, { error: "access_denied", error_description: "You said no in Social HQ.", state: r.state });
}

// ----- tokens -----
function accessToken(grant) {
  return sign({ t: "mcp", g: grant.id, exp: Date.now() + ACCESS_MIN * 60000 }, "mcp-access");
}

async function issue(grant) {
  const refresh = randomId(32);
  grant.refreshHash = sha(refresh);
  grant.refreshExp = Date.now() + REFRESH_DAYS * 86400000;
  await setJSON(`oauth/grant/${grant.id}`, grant);
  return {
    access_token: accessToken(grant),
    token_type: "Bearer",
    expires_in: ACCESS_MIN * 60,
    refresh_token: refresh,
    scope: "social-hq",
  };
}

export async function token(form, req) {
  const f = (k) => (form.get ? form.get(k) : form[k]) || "";
  const grantType = f("grant_type");
  if (grantType === "authorization_code") {
    const code = f("code");
    const key = `oauth/code/${sha(code)}`;
    const rec = code ? await getJSON(key) : null;
    if (rec) await del(key); // one use only
    if (!rec || rec.exp < Date.now()) throw new OAuthError("invalid_grant", "The code expired. Connect again from Claude.");
    if (f("client_id") && f("client_id") !== rec.client_id) throw new OAuthError("invalid_grant", "Wrong client.");
    if (f("redirect_uri") && f("redirect_uri") !== rec.redirect_uri) throw new OAuthError("invalid_grant", "Wrong return address.");
    const verifier = f("code_verifier");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    if (!verifier || challenge !== rec.challenge) throw new OAuthError("invalid_grant", "PKCE check failed.");
    const grant = { id: randomId(12), clientId: rec.client_id, clientName: rec.client_name, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() };
    await logEvent("claude", `${rec.client_name} was connected to Social HQ`, req);
    return await issue(grant);
  }
  if (grantType === "refresh_token") {
    const refresh = f("refresh_token");
    const h = sha(refresh);
    const keys = await listKeys("oauth/grant/");
    const grants = (await getMany(keys)).filter(Boolean);
    const grant = grants.find((g) => g.refreshHash === h);
    if (!grant || grant.refreshExp < Date.now()) throw new OAuthError("invalid_grant", "This connection ended. Connect again from Claude.");
    if (f("client_id") && f("client_id") !== grant.clientId) throw new OAuthError("invalid_grant", "Wrong client.");
    return await issue(grant);
  }
  throw new OAuthError("unsupported_grant_type", "Unsupported grant type.");
}

// Checks a key Claude sends with each request. Returns the connection, or null.
export async function checkAccess(bearer) {
  const p = verify(bearer, "mcp-access");
  if (!p || p.t !== "mcp") return null;
  const grant = await getJSON(`oauth/grant/${p.g}`);
  if (!grant) return null; // cut off in Settings
  if (!grant.lastUsedAt || Date.now() - new Date(grant.lastUsedAt).getTime() > 10 * 60000) {
    grant.lastUsedAt = new Date().toISOString();
    await setJSON(`oauth/grant/${grant.id}`, grant);
  }
  return grant;
}

export async function listConnections() {
  const keys = await listKeys("oauth/grant/");
  return (await getMany(keys))
    .filter(Boolean)
    .map((g) => ({ id: g.id, name: g.clientName, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt }))
    .sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)));
}

export async function revokeConnection(id) {
  if (id === "all") {
    for (const k of await listKeys("oauth/grant/")) await del(k);
    return;
  }
  await del(`oauth/grant/${clean(id, 40)}`);
}

export async function needsCode() {
  return (await securityStatus()).twoStep;
}
