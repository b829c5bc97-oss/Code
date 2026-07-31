import { config } from '../config.js';
import { logger } from '../lib/log.js';
import { structured, isAvailable } from './client.js';
import { VERIFY_SCHEMA, VERIFY_SYSTEM } from './prompts.js';

const log = logger('verify');

/**
 * Audit a generated briefing against the excerpts it was written from.
 *
 * This is the accuracy backstop. The writing pass is optimising for a readable
 * briefing; a separate pass with one narrow question — "is this actually in the
 * text?" — catches the drift that produces confident, plausible, wrong sentences.
 *
 * Returns { findings, checked } where each finding is
 * { index, verdict: supported|unsupported|overstated, reason }.
 */
export async function verifyClaims({ claims, sourcePack }) {
  if (!isAvailable() || claims.length === 0) return { findings: [], checked: 0 };

  const numbered = claims.map((claim, index) => `${index}. ${claim}`).join('\n');
  const user = [
    'SOURCE EXCERPTS',
    '===============',
    sourcePack,
    '',
    'CLAIMS TO CHECK',
    '===============',
    numbered,
    '',
    'Return one finding per claim, using the claim number as "index".',
  ].join('\n');

  try {
    const result = await structured({
      system: VERIFY_SYSTEM,
      user,
      schema: VERIFY_SCHEMA,
      effort: config.ai.utilityEffort,
      maxTokens: 4000,
      label: `verify(${claims.length} claims)`,
    });
    const findings = (result.findings ?? []).filter(
      (finding) => Number.isInteger(finding.index) && finding.index >= 0 && finding.index < claims.length,
    );
    return { findings, checked: claims.length };
  } catch (error) {
    // A failed audit must not block publication — the briefing is simply marked
    // unverified so the UI can say so honestly.
    log.warn(`verification unavailable: ${error.message}`);
    return { findings: [], checked: 0, error: error.message };
  }
}
