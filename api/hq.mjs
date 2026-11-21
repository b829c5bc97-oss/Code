// Social HQ on Vercel: one function serves every dynamic path. vercel.json sends
// /api/*, /m/*, /mcp, /oauth/*, /.well-known/* and /internal/* here (original path in ?__p=).
// Static files (public/) are served by Vercel directly.

import { waitUntil } from "@vercel/functions";
import { handle as apiHandle } from "../netlify/functions/api.mjs";
import { handle as mcpHandle } from "../netlify/functions/mcp.mjs";
import { runScheduler, publishPost, collectInsights } from "../netlify/lib/jobs.mjs";
import { runAutoReplies } from "../netlify/lib/autoreply.mjs";
import { safeEqual, internalSecret } from "../netlify/lib/crypto.mjs";
import { env } from "../netlify/lib/util.mjs";

export const config = { maxDuration: 300 };

function siteUrl(req) {
  return (env("URL") || new URL(req.url).origin).replace(/\/$/, "");
}

function original(req) {
  const u = new URL(req.url);
  const p = u.searchParams.get("__p");
  if (p) {
    u.searchParams.delete("__p");
    u.pathname = p.startsWith("/") ? p : "/" + p;
  }
  const init = { method: req.method, headers: req.headers };
  if (!["GET", "HEAD"].includes(req.method)) {
    init.body = req.body;
    init.duplex = "half";
  }
  return new Request(u, init);
}

const ok = (body = { ok: true }, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function internal(req, path) {
  const site = siteUrl(req);
  // Timer calls from Supabase pg_cron (secret header), answered at once; the work carries on.
  if (path.startsWith("/internal/cron/")) {
    const secret = env("CRON_SECRET");
    if (!secret || !safeEqual(req.headers.get("x-cron-secret"), secret)) return ok({ error: "no" }, 403);
    const job = path.split("/").pop();
    const work = {
      scheduler: () => runScheduler(site),
      autoreply: () => runAutoReplies(),
      insights: () => collectInsights({}),
    }[job];
    if (!work) return ok({ error: "unknown job" }, 404);
    waitUntil(work().catch((e) => console.error(`Cron ${job} error`, e)));
    return ok({ started: job }, 202);
  }
  if (!safeEqual(req.headers.get("x-hq-secret"), internalSecret())) return ok({ error: "no" }, 403);
  let body = {};
  try { body = await req.json(); } catch (_) { /* empty */ }
  if (path === "/internal/publish") {
    if (!body.postId) return ok({ error: "postId" }, 400);
    waitUntil(publishPost(body.postId, site).catch((e) => console.error("Publish error", body.postId, e)));
    return ok({ started: body.postId }, 202);
  }
  if (path === "/internal/insights") {
    waitUntil(collectInsights({ only: body.only || null }).catch((e) => console.error("Insights error", e)));
    return ok({ started: "insights" }, 202);
  }
  return ok({ error: "not found" }, 404);
}

async function handler(req) {
  const r = original(req);
  const path = new URL(r.url).pathname;
  const context = { site: { url: siteUrl(r) } };
  if (path.startsWith("/internal/")) return internal(r, path);
  if (path === "/mcp" || path.startsWith("/oauth/") || path.startsWith("/.well-known/")) return mcpHandle(r, context);
  return apiHandle(r, context);
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
