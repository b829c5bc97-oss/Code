// Vote counter for "this or that" posts (Mystery Choices: Door A or Door B).
// Reads every comment on a post, finds the choice in each one, counts one vote per person
// (their latest comment wins if they change their mind) and says which option won.

import { getAccount } from "./accounts.mjs";
import { getSettings } from "./settings.mjs";
import { call, qs, PlatformError } from "./platforms/common.mjs";
import { tokenOf } from "./accounts.mjs";
import { getJSON, setJSON } from "./store.mjs";

const NUM = { a: 0, b: 1, c: 2, d: 3 };

// Which option a comment votes for, or null. Understands "A", "a!!", "Door B", "option a",
// "🅰️", "I pick B", "B 🔥", "1"/"2" and Hindi-English mixes like "B wala" — but not words that
// merely contain the letter (e.g. "Amazing" is not a vote for A).
export function readVote(text, options = ["A", "B"]) {
  const t = String(text || "").normalize("NFKC").trim();
  if (!t) return null;
  const low = t.toLowerCase();
  if (/🅰/.test(t) && !/🅱/.test(t)) return options[0];
  if (/🅱/.test(t) && !/🅰/.test(t)) return options[1] || null;
  const letters = options.map((o) => String(o).toLowerCase());
  const found = new Set();
  // Stand-alone letters or "door/option/team/pick X"
  const re = /(?:^|[^\p{L}\p{N}])(?:door|option|team|choice|pick|choose|go(?:ing)? with|i pick|i choose|darwaza|darwaja)?\s*([a-d1-4])(?=$|[^\p{L}\p{N}])/giu;
  const words = low.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  let m;
  while ((m = re.exec(low))) {
    const ch = m[1];
    const keyword = /[a-z]{2,}\s*[a-d1-4]$/.test(m[0].trim()) && !/^[a-d1-4]$/.test(m[0].trim());
    const pos = m.index + m[0].length - 1;
    // "a" is also a word ("what a twist") and numbers appear in normal comments ("2 min"):
    // count them only when written as a vote — capital A, after "door/option…", or a very short comment.
    if (ch === "a" && !keyword && t[pos] !== "A" && words > 2) continue;
    if (/\d/.test(ch) && !keyword && words > 2) continue;
    const idx = /\d/.test(ch) ? Number(ch) - 1 : NUM[ch];
    if (letters[idx] !== undefined) found.add(idx);
  }
  // Whole option words (when options are words like "Left" / "Right")
  letters.forEach((o, i) => {
    if (o.length > 1 && new RegExp(`(^|[^\\p{L}])${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "iu").test(low)) found.add(i);
  });
  if (found.size !== 1) return null; // "A or B?" and "both" are not votes
  return options[[...found][0]];
}

async function allComments(settings, account, mediaId) {
  const token = tokenOf(account);
  const v = settings.general?.graphVersion || "v25.0";
  let url = `https://graph.facebook.com/${v}/${encodeURIComponent(mediaId)}/comments?${qs({ fields: "id,text,username,timestamp", limit: 50, access_token: token })}`;
  const out = [];
  for (let page = 0; page < 40 && url; page++) {
    const { data } = await call(url);
    out.push(...(data.data || []));
    url = data.paging?.next || "";
  }
  return out;
}

export function tally(comments, { options = ["A", "B"], own = "" } = {}) {
  const latest = new Map();
  let ignored = 0;
  for (const c of [...comments].sort((a, b) => String(a.timestamp || a.at).localeCompare(String(b.timestamp || b.at)))) {
    const user = String(c.username || "").toLowerCase();
    if (!user || user === own) continue;
    const vote = readVote(c.text, options);
    if (!vote) {
      ignored++;
      continue;
    }
    latest.set(user, { vote, at: c.timestamp || c.at, text: c.text });
  }
  const counts = Object.fromEntries(options.map((o) => [o, 0]));
  for (const { vote } of latest.values()) counts[vote]++;
  const total = latest.size;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const tie = sorted.length > 1 && sorted[0][1] === sorted[1][1];
  return {
    options,
    counts,
    percent: Object.fromEntries(options.map((o) => [o, total ? Math.round((counts[o] / total) * 100) : 0])),
    voters: total,
    ignored,
    winner: total && !tie ? sorted[0][0] : null,
    tie: !!(total && tie),
    lastVoteAt: [...latest.values()].map((x) => x.at).sort().pop() || null,
  };
}

export async function countVotes(accountId, mediaId, { options } = {}) {
  const account = await getAccount(accountId);
  if (account.platform !== "instagram") throw new PlatformError("Vote counting works on Instagram posts.");
  const settings = await getSettings();
  const opts = (options && options.length >= 2 ? options : account.defaults?.voteOptions || ["A", "B"]).map((o) => String(o).slice(0, 20));
  const comments = await allComments(settings, account, mediaId);
  const own = String(account.meta?.username || account.handle || "").replace(/^@/, "").toLowerCase();
  const result = { accountId, mediaId, at: new Date().toISOString(), comments: comments.length, ...tally(comments, { options: opts, own }) };
  await setJSON(`votes/${accountId}/${mediaId}`, result);
  return result;
}

export async function savedVotes(accountId, mediaId) {
  return await getJSON(`votes/${accountId}/${mediaId}`);
}

export async function getLatestMediaId(accountId) {
  const account = await getAccount(accountId);
  const settings = await getSettings();
  const v = settings.general?.graphVersion || "v25.0";
  const { data } = await call(`https://graph.facebook.com/${v}/${account.remoteId}/media?${qs({ fields: "id,timestamp", limit: 1, access_token: tokenOf(account) })}`);
  const id = data.data?.[0]?.id;
  if (!id) throw new PlatformError("This account has no posts yet.");
  return id;
}
