import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && !process.env.JARVIS_SKIP_DOTENV) process.loadEnvFile(envFile);

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const dataDir = env.JARVIS_DATA_DIR ? path.resolve(env.JARVIS_DATA_DIR) : path.join(ROOT, 'data');

/**
 * Encryption key for OAuth tokens at rest. In production it must come from the
 * environment; in development we generate one and keep it in data/.secret so
 * restarts can still decrypt stored tokens.
 */
function loadSecret() {
  if (env.JARVIS_SECRET) return env.JARVIS_SECRET;
  if (isProd) throw new Error('JARVIS_SECRET must be set in production (32+ random characters).');
  if (env.JARVIS_DB === ':memory:') return crypto.randomBytes(32).toString('hex');
  const file = path.join(dataDir, '.secret');
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

export const config = {
  isProd,
  port: Number(env.PORT || 3000),
  baseUrl: (env.JARVIS_BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  dbFile: env.JARVIS_DB || path.join(dataDir, 'jarvis.db'),
  secret: loadSecret(),
  sessionDays: Number(env.JARVIS_SESSION_DAYS || 14),
  allowSignup: env.JARVIS_ALLOW_SIGNUP !== 'false',
  scheduler: {
    enabled: env.JARVIS_DISABLE_SCHEDULER !== '1',
    intervalMs: Number(env.JARVIS_SCHEDULER_INTERVAL_MS || 30000),
  },
  ai: {
    provider: (env.AI_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : env.OPENAI_API_KEY ? 'openai' : 'none')).toLowerCase(),
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    anthropicEffort: env.ANTHROPIC_EFFORT || 'low',
    anthropicFallbacks: env.ANTHROPIC_FALLBACKS !== 'false',
    openaiKey: env.OPENAI_API_KEY || '',
    openaiBaseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    openaiModel: env.OPENAI_MODEL || '',
    maxToolRounds: Number(env.AI_MAX_TOOL_ROUNDS || 8),
  },
  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
  },
  microsoft: {
    clientId: env.MICROSOFT_CLIENT_ID || '',
    clientSecret: env.MICROSOFT_CLIENT_SECRET || '',
    tenant: env.MICROSOFT_TENANT || 'common',
  },
  search: {
    provider: (env.SEARCH_PROVIDER || (env.TAVILY_API_KEY ? 'tavily' : env.BRAVE_API_KEY ? 'brave' : 'none')).toLowerCase(),
    tavilyKey: env.TAVILY_API_KEY || '',
    braveKey: env.BRAVE_API_KEY || '',
  },
};
