import Anthropic from '@anthropic-ai/sdk';
import { aiEnabled, config } from '../config.js';
import { logger } from '../lib/log.js';

const log = logger('ai');

let client;

function getClient() {
  if (!aiEnabled()) return null;
  if (!client) {
    client = new Anthropic({
      apiKey: config.ai.apiKey,
      maxRetries: config.ai.maxRetries,
      timeout: config.ai.requestTimeoutMs,
    });
  }
  return client;
}

/** Running token totals, surfaced on /api/status so cost is never a mystery. */
export const usage = {
  calls: 0,
  failures: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

export function isAvailable() {
  return aiEnabled();
}

export class AiError extends Error {
  constructor(message, { cause, kind = 'error' } = {}) {
    super(message);
    this.name = 'AiError';
    this.cause = cause;
    this.kind = kind;
  }
}

/**
 * One structured-JSON call to Claude.
 *
 * `system` is passed as a cacheable block: every summarization in a cycle shares
 * the same lengthy grounding rules, so caching the prefix keeps repeat calls
 * cheap. The volatile source material always goes in the user turn, after the
 * cache breakpoint.
 */
export async function structured({
  system,
  user,
  schema,
  effort = config.ai.utilityEffort,
  maxTokens = 8000,
  label = 'call',
}) {
  const anthropic = getClient();
  if (!anthropic) throw new AiError('ANTHROPIC_API_KEY is not configured', { kind: 'disabled' });

  const startedAt = Date.now();
  let message;
  try {
    // Streaming avoids HTTP timeouts on longer generations; thinking is on by
    // default on this model and shares the max_tokens budget with the answer.
    message = await anthropic.messages
      .stream({
        model: config.ai.model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        output_config: {
          effort,
          format: { type: 'json_schema', schema },
        },
        messages: [{ role: 'user', content: user }],
      })
      .finalMessage();
  } catch (error) {
    usage.failures += 1;
    throw new AiError(`${label} failed: ${error?.message || error}`, { cause: error });
  }

  usage.calls += 1;
  usage.inputTokens += message.usage?.input_tokens ?? 0;
  usage.outputTokens += message.usage?.output_tokens ?? 0;
  usage.cacheReadTokens += message.usage?.cache_read_input_tokens ?? 0;
  usage.cacheCreationTokens += message.usage?.cache_creation_input_tokens ?? 0;

  if (message.stop_reason === 'refusal') {
    throw new AiError(`${label} was declined by safety classifiers`, { kind: 'refusal' });
  }
  if (message.stop_reason === 'max_tokens') {
    throw new AiError(`${label} hit the output cap before finishing`, { kind: 'truncated' });
  }

  const text = message.content.find((block) => block.type === 'text')?.text;
  if (!text) throw new AiError(`${label} returned no text block`, { kind: 'empty' });

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AiError(`${label} returned unparsable JSON: ${error.message}`, { kind: 'parse' });
  }

  log.debug(
    `${label} ok in ${Date.now() - startedAt}ms ` +
    `(in ${message.usage?.input_tokens ?? 0}, out ${message.usage?.output_tokens ?? 0}, ` +
    `cache read ${message.usage?.cache_read_input_tokens ?? 0})`,
  );
  return parsed;
}
