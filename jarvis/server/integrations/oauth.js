import crypto from 'node:crypto';
import { db, id, nowIso, audit } from '../db.js';
import { config } from '../config.js';
import { encrypt, decrypt, randomToken } from '../security.js';
import { HttpError } from '../http.js';

/**
 * Provider definitions for official OAuth 2.0 authorisation-code flows (with PKCE).
 * Endpoints and scopes follow Google Identity and Microsoft identity platform docs.
 */
export const PROVIDERS = {
  google: {
    label: 'Google (Calendar + Gmail)',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'],
    extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    creds: () => config.google,
    setup: [
      'Open Google Cloud Console → APIs & Services, create (or pick) a project.',
      'Enable the "Google Calendar API" and "Gmail API".',
      'Configure the OAuth consent screen (External or Internal). Add your Google account as a test user while the app is in testing.',
      'Create credentials → OAuth client ID → "Web application".',
      'Add the authorised redirect URI shown below.',
      'Put the client ID and secret in .env as GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart JARVIS.',
    ],
  },
  microsoft: {
    label: 'Microsoft (Outlook Calendar + Mail)',
    authUrl: () => `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/authorize`,
    tokenUrl: () => `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/token`,
    scopes: ['openid', 'email', 'offline_access', 'User.Read', 'Calendars.Read', 'Mail.ReadWrite', 'Mail.Send'],
    extraAuthParams: { response_mode: 'query' },
    creds: () => config.microsoft,
    setup: [
      'Open Microsoft Entra admin center → App registrations → New registration.',
      'Supported account types: choose personal + work accounts (or your organisation only).',
      'Add a "Web" platform redirect URI using the value shown below.',
      'API permissions → Microsoft Graph (delegated): User.Read, Calendars.Read, Mail.ReadWrite, Mail.Send, offline_access.',
      'Certificates & secrets → New client secret.',
      'Put MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET (and MICROSOFT_TENANT if not "common") in .env, then restart JARVIS.',
    ],
  },
};

const val = (v) => (typeof v === 'function' ? v() : v);
export const redirectUri = (provider) => `${config.baseUrl}/api/integrations/${provider}/callback`;
export const isConfigured = (provider) => {
  const c = PROVIDERS[provider]?.creds();
  return !!(c?.clientId && c?.clientSecret);
};

export function startAuth(userId, provider) {
  const p = PROVIDERS[provider];
  if (!p) throw new HttpError(404, 'Unknown provider.');
  if (!isConfigured(provider)) throw new HttpError(400, `${p.label} is not configured on this server. Follow the setup steps on the Integrations page.`);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(new Date(Date.now() - 15 * 60e3).toISOString());
  db.prepare('INSERT INTO oauth_states (state, user_id, provider, verifier, created_at) VALUES (?,?,?,?,?)').run(state, userId, provider, verifier, nowIso());
  const params = new URLSearchParams({
    client_id: p.creds().clientId, redirect_uri: redirectUri(provider), response_type: 'code', scope: p.scopes.join(' '),
    state, code_challenge: challenge, code_challenge_method: 'S256', ...p.extraAuthParams,
  });
  return `${val(p.authUrl)}?${params}`;
}

async function tokenRequest(provider, body) {
  const p = PROVIDERS[provider];
  const res = await fetch(val(p.tokenUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: p.creds().clientId, client_secret: p.creds().clientSecret, ...body }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `Token exchange failed: ${json.error_description || json.error || res.status}`);
  return json;
}

function emailFromIdToken(idToken) {
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()).email || null;
  } catch {
    return null;
  }
}

export async function finishAuth(provider, { code, state, error }) {
  const row = db.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider = ?').get(state || '', provider);
  if (row) db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  if (!row || Date.now() - Date.parse(row.created_at) > 15 * 60e3) throw new HttpError(400, 'This sign-in link expired or is invalid. Start the connection again.');
  if (error) throw new HttpError(400, `The provider returned: ${error}`);
  const tok = await tokenRequest(provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(provider), code_verifier: row.verifier });
  const expires = new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString();
  db.prepare(`INSERT INTO integrations (id, user_id, provider, status, scopes, access_token_enc, refresh_token_enc, expires_at, account_email, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id, provider) DO UPDATE SET status = 'connected', scopes = excluded.scopes, access_token_enc = excluded.access_token_enc,
    refresh_token_enc = COALESCE(excluded.refresh_token_enc, integrations.refresh_token_enc), expires_at = excluded.expires_at, account_email = excluded.account_email, last_error = NULL`)
    .run(id(), row.user_id, provider, 'connected', tok.scope || PROVIDERS[provider].scopes.join(' '), encrypt(tok.access_token), tok.refresh_token ? encrypt(tok.refresh_token) : null, expires, emailFromIdToken(tok.id_token || ''), nowIso());
  audit(row.user_id, 'user', 'connect', 'integration', provider);
  return row.user_id;
}

export function getIntegration(userId, provider) {
  return db.prepare('SELECT * FROM integrations WHERE user_id = ? AND provider = ?').get(userId, provider);
}

/** A valid access token, refreshing when it is about to expire. */
export async function accessToken(userId, provider) {
  const row = getIntegration(userId, provider);
  if (!row || row.status !== 'connected') throw new HttpError(400, `${PROVIDERS[provider].label} is not connected.`);
  if (Date.parse(row.expires_at) - Date.now() > 60e3) return decrypt(row.access_token_enc);
  const refresh = decrypt(row.refresh_token_enc);
  if (!refresh) {
    db.prepare("UPDATE integrations SET status = 'expired', last_error = ? WHERE id = ?").run('Access expired; reconnect.', row.id);
    throw new HttpError(401, 'Access to your account expired. Reconnect it on the Integrations page.');
  }
  try {
    const tok = await tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: refresh });
    db.prepare('UPDATE integrations SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc), expires_at = ?, last_error = NULL WHERE id = ?')
      .run(encrypt(tok.access_token), tok.refresh_token ? encrypt(tok.refresh_token) : null, new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(), row.id);
    return tok.access_token;
  } catch (e) {
    db.prepare("UPDATE integrations SET status = 'error', last_error = ? WHERE id = ?").run(e.message, row.id);
    throw e;
  }
}

export function disconnect(userId, provider) {
  db.prepare('DELETE FROM integrations WHERE user_id = ? AND provider = ?').run(userId, provider);
  audit(userId, 'user', 'disconnect', 'integration', provider);
}

export async function apiFetch(userId, provider, url, init = {}) {
  const token = await accessToken(userId, provider);
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
  if (res.status === 429) throw new HttpError(429, 'The provider is rate-limiting requests. Try again shortly.');
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = json.error?.message || json.error_description || `HTTP ${res.status}`;
    db.prepare('UPDATE integrations SET last_error = ? WHERE user_id = ? AND provider = ?').run(msg, userId, provider);
    throw new HttpError(502, `${PROVIDERS[provider].label}: ${msg}`);
  }
  return json;
}
