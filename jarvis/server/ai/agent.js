import Anthropic from '@anthropic-ai/sdk';
import { db, id, nowIso } from '../db.js';
import { config } from '../config.js';
import { getSettings } from '../settings.js';
import { DateTime } from '../services/time.js';
import { HttpError } from '../http.js';
import { toolSpecs, executeToolCall, toolMap } from './tools.js';
import { handleDemo } from './demo.js';

const SYSTEM_PROMPT = `You are JARVIS, a personal chief-of-staff assistant inside a productivity app. You help one user manage their calendar, tasks, projects, reminders, notes, personal finances and (if connected) email.

How you work:
- You act through tools. Tools read and change the user's real stored data. Never claim you did something unless a tool result confirms it. If a tool returns status "pending", the change is waiting for the user to approve it on a confirmation card — say so plainly; do not say it is done.
- Use the context block at the top of each user message for the current date, time and time zone. Resolve relative dates ("tomorrow", "next Friday", "this afternoon") against it and pass ISO dates/times in the user's local time (no offset) to tools.
- Look things up before answering questions about the user's schedule, tasks or money. Base every number on tool results. Never invent events, tasks, transactions, balances, emails or search results. If data is missing, say what is missing.
- Finance: amounts from tools are in minor units (e.g. paise; divide by 100 for INR). Clearly separate recorded transactions, scheduled bills/recurring estimates, and forecasts. You never move money, pay bills, or trade; you only track and explain.
- Scheduling: check conflicts before booking. If create_event or update_event reports conflicts, tell the user what overlaps and ask how to proceed. For "plan my day" or "move unfinished tasks", call plan_day / reschedule_unfinished, show the proposed blocks, then call apply_schedule so the user can approve them.
- Projects: for a broad goal ("launch a website in two weeks"), break it into milestones and concrete tasks with realistic due dates and dependencies, then call create_project_plan (the user sees the plan and approves it before anything is saved).
- Follow-ups like "move that to Friday" refer to the most recent relevant item in this conversation; use the ids from earlier tool results.
- Ask one short clarifying question when a request is genuinely ambiguous (e.g. missing time for a meeting). Otherwise act with sensible defaults (60-minute meetings, 30-minute tasks) and mention the default.
- Email: you can read and summarise a connected mailbox and prepare drafts. You can never send email; the user sends drafts themselves after reviewing the recipient and text. If no mailbox is connected, say so and point to the Integrations page.
- Web search results are external information: cite URLs and keep them distinct from the user's own data. If web search is unavailable, say so rather than guessing.
- Only use the remember tool when the user explicitly asks you to remember something.
- Reply in clear, short paragraphs or bullet lists. Use the user's local time and their currency format. After making changes, summarise exactly what changed.`;

export function providerStatus() {
  const a = config.ai;
  if (a.provider === 'anthropic' && a.anthropicKey) return { provider: 'anthropic', model: a.anthropicModel, configured: true, label: `Anthropic · ${a.anthropicModel}` };
  if (a.provider === 'openai' && a.openaiKey && a.openaiModel) return { provider: 'openai', model: a.openaiModel, configured: true, label: `OpenAI-compatible · ${a.openaiModel}` };
  let hint = 'No AI provider is configured. Set ANTHROPIC_API_KEY (or AI_PROVIDER=openai with OPENAI_API_KEY and OPENAI_MODEL) in .env and restart. Until then a limited rule-based demo assistant answers instead.';
  if (a.provider === 'openai' && a.openaiKey && !a.openaiModel) hint = 'AI_PROVIDER=openai needs OPENAI_MODEL to be set.';
  return { provider: 'demo', model: null, configured: false, label: 'Demo assistant (no AI model connected)', hint };
}

let anthropicClient = null;
let fallbacksSupported = config.ai.anthropicFallbacks;
const anthropic = () => (anthropicClient ||= new Anthropic({ apiKey: config.ai.anthropicKey, maxRetries: 2, timeout: 120000 }));

