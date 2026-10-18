// Exercises the real Anthropic SDK code path against a local fake Messages API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DateTime } from 'luxon';
import { startServer, client } from './helpers.js';

const requests = [];
let script = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    requests.push({ url: req.url, headers: req.headers, body: json });
    const step = script.shift();
    if (!step) { res.writeHead(500); return res.end('{}'); }
    if (step.status) {
      res.writeHead(step.status, { 'content-type': 'application/json', 'retry-after-ms': '1' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: json.model, content: step.content, stop_reason: step.stop_reason || 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }));
  });
});

let srv;
let u;
const zone = 'Asia/Kolkata';
const day = DateTime.now().setZone(zone).plus({ days: 3 }).toISODate();

before(async () => {
  await new Promise((r) => fake.listen(0, r));
  srv = await startServer({ ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.address().port}`, AI_PROVIDER: 'anthropic' });
  u = client(srv.base);
  await u.signup('agent@example.com');
});
after(async () => { await srv.close(); fake.close(); });

test('real tool-calling loop: validates args, executes tools, and returns results to the model', async () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig-abc' };
  script = [
    { stop_reason: 'tool_use', content: [thinking, { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'tu_1', name: 'check_conflicts', input: { start: `${day}T15:00`, end: `${day}T16:00` } },
      { type: 'tool_use', id: 'tu_2', name: 'create_event', input: { title: 'Meeting with Priya', start: `${day}T15:00`, duration_minutes: 60 } },
      { type: 'tool_use', id: 'tu_3', name: 'create_task', input: { title: '' } }] },
    { content: [{ type: 'text', text: 'Booked your meeting with Priya.' }] },
  ];
  const r = await u.post('/assistant/chat', { message: 'Schedule a meeting with Priya at 3pm' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.provider.provider, 'anthropic');
  assert.equal(r.data.message.content, 'Booked your meeting with Priya.');
  const first = requests[0].body;
  assert.equal(first.model, 'claude-opus-5-5');
  assert.deepEqual(first.thinking, { type: 'adaptive' });
  assert.match(requests[0].headers['anthropic-beta'] || '', /server-side-fallback-2026-07-01/);
  assert.equal(first.fallbacks, 'default');
  assert.ok(first.tools.some((t) => t.name === 'create_event' && t.input_schema.properties.start));
  assert.match(first.messages[0].content[0].text, /<context>/);
  const second = requests[1].body;
  const results = second.messages.at(-1).content;
  assert.equal(results.length, 3);
  assert.equal(results.find((x) => x.tool_use_id === 'tu_3').is_error, true, 'invalid args are rejected server-side');
  assert.deepEqual(second.messages.at(-2).content[0], thinking, 'thinking block is passed back unchanged');
  const events = (await u.get(`/events?q=Priya&from=${day}T00:00&to=${day}T23:59`)).data;
  assert.equal(events.length, 1);
  assert.ok(r.data.message.actions.some((a) => a.tool === 'create_event' && a.status === 'ok'));
});

test('destructive actions wait for approval and the outcome is reported back to the model', async () => {
  const ev = (await u.get(`/events?q=Priya&from=${day}T00:00&to=${day}T23:59`)).data[0];
  script = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_9', name: 'delete_event', input: { event_id: ev.id } }] },
    { content: [{ type: 'text', text: 'Please approve the deletion.' }] },
  ];
  const conv = (await u.get('/assistant/conversations')).data[0].id;
  const r = await u.post('/assistant/chat', { message: 'Delete that meeting', conversation_id: conv });
  assert.equal(r.data.message.pending.length, 1);
  assert.equal((await u.get(`/events/${ev.id}`)).status, 200, 'not deleted yet');
  const history = requests.at(-2).body.messages;
  assert.ok(history.length >= 4, 'previous turns (including tool results) are replayed');
  await u.post(`/assistant/actions/${r.data.message.pending[0].id}`, { decision: 'confirm' });
  assert.equal((await u.get(`/events/${ev.id}`)).status, 404);
  script = [{ content: [{ type: 'text', text: 'Done.' }] }];
  await u.post('/assistant/chat', { message: 'thanks', conversation_id: conv });
  const last = requests.at(-1).body.messages.at(-1);
  assert.ok(JSON.stringify(last).includes('The user approved'), 'approval outcome reaches the model');
});

test('rate limits and refusals are surfaced honestly', async () => {
  script = [{ status: 429 }, { status: 429 }, { status: 429 }];
  const r = await u.post('/assistant/chat', { message: 'hello' });
  assert.equal(r.status, 200);
  assert.match(r.data.message.error, /rate-limiting/);
  script = [{ stop_reason: 'refusal', content: [] }];
  const r2 = await u.post('/assistant/chat', { message: 'something' });
  assert.match(r2.data.message.content, /can't help/);
});
