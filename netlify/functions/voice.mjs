// DeskCrew voice names: Santa and the narrator say each buyer's own village name in the Christmas Eve film.
//
// POST /api/voice  { key, instance, test, name }            -> makes (or returns) the two personal lines
// POST /api/voice  { key, instance, test, check: true }     -> how many name changes are left
//
// Rules: a real DeskCrew key; no rude names; the first name plus 3 changes; nothing after 24 Dec (the film is
// being made by then). Each name is only paid for once: asking again for a name already made costs nothing.
// The ElevenLabs key lives in Netlify (environment variable ELEVENLABS_API_KEY), never in the app.
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const VOICES = { n10: 'JYUzXNeyCPmymMkfcicu', s04: 'MDLAMJ0jxkpYkjXbmG4t' };   // Jon (Children's Storyteller), Jerry B (Jolly Santa Claus)
const CHANGES = 3;                       // after the first name
const CUTOFF = Date.parse('2026-12-24T18:00:00Z');   // after 9 am on 24 Dec everywhere the names are locked anyway
const REOPEN = Date.parse('2027-01-01T00:00:00Z');
const FRIEND_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEARiNXyD8MyeEnpfCqJHWMalvy0wVW75wuqGKG9Cndtr4=
-----END PUBLIC KEY-----`;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const b64u = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ---------------------------------------------------------------- names
export function cleanName(raw) {
  const n = String(raw || '').normalize('NFC').replace(/[\u0000-\u001f<>{}\[\]\\|`~^*_=+#@$%"]/g, '').replace(/\s+/g, ' ').trim();
  if (n.length < 2 || n.length > 30) return null;
  if (!/\p{L}/u.test(n)) return null;
  return n;
}
// Rude words in English and Hindi/Hinglish. Long, unmistakable ones are caught inside other words too; short ones only as whole
// words, so names like "Scunthorpe", "Essex", "Tatiana" or "PlayStation Corner" still work.
const INSIDE = ['fuck', 'bullshit', 'bitch', 'asshole', 'arsehole', 'bastard', 'whore', 'nigger', 'nigga', 'faggot', 'porno', 'penis', 'vagina', 'dildo', 'boobs',
  'motherf', 'hitler', 'molest', 'paedo', 'pedophile', 'paedophile', 'jihad', 'terrorist', 'chutiya', 'chutia', 'chootiya', 'madarchod', 'maderchod', 'behenchod', 'bhenchod',
  'benchod', 'bhosdi', 'bhosda', 'bhosri', 'haramkhor', 'gaandu', 'kutiya'];
const WHOLE = ['fuk', 'fuc', 'shit', 'shits', 'shitty', 'cunt', 'cunts', 'ass', 'arse', 'dick', 'cock', 'cum', 'tit', 'tits', 'sex', 'sexy', 'porn', 'slut', 'pussy', 'rape', 'rapist', 'retard',
  'pedo', 'nazi', 'kill', 'die', 'isis', 'kkk', 'bc', 'mc', 'bsdk', 'mkc', 'bkl', 'lund', 'loda', 'lauda', 'lode', 'gand', 'gaand', 'gandu', 'kutta', 'kutte', 'saala', 'suar', 'hijra',
  'randi', 'harami', 'kamine', 'kamina', 'chod', 'chodu', 'laude', 'lavde', 'lawde', 'jhaat', 'jhant', 'tatti', 'wtf', 'stfu'];
export function rude(name) {
  const leet = s => s.toLowerCase().replace(/0/g, 'o').replace(/1|!/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/@/g, 'a').replace(/\$/g, 's');
  const flat = leet(name).normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const once = s => s.replace(/(.)\1+/g, '$1');
  const squashed = flat.replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1$1');
  if (INSIDE.some(w => squashed.includes(w) || (once(w) === w && once(squashed).includes(w)))) return true;
  return flat.split(/[^a-z]+/).filter(Boolean).some(w => WHOLE.includes(w) || WHOLE.includes(once(w)));
}