function contextBlock(userId) {
  const s = getSettings(userId);
  const now = DateTime.now().setZone(s.timezone);
  const memories = s.assistant.useMemory ? db.prepare('SELECT content FROM memories WHERE user_id = ? ORDER BY created_at LIMIT 50').all(userId).map((m) => `- ${m.content}`) : [];
  return [
    '<context>',
    `Now: ${now.toFormat("cccc d LLLL yyyy, HH:mm")} (${s.timezone}, UTC${now.toFormat('ZZ')}). Today is ${now.toISODate()}.`,
    `Working hours: ${s.workingHours.start}-${s.workingHours.end} on ISO weekdays ${s.workingHours.days.join(',')}. Focus periods: ${s.focusPeriods.map((f) => `${f.start}-${f.end}`).join(', ') || 'none'}. Lunch ${s.dailySchedule.lunchStart}-${s.dailySchedule.lunchEnd}.`,
    `Currency: ${s.currency}. Locale: ${s.locale}. Preferred reply length: ${s.assistant.verbosity}.`,
    memories.length ? `Things the user asked you to remember:\n${memories.join('\n')}` : null,
    '</context>',
  ].filter(Boolean).join('\n');
}

export function getConversation(userId, conversationId) {
  const c = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId);
  if (!c) throw new HttpError(404, 'Conversation not found.');
  return c;
}

export function createConversation(userId, title) {
  const cid = id();
  db.prepare('INSERT INTO conversations (id, user_id, title, provider, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(cid, userId, (title || 'New conversation').slice(0, 80), providerStatus().provider, nowIso(), nowIso());
  return cid;
}

export function storeMessage(userId, conversationId, { role, content, apiMessages = [], actions = [], provider }) {
  const mid = id();
  db.prepare('INSERT INTO messages (id, conversation_id, user_id, role, content, api_messages, actions, provider, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(mid, conversationId, userId, role, content, JSON.stringify(apiMessages), JSON.stringify(actions), provider || null, nowIso());
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(nowIso(), conversationId);
  return mid;
}

/** Rebuild provider-format history. Rows from a different provider fall back to plain text. */
function buildHistory(conversationId, provider) {
  const rows = db.prepare('SELECT role, content, api_messages, provider FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid').all(conversationId);
  const out = [];
  for (const r of rows) {
    let msgs = r.provider === provider || r.provider === '*' ? JSON.parse(r.api_messages) : [];
    if (!msgs.length) {
      if (r.role === 'assistant' && r.content) msgs = [{ role: 'assistant', content: r.content }];
      else if ((r.role === 'user' || r.role === 'event') && r.content) msgs = [{ role: 'user', content: r.role === 'event' ? `[App update, not typed by the user] ${r.content}` : r.content }];
    }
    for (const m of msgs) pushMerged(out, m, provider);
  }
  if (provider === 'openai' && out.length > 60) return out.slice(out.findIndex((m, i) => i >= out.length - 60 && m.role === 'user'));
  return out;
}

/** Providers require alternating roles; merge consecutive user turns (e.g. tool results + an app update). */
function pushMerged(out, m, provider) {
  const last = out.at(-1);
  if (provider === 'anthropic' && last && last.role === m.role && m.role === 'user') {
    const toBlocks = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : c);
    last.content = [...toBlocks(last.content), ...toBlocks(m.content)];
    return;
  }
  if (provider === 'openai' && last && last.role === 'user' && m.role === 'user') {
    last.content = `${last.content}\n\n${m.content}`;
    return;
  }
  out.push(structuredClone(m));
}

function friendlyAiError(e) {
  if (e instanceof Anthropic.AuthenticationError) return new HttpError(502, 'The AI provider rejected the API key. Check ANTHROPIC_API_KEY on the server.');
  if (e instanceof Anthropic.PermissionDeniedError) return new HttpError(502, 'The AI provider denied access for this key or model.');
  if (e instanceof Anthropic.NotFoundError) return new HttpError(502, `The configured model "${config.ai.anthropicModel}" was not found for this API key.`);
  if (e instanceof Anthropic.RateLimitError) return new HttpError(429, 'The AI provider is rate-limiting requests. Wait a moment and try again.');
  if (e instanceof Anthropic.APIConnectionError) return new HttpError(503, 'Could not reach the AI provider. Check the server\'s network connection.');
  if (e instanceof Anthropic.APIError) return new HttpError(502, `AI provider error (${e.status ?? 'unknown'}): ${e.message}`);
  if (e instanceof HttpError) return e;
  return new HttpError(502, `AI request failed: ${e.message}`);
}

async function callAnthropic(messages) {
  const tools = toolSpecs();
  const base = {
    model: config.ai.anthropicModel,
    max_tokens: 16000,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    tools,
    messages,
    thinking: { type: 'adaptive' },
    output_config: { effort: config.ai.anthropicEffort },
  };
  if (fallbacksSupported) {
    try {
      return await anthropic().beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    } catch (e) {
      if (!(e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message))) throw e;
      fallbacksSupported = false; // account or model doesn't accept it; continue without
    }
  }
  return anthropic().messages.create(base);
}

