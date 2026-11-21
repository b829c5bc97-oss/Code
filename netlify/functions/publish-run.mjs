// Background publisher: posts one scheduled post to all its accounts. Up to 15 minutes.

import { publishPost } from "../lib/jobs.mjs";
import { safeEqual, internalSecret } from "../lib/crypto.mjs";
import { env } from "../lib/util.mjs";

export default async (req, context) => {
  if (!safeEqual(req.headers.get("x-hq-secret"), internalSecret())) return;
  let body = {};
  try {
    body = await req.json();
  } catch (_) {
    return;
  }
  if (!body.postId) return;
  const siteUrl = (env("URL") || context?.site?.url || new URL(req.url).origin).replace(/\/$/, "");
  try {
    await publishPost(body.postId, siteUrl);
  } catch (e) {
    console.error("Publish error", body.postId, e);
  }
};

export const config = {
  path: "/internal/publish",
  background: true,
};