// ---------------------------------------------------------------- keys
function friendId(key) {
  if (!/^DCF-/.test(key)) return null;
  try {
    const [p, s] = key.slice(4).split('.');
    if (!crypto.verify(null, Buffer.from(p), crypto.createPublicKey(FRIEND_PUBLIC_KEY), b64u(s))) return false;
    return 'f-' + (JSON.parse(b64u(p).toString('utf8')).id || sha(key).slice(0, 16));
  } catch { return false; }
}
async function keyId({ key, instance, test }) {
  key = String(key || '').trim().replace(/\s+/g, '');
  if (!key) return { error: 'no_key' };
  const f = friendId(key);
  if (f) return { id: f };
  if (f === false) return { error: 'bad_key' };
  if (test && process.env.ALLOW_TEST_KEYS !== '1') return { error: 'bad_key' };
  const base = test ? 'https://test.dodopayments.com' : 'https://live.dodopayments.com';
  try {
    const body = { license_key: key }; if (instance) body.license_key_instance_id = instance;
    const r = await fetch(base + '/licenses/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
    const d = await r.json().catch(() => null);
    if (r.ok && d && d.valid === true) return { id: (test ? 't-' : 'k-') + sha(key).slice(0, 24) };
    return { error: 'bad_key' };
  } catch { return { error: 'busy' }; }
}

// ---------------------------------------------------------------- ElevenLabs
const LINES = {
  n10: n => `[softly] And the very last stop... was ${n}, a place the crew knew well.`,
  s04: n => `[softly, warmly] Merry Christmas, little crew. Merry Christmas, everyone at ${n}!`,
};
async function speak(voiceId, text) {
  const models = [process.env.ELEVENLABS_MODEL || 'eleven_v4', 'eleven_v3', 'eleven_multilingual_v2'];
  let last = '';
  for (const model of [...new Set(models)]) {
    const t = /v3|v4/.test(model) ? text : text.replace(/\[[^\]]*\]\s*/g, '');   // older models would read the tags out loud
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY || '', 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text: t, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }), signal: AbortSignal.timeout(45000),
    });
    if (r.ok) return { audio: Buffer.from(await r.arrayBuffer()), model };
    last = `${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`;
    if (r.status === 401 || r.status === 429 || r.status >= 500) break;   // no point trying another model
  }
  throw new Error('elevenlabs ' + last);
}

// ---------------------------------------------------------------- the endpoint
export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'post_only' });
  let body; try { body = await req.json(); } catch { return json(400, { error: 'bad_request' }); }
  const who = await keyId(body);
  if (who.error) return json(who.error === 'busy' ? 503 : 403, { error: who.error });
  const store = getStore('voice-names');
  const rec = (await store.get(who.id, { type: 'json' })) || { names: [] };
  const left = () => Math.max(0, CHANGES + 1 - rec.names.length);
  const leftAfterFirst = () => Math.min(CHANGES, left());
  if (body.check) return json(200, { ok: true, left: leftAfterFirst(), used: rec.names.length, names: rec.names.map(x => x.name) });

  const name = cleanName(body.name);
  if (!name) return json(422, { error: 'bad_name', message: 'Use 2 to 30 letters, numbers and spaces.' });
  if (rude(name)) return json(422, { error: 'rude_name', message: 'Santa can\'t say that one. Please pick another name.' });

  const audio = getStore('voice-audio');
  const same = rec.names.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (same) {   // already made: free
    const [n10, s04] = await Promise.all([audio.get(same.n10, { type: 'arrayBuffer' }), audio.get(same.s04, { type: 'arrayBuffer' })]);
    if (n10 && s04) return json(200, { ok: true, name: same.name, left: leftAfterFirst(), n10: Buffer.from(n10).toString('base64'), s04: Buffer.from(s04).toString('base64'), reused: true });
  }
  const now = Date.now();
  if (now > CUTOFF && now < REOPEN) return json(423, { error: 'locked', message: 'The names are locked in for the Christmas Eve film.' });
  if (!same && left() <= 0) return json(409, { error: 'no_changes_left', left: 0, message: 'No voice name changes left.' });
  if (!process.env.ELEVENLABS_API_KEY) return json(503, { error: 'not_ready' });

  // a safety cap per day, so a bug or an attack can't use up all the ElevenLabs credits
  const meta = getStore('voice-meta'), day = new Date(now).toISOString().slice(0, 10);
  const count = (await meta.get('day-' + day, { type: 'json' })) || { n: 0 };
  if (count.n >= (+process.env.DAILY_CAP || 400)) return json(503, { error: 'busy', message: 'Lots of villages are being named right now. Try again tomorrow.' });

  try {
    const [n10, s04] = await Promise.all([speak(VOICES.n10, LINES.n10(name)), speak(VOICES.s04, LINES.s04(name))]);
    const base = `${who.id}/${sha(name.toLowerCase()).slice(0, 16)}`;
    await Promise.all([audio.set(base + '/n10', n10.audio), audio.set(base + '/s04', s04.audio)]);
    if (!same) rec.names.push({ name, n10: base + '/n10', s04: base + '/s04', at: new Date(now).toISOString(), model: n10.model });
    else Object.assign(same, { n10: base + '/n10', s04: base + '/s04' });
    await store.setJSON(who.id, rec);
    await meta.setJSON('day-' + day, { n: count.n + 1 });
    return json(200, { ok: true, name, left: leftAfterFirst(), n10: n10.audio.toString('base64'), s04: s04.audio.toString('base64') });
  } catch (e) {
    console.error(String(e && e.message || e));
    return json(502, { error: 'voice_failed' });
  }
};

export const config = { path: '/api/voice' };
