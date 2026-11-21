// Every 3 minutes: answer new Instagram comments that match an auto-reply rule.

import { runAutoReplies } from "../lib/autoreply.mjs";

export default async () => {
  try {
    await runAutoReplies();
  } catch (e) {
    console.error("Auto-reply error:", e);
  }
};

export const config = {
  schedule: "*/3 * * * *",
};
