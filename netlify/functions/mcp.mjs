// Claude connector: the MCP endpoint (/mcp), its OAuth sign-in (/oauth/*) and the
// discovery documents Claude reads first (/.well-known/*).

import { env, HttpError, errMessage } from "../lib/util.mjs";
import { TOOLS, callTool } from "../lib/mcp-tools.mjs";
import {
  resourceMetadata, serverMetadata, register, readAuthorizeRequest, packRequest, unpackRequest,
  approve, deny, token, checkAccess, OAuthError, needsCode,
} from "../lib/oauth.mjs";
import { logEvent } from "../lib/audit.mjs";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "cache-control": "no-store",
};

function base(req, context) {
  return (env("URL") || context?.site?.url || new URL(req.url).origin).replace(/\/$/, "");
}
function out(data, status = 200, headers = {}) {
  return new Response(data === null ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json", ...SECURITY, ...headers } });
}
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

async function formOf(req) {
  const type = req.headers.get("content-type") || "";
  const text = await req.text();
  if (type.includes("application/json")) {
    try {
      return JSON.parse(text || "{}");
    } catch (_) {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

// ---------- the approval page ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page({ clientName, tokenValue, askCode, error }) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Connect Claude to Social HQ</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F6F7F9;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:#11131A;padding:16px}
.card{background:#fff;border:1px solid #E5E7EB;border-radius:16px;padding:28px;max-width:420px;width:100%;box-shadow:0 8px 30px rgba(17,19,26,.06)}
h1{font-size:22px;margin:0 0 6px}p{margin:0 0 14px;color:#4B5160}ul{margin:0 0 18px;padding-left:20px;color:#4B5160}li{margin:2px 0}
label{display:block;font-weight:600;font-size:13px;margin:12px 0 6px}input{width:100%;font:inherit;padding:11px 12px;border:1px solid #D4D7DD;border-radius:10px}
input:focus{outline:2px solid #2848E8;border-color:#2848E8}.row{display:flex;gap:10px;margin-top:20px}
button{flex:1;font:inherit;font-weight:600;padding:12px;border-radius:10px;border:1px solid #D4D7DD;background:#fff;cursor:pointer}
button.go{background:#2848E8;border-color:#2848E8;color:#fff}.err{background:#FDECEC;color:#9B1C1C;border-radius:10px;padding:10px 12px;margin:0 0 12px}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;margin-bottom:18px}.dot{width:30px;height:30px;border-radius:9px;background:#2848E8}
</style></head><body><main class="card">
<div class="logo"><span class="dot"></span>Social HQ</div>
<h1>Let ${esc(clientName)} use Social HQ?</h1>
<p>${esc(clientName)} will be able to:</p>
<ul><li>see your accounts, plan and insights</li><li>create, change and delete scheduled posts</li></ul>
<p>It cannot see your passwords or your platform logins. You can cut it off any time in Settings → Claude.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="req" value="${esc(tokenValue)}">
<label for="pw">Your Social HQ password</label><input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>
${askCode ? `<label for="code">6-digit code from your authenticator app</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="123 456">` : ""}
<div class="row"><button type="submit" name="decision" value="deny" formnovalidate>Cancel</button><button class="go" type="submit" name="decision" value="allow">Allow</button></div>
</form></main></body></html>`;
  return new Response(html, {
    status: error ? 400 : 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...SECURITY,
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://claude.com http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

function messagePage(text, status = 400) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Social HQ</title><body style="font:16px -apple-system,sans-serif;padding:40px;max-width:520px;margin:auto;color:#11131A"><h1 style="font-size:22px">Social HQ</h1><p>${esc(text)}</p></body>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...SECURITY, "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" },
  });
}

// ---------- MCP (JSON-RPC over HTTP POST) ----------
async function rpc(msg, ctx) {
  const { id, method, params } = msg || {};
  const isNote = id === undefined || id === null;
  const reply = (result) => (isNote ? null : { jsonrpc: "2.0", id, result });
  const fail = (code, message) => (isNote ? null : { jsonrpc: "2.0", id, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return fail(-32600, "Invalid request");
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "social-hq", title: "Social HQ", version: "1.0.0" },
        instructions: "Social HQ is Pratham's own social media scheduler. All times are India time (IST). Use list_accounts first to get account ids, best_times to pick good slots, and confirm with Pratham before scheduling or deleting posts.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        const result = await callTool(name, params?.arguments || {}, ctx);
        return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 1) }], structuredContent: result });
      } catch (e) {
        return reply({ content: [{ type: "text", text: errMessage(e) }], isError: true });
      }
    }
    case "resources/list":
      return reply({ resources: [] });
    case "resources/templates/list":
      return reply({ resourceTemplates: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      if (method.startsWith("notifications/")) return null;
      return fail(-32601, `Method not found: ${method}`);
  }
}

export async function handle(req, context) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const B = base(req, context);
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // Discovery
    if (path.startsWith("/.well-known/oauth-protected-resource")) return out(resourceMetadata(B), 200, CORS);
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") return out(serverMetadata(B), 200, CORS);

    // Claude registers itself
    if (path === "/oauth/register" && req.method === "POST") {
      try {
        return out(await register(await formOf(req)), 201, CORS);
      } catch (e) {
        if (e instanceof OAuthError) return out({ error: e.code, error_description: e.message }, 400, CORS);
        throw e;
      }
    }

    // Approval page
    if (path === "/oauth/authorize" && req.method === "GET") {
      try {
        const { req: ar, client } = await readAuthorizeRequest(url.searchParams);
        return page({ clientName: client.client_name, tokenValue: packRequest(ar), askCode: await needsCode() });
      } catch (e) {
        return messagePage(errMessage(e));
      }
    }
    if (path === "/oauth/authorize" && req.method === "POST") {
      const f = await formOf(req);
      if (f.decision === "deny") return new Response(null, { status: 303, headers: { Location: await deny({ token: f.req }), ...SECURITY } });
      try {
        const r = await approve({ token: f.req, password: f.password, code: f.code }, req);
        return new Response(null, { status: 303, headers: { Location: r.redirect, ...SECURITY } });
      } catch (e) {
        let clientName = "Claude";
        try {
          unpackRequest(f.req);
        } catch (err) {
          return messagePage(errMessage(err));
        }
        return page({ clientName, tokenValue: f.req, askCode: await needsCode(), error: errMessage(e) });
      }
    }

    // Keys
    if (path === "/oauth/token" && req.method === "POST") {
      try {
        return out(await token(await formOf(req), req), 200, CORS);
      } catch (e) {
        if (e instanceof OAuthError) return out({ error: e.code, error_description: e.message }, 400, CORS);
        throw e;
      }
    }

    // MCP itself
    if (path === "/mcp") {
      const challenge = { "WWW-Authenticate": `Bearer realm="Social HQ", resource_metadata="${B}/.well-known/oauth-protected-resource"` };
      const auth = req.headers.get("authorization") || "";
      const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
      const grant = bearer ? await checkAccess(bearer) : null;
      if (!grant) return out({ error: "invalid_token", error_description: "Connect Social HQ from Claude's settings." }, 401, { ...challenge, ...CORS });
      if (req.method === "GET") return new Response(null, { status: 405, headers: { Allow: "POST", ...SECURITY } });
      if (req.method === "DELETE") return new Response(null, { status: 204, headers: SECURITY });
      if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST", ...SECURITY } });
      let body;
      try {
        body = JSON.parse(await req.text());
      } catch (_) {
        return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
      }
      const ctx = { req, grant, siteUrl: B };
      if (Array.isArray(body)) {
        const replies = (await Promise.all(body.map((m) => rpc(m, ctx)))).filter(Boolean);
        return replies.length ? out(replies, 200, CORS) : new Response(null, { status: 202, headers: CORS });
      }
      const r = await rpc(body, ctx);
      return r ? out(r, 200, CORS) : new Response(null, { status: 202, headers: CORS });
    }

    return out({ error: "Not found" }, 404);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error(e);
    if (status === 429 || status === 403) await logEvent("security", `Blocked request to ${path}: ${errMessage(e)}`, req);
    return out({ error: errMessage(e) }, status);
  }
}

export default handle;

export const config = {
  path: ["/mcp", "/oauth/*", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/*", "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"],
};
