// Background insights collector: followers, reach, views and recent posts for every account,
// then rebuilds each account's perfect-time map.

import { collectInsights } from "../lib/jobs.mjs";
import { safeEqual, internalSecret } from "../lib/crypto.mjs";

export default async (req) => {
  if (!safeEqual(req.headers.get("x-hq-secret"), internalSecret())) return;
  let body = {};
  try {
    body = await req.json();
  } catch (_) { /* empty body */ }
  try {
    await collectInsights({ only: body.only || null });
  } catch (e) {
    console.error("Insights error", e);
  }
};

export const config = {
  path: "/internal/insights",
  background: true,
};
