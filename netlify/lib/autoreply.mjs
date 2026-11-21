// Keyword auto-replies on Instagram comments.
// Every few minutes: look at recent posts whose comment count went up, read the new comments,
// and answer the ones that match a rule (once per comment, never our own comments).

import { listAccounts, saveAccount } from "./accounts.mjs";
import { getSettings } from "./settings.mjs";
import { platforms } from "./platforms/index.mjs";
import { getJSON, setJSON } from "./store.mjs";
import { randomId } from "./crypto.mjs";
import { HttpError, errMessage } from "./util.mjs";

const MAX_PER_ACCOUNT_RUN = 10;
const MAX_AGE_MS = 7 * 86400000; // Instagram allows a DM reply to a comment for 7 days

const clean = (s, n) => String(s ?? "").replace(/\s+$/g, "").slice(0, n);

export async function listRules() {
  return (await getJSON("auto/rules")) || [];
}
async function saveRules(rules) {
  await setJSON("auto/rules", rules);
}

function normalise(input, existing = {}) {
  const keywords = [...new Set((Array.isArray(input.keywords) ? input.keywords : String(input.keywords || "").split(/[,\n]/)).map((k) => String(k).trim().toLowerCase().replace(/^["'#]+|["']+$/g, "")).filter(Boolean))].slice(0, 30);
  const replies = (Array.isArray(input.replies) ? input.replies : [input.replies]).map((r) => clean(r, 900).trim()).filter(Boolean).slice(0, 3);
  const everyComment = !!input.everyComment;
  if (!everyComment && !keywords.length) throw new HttpError(400, "Add at least one keyword, or tick “Every comment”.");
  if (!replies.length && !String(input.dm || "").trim()) throw new HttpError(400, "Write the reply (or a DM) that should be sent.");
  const accountIds = (Array.isArray(input.accountIds) ? input.accountIds : []).map((x) => String(x).slice(0, 80)).slice(0, 20);
  if (!accountIds.length) throw new HttpError(400, "Pick at least one Instagram account.");
  const on = !!input.on;
  const turningOn = on && !existing.on;
  let onSince = existing.onSince || null;
  if (turningOn) onSince = new Date(Date.now() - (input.lookBack24h ? 86400000 : 0)).toISOString();
  return {
    id: existing.id || randomId(8),
    name: clean(input.name, 80).trim() || (everyComment ? "Every comment" : keywords.slice(0, 3).join(", ")),
    on,
    onSince,
    accountIds,
    everyComment,
    keywords,
    replies,
    dm: clean(input.dm, 900).trim(),
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stats: existing.stats || { replies: 0, dms: 0, lastAt: null },
  };
}

export async function createRule(input) {
  const rules = await listRules();
  if (rules.length >= 30) throw new HttpError(400, "That's 30 rules already. Remove one first.");
  const r = normalise(input);
  rules.push(r);
  await saveRules(rules);
  return r;
}
export async function updateRule(id, input) {
  const rules = await listRules();
  const i = rules.findIndex((r) => r.id === id);
  if (i < 0) throw new HttpError(404, "Rule not found.");
  rules[i] = normalise({ ...rules[i], ...input }, rules[i]);
  await saveRules(rules);
  return rules[i];
}
export async function deleteRule(id) {
  await saveRules((await listRules()).filter((r) => r.id !== id));
  return { ok: true };
}

function hasWord(text, kw) {
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${esc}($|[^\\p{L}\\p{N}_])`, "iu").test(text);
}
export function matchRule(rules, accountId, text) {
  const t = String(text || "").toLowerCase();
  for (const r of rules) {
    if (!r.accountIds.includes(accountId)) continue;
    if (r.everyComment) return { rule: r, keyword: null };
    const kw = r.keywords.find((k) => hasWord(t, k));
    if (kw) return { rule: r, keyword: kw };
  }
  return null;
}
export function fillText(tpl, c) {
  return String(tpl || "").replace(/\{username\}/gi, c.username ? "@" + c.username : "").replace(/\{name\}/gi, c.username ? "@" + c.username : "").trim();
}

async function addLog(entries) {
  if (!entries.length) return;
  const log = (await getJSON("auto/log")) || [];
  await setJSON("auto/log", [...entries.reverse(), ...log].slice(0, 150));
}
export async function getLog() {
  return (await getJSON("auto/log")) || [];
}

// Preview only: which rule would answer, and with what. Sends nothing.
export async function testComment({ text, accountId }) {
  const rules = (await listRules()).filter((r) => !accountId || r.accountIds.includes(accountId));
  const ids = accountId ? [accountId] : [...new Set(rules.flatMap((r) => r.accountIds))];
  for (const id of ids) {
    const m = matchRule(rules, id, text);
    if (m) {
      const fake = { username: "someone" };
      return { match: true, rule: m.rule.name, on: m.rule.on, keyword: m.keyword, accountId: id, reply: m.rule.replies.length ? fillText(m.rule.replies[0], fake) : "", dm: fillText(m.rule.dm, fake) };
    }
  }
  return { match: false };
}

export async function runAutoReplies({ platformsOverride, now = Date.now() } = {}) {
  const impl = platformsOverride || platforms;
  const rules = (await listRules()).filter((r) => r.on);
  if (!rules.length) return { checked: 0, replied: 0 };
  const settings = await getSettings();
  const wanted = new Set(rules.flatMap((r) => r.accountIds));
  const accounts = (await listAccounts()).filter((a) => a.platform === "instagram" && wanted.has(a.id));
  const p = impl.instagram;
  let replied = 0;
  const logs = [];
  const statBump = {};
  await Promise.all(accounts.map(async (acc) => {
    try {
      const { account, changed } = await p.ensureToken({ account: acc, settings });
      if (changed) await saveAccount(account);
      const stateKey = `auto/state/${account.id}`;
      const state = (await getJSON(stateKey)) || { counts: {} };
      const media = await p.recentMediaCounts({ settings, account });
      const myRules = rules.filter((r) => r.accountIds.includes(account.id));
      const oldest = Math.min(...myRules.map((r) => new Date(r.onSince || r.createdAt).getTime()));
      let sentHere = 0;
      for (const m of media) {
        if ((m.comments || 0) <= (state.counts[m.id] || 0)) continue;
        if (m.at && new Date(m.at).getTime() < now - 60 * 86400000) { state.counts[m.id] = m.comments; continue; }
        let failed = false;
        const comments = await p.comments({ settings, account, postId: m.id });
        for (const c of comments.sort((x, y) => String(x.at).localeCompare(String(y.at)))) {
          if (sentHere >= MAX_PER_ACCOUNT_RUN) { failed = true; break; }
          const t = new Date(c.at).getTime();
          if (c.mine || c.replied || t < oldest || t < now - MAX_AGE_MS) continue;
          if (await getJSON(`auto/done/${c.id}`)) continue;
          const hit = matchRule(myRules.filter((r) => t >= new Date(r.onSince || r.createdAt).getTime()), account.id, c.text);
          if (!hit) continue;
          const r = hit.rule;
          const entry = { at: new Date().toISOString(), account: account.handle || account.name, accountId: account.id, username: c.username, comment: c.text.slice(0, 200), rule: r.name, keyword: hit.keyword, reply: "", dm: "", error: "" };
          try {
            if (r.replies.length) {
              const text = fillText(r.replies[Math.floor(Math.random() * r.replies.length)], c);
              await p.replyComment({ settings, account, commentId: c.id, message: text });
              entry.reply = text;
              statBump[r.id] = statBump[r.id] || { replies: 0, dms: 0 };
              statBump[r.id].replies++;
            }
            if (r.dm && p.privateReply) {
              try {
                const dm = fillText(r.dm, c);
                await p.privateReply({ settings, account, commentId: c.id, message: dm });
                entry.dm = dm;
                statBump[r.id] = statBump[r.id] || { replies: 0, dms: 0 };
                statBump[r.id].dms++;
              } catch (e) {
                entry.error = `DM not sent: ${errMessage(e)}`;
              }
            }
            await setJSON(`auto/done/${c.id}`, { at: entry.at, rule: r.id });
            sentHere++;
            replied++;
          } catch (e) {
            entry.error = errMessage(e);
            failed = true;
          }
          logs.push(entry);
        }
        if (!failed) state.counts[m.id] = m.comments;
      }
      state.at = new Date().toISOString();
      await setJSON(stateKey, state);
    } catch (e) {
      logs.push({ at: new Date().toISOString(), account: acc.handle || acc.name, accountId: acc.id, error: `Could not check comments: ${errMessage(e)}` });
    }
  }));
  if (Object.keys(statBump).length) {
    const all = await listRules();
    for (const r of all) {
      const b = statBump[r.id];
      if (!b) continue;
      r.stats = { replies: (r.stats?.replies || 0) + b.replies, dms: (r.stats?.dms || 0) + b.dms, lastAt: new Date().toISOString() };
    }
    await saveRules(all);
  }
  await addLog(logs);
  await setJSON("auto/run", { at: new Date().toISOString(), accounts: accounts.length, replied });
  return { checked: accounts.length, replied, logs };
}
