// Every 6 hours: start the insights collector (it also renews logins that are close to ending).
// 11 minutes past 00, 06, 12, 18 UTC = 5:41 AM, 11:41 AM, 5:41 PM, 11:41 PM in India.

import { internalSecret } from "../lib/crypto.mjs";
import { env } from "../lib/util.mjs";

export default async (req, context) => {
  const siteUrl = (env("URL") || context?.site?.url || "").replace(/\/$/, "");
  if (!siteUrl) return;
  try {
    await fetch(`${siteUrl}/internal/insights`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hq-secret": internalSecret() },
      body: JSON.stringify({}),
    });
  } catch (e) {
    console.error("Insights cron error:", e);
  }
};

export const config = {
  schedule: "11 0,6,12,18 * * *",
};