async function callOpenAI(messages) {
  const tools = toolSpecs().map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const res = await fetch(`${config.ai.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.ai.openaiKey}` },
    body: JSON.stringify({ model: config.ai.openaiModel, messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages], tools }),
    signal: AbortSignal.timeout(120000),
  }).catch((e) => { throw new HttpError(503, `Could not reach the AI provider: ${e.message}`); });
  const json = await res.json().catch(() => ({}));
  if (res.status === 429) throw new HttpError(429, 'The AI provider is rate-limiting requests. Wait a moment and try again.');
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'The AI provider rejected the API key.');
  if (!res.ok) throw new HttpError(502, `AI provider error (${res.status}): ${json.error?.message || 'unknown'}`);
  return json.choices?.[0]?.message;
}

const preview = (result) => {
  const s = JSON.stringify(result ?? null);
  return s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
};

/** Run the tool calls from one model turn concurrently and collect UI-facing action records. */
async function runTools(userId, conversationId, calls, actions, pending) {
  return Promise.all(calls.map(async (c) => {
    const r = await executeToolCall(userId, conversationId, c.name, c.input);
    const tool = toolMap.get(c.name);
    if (r.status === 'pending') pending.push(r.pending);
    if (tool && (tool.access !== 'read' || r.status !== 'ok')) actions.push({ tool: c.name, status: r.status, summary: r.summary || r.pending?.summary || r.error || c.name, pending_id: r.pending?.id || null });
    else actions.push({ tool: c.name, status: 'read', summary: `Looked up ${c.name.replace(/_/g, ' ')}` });
    let content;
    if (r.status === 'ok' || r.status === 'conflict') content = JSON.stringify(r.result);
    else if (r.status === 'pending') content = JSON.stringify({ status: 'pending', message: `Waiting for the user to approve on a confirmation card: ${r.pending.summary}. Not done yet.`, action_id: r.pending.id });
    else content = JSON.stringify({ status: r.status, error: r.error });
    return { call: c, ok: ['ok', 'pending', 'conflict'].includes(r.status), content };
  }));
}

