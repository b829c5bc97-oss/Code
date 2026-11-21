// On Vercel the app's own secrets (MASTER_KEY, SETUP_CODE, CRON_SECRET) live in the private
// Supabase table (secret/<NAME>) instead of the host's settings; load them once per instance.

import { getJSON } from "./store.mjs";

const NAMES = ["MASTER_KEY", "SETUP_CODE", "CRON_SECRET"];
let loading = null;

export function loadSecrets() {
  if (!loading) {
    loading = (async () => {
      for (const n of NAMES) {
        if (process.env[n]) continue;
        try {
          const rec = await getJSON(`secret/${n}`);
          if (rec?.v) process.env[n] = rec.v;
        } catch (e) {
          console.error("Could not load secret", n, e.message);
        }
      }
      if (!process.env.MASTER_KEY) loading = null; // try again next request (e.g. before the import)
    })();
  }
  return loading;
}
