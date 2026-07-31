#!/usr/bin/env node
/**
 * Run a single pipeline cycle from the command line, then exit.
 * Useful for cron-driven deployments and for a first fill of an empty database.
 */
import { closeDb, getDb } from '../db.js';
import { runCycle } from '../pipeline/run.js';

try {
  const stats = await runCycle({ db: getDb(), reason: 'cli' });
  console.log(JSON.stringify(stats, null, 2));
  closeDb();
  process.exit(0);
} catch (error) {
  console.error(`Refresh failed: ${error?.message || error}`);
  closeDb();
  process.exit(1);
}