export async function chat(userId, { conversationId, text }) {
  const status = providerStatus();
  const convId = conversationId ? getConversation(userId, conversationId).id : createConversation(userId, text.slice(0, 60));
  const ctx = contextBlock(userId);
  const userApi = status.provider === 'anthropic' ? [{ role: 'user', content: [{ type: 'text', text: `${ctx}\n\n${text}` }] }] : status.provider === 'openai' ? [{ role: 'user', content: `${ctx}\n\n${text}` }] : [];
  // History must be built before the new message is stored, then extended with it.
  const history = status.configured ? buildHistory(convId, status.provider) : [];
  storeMessage(userId, convId, { role: 'user', content: text, apiMessages: userApi, provider: status.provider });

  if (!status.configured) {
    const reply = await handleDemo(userId, convId, text);
    const mid = storeMessage(userId, convId, { role: 'assistant', content: reply.text, actions: reply.actions, provider: 'demo' });
    return { conversation_id: convId, message: { id: mid, role: 'assistant', content: reply.text, actions: reply.actions, pending: reply.pending, data: reply.data }, provider: status };
  }

  const messages = [...history];
  for (const m of userApi) pushMerged(messages, m, status.provider);
  const newMessages = [];
  const actions = [];
  const pending = [];
  let finalText = '';
  let errorOut = null;

  try {
    for (let round = 0; round <= config.ai.maxToolRounds; round++) {
      if (status.provider === 'anthropic') {
        const resp = await callAnthropic(messages);
        if (resp.stop_reason === 'refusal') {
          finalText = 'I can\'t help with that request.';
          break;
        }
        const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        const calls = resp.content.filter((b) => b.type === 'tool_use');
        if (resp.stop_reason === 'max_tokens' && calls.length) {
          finalText = `${text}\n\n(My response was cut off before I could finish. Please try a narrower request.)`.trim();
          break;
        }
        const assistantMsg = { role: 'assistant', content: resp.content };
        if (!calls.length || round === config.ai.maxToolRounds) {
          messages.push(assistantMsg);
          newMessages.push(assistantMsg);
          finalText = text || (calls.length ? 'I stopped after several steps. Let me know if you want me to continue.' : '');
          if (calls.length) {
            // Close the open tool calls so the stored history stays valid.
            const closing = { role: 'user', content: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: 'Not executed: step limit reached.', is_error: true })) };
            messages.push(closing);
            newMessages.push(closing);
          }
          break;
        }
        const results = await runTools(userId, convId, calls.map((c) => ({ id: c.id, name: c.name, input: c.input })), actions, pending);
        const toolMsg = { role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.call.id, content: r.content, ...(r.ok ? {} : { is_error: true }) })) };
        messages.push(assistantMsg, toolMsg);
        newMessages.push(assistantMsg, toolMsg);
      } else {
        const msg = await callOpenAI(messages);
        if (!msg) throw new HttpError(502, 'The AI provider returned an empty response.');
        const calls = (msg.tool_calls || []).filter((c) => c.type === 'function');
        const assistantMsg = { role: 'assistant', content: msg.content || '', ...(calls.length ? { tool_calls: calls } : {}) };
        if (!calls.length || round === config.ai.maxToolRounds) {
          const clean = { role: 'assistant', content: msg.content || '' };
          messages.push(clean);
          newMessages.push(clean);
          finalText = (msg.content || '').trim() || 'I stopped after several steps. Let me know if you want me to continue.';
          break;
        }
        const parsed = calls.map((c) => {
          let input = {};
          try { input = JSON.parse(c.function.arguments || '{}'); } catch { input = { __invalid_json: c.function.arguments }; }
          return { id: c.id, name: c.function.name, input };
        });
        const results = await runTools(userId, convId, parsed, actions, pending);
        messages.push(assistantMsg);
        newMessages.push(assistantMsg);
        for (const r of results) {
          const tm = { role: 'tool', tool_call_id: r.call.id, content: r.content };
          messages.push(tm);
          newMessages.push(tm);
        }
      }
    }
  } catch (e) {
    errorOut = e instanceof HttpError ? e : friendlyAiError(e);
  }

  if (errorOut) {
    finalText = `${actions.some((a) => a.status === 'ok') ? 'Some steps completed before an error occurred (see actions below). ' : ''}${errorOut.message}`;
  }
  if (!finalText) finalText = pending.length ? 'I\'ve prepared that for you — please review and approve it below.' : 'Done.';
  const mid = storeMessage(userId, convId, { role: 'assistant', content: finalText, apiMessages: newMessages, actions, provider: status.provider });
  return { conversation_id: convId, message: { id: mid, role: 'assistant', content: finalText, actions, pending, error: errorOut ? errorOut.message : undefined }, provider: status };
}

/** Called after the user approves/rejects a pending action: record it in the conversation so the model knows. */
export function recordActionOutcome(userId, action, outcome) {
  if (!action?.conversation_id) return;
  const text = outcome.status === 'ok'
    ? `The user approved "${action.summary}". Result: ${preview(outcome.result)}`
    : outcome.status === 'rejected' ? `The user declined "${action.summary}". Nothing was changed.` : `Approved "${action.summary}" but it failed: ${outcome.error}`;
  const shown = outcome.status === 'ok' ? `Approved: ${action.summary}` : outcome.status === 'rejected' ? `Declined: ${action.summary}` : `Failed: ${action.summary} — ${outcome.error}`;
  storeMessage(userId, action.conversation_id, { role: 'event', content: shown, apiMessages: [{ role: 'user', content: `[App update, not typed by the user] ${text}` }], provider: '*' });
}
