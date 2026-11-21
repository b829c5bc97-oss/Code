// Runs every 5 minutes: finds posts whose time has come and hands each one to the
// background publisher (which has up to 15 minutes to upload videos).

import { runScheduler } from "../lib/jobs.mjs";
import { env } from "../lib/util.mjs";

export default async (req, context) => {
  const siteUrl = (env("URL") || context?.site?.url || "").replace(/\/$/, "");
  if (!siteUrl) {
    console.error("Scheduler: site URL unknown");
    return;
  }
  try {
    const fired = await runScheduler(siteUrl);
    if (fired.length) console.log("Scheduler sent:", fired.join(", "));
  } catch (e) {
    console.error("Scheduler error:", e);
  }
};

export const config = {
  schedule: "*/5 * * * *", // every 5 minutes (UTC; the minute doesn't depend on time zone)
};
