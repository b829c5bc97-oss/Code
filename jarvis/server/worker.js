// Standalone scheduler process. Use this when the web server runs with
// JARVIS_DISABLE_SCHEDULER=1 (e.g. several web replicas, or a serverless host),
// so exactly one process delivers reminders.
import { startScheduler, schedulerState } from './scheduler.js';
import { config } from './config.js';

config.scheduler.enabled = true;
startScheduler();
console.log(`[jarvis-worker] scheduler running every ${config.scheduler.intervalMs / 1000}s against ${config.dbFile}`);
setInterval(() => {
  if (schedulerState.lastError) console.error('[jarvis-worker] last error:', schedulerState.lastError);
}, 60000);
