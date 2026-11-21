// Posts. One post can go to many accounts; each account is a "target" with its own status.
// Stored under post/<IST date>/<id> so a week of the calendar is a few cheap lookups.

import { getJSON, setJSON, del, listKeys, getMany } from "./store.mjs";
import { randomId } from "./crypto.mjs";
import { listAccounts } from "./accounts.mjs";
import { HttpError, clean, istDateKey, dateKeysBetween } from "./util.mjs";

const TYPES = ["post", "reel", "carousel", "story", "short", "pin", "text"];
const EDITABLE = ["draft", "needs_ok", "scheduled", "failed", "partial"];

function keyFor(post) {
  return post.scheduledAt ? `post/${istDateKey(post.scheduledAt)}/${post.id}` : `post/draft/${post.id}`;
}

export async function getPost(id) {
  const key = await getJSON(`pidx/${id}`);
  if (!key) throw new HttpError(404, "Post not found.");
  const p = await getJSON(key.key);
  if (!p) throw new HttpError(404, "Post not found.");
  return p;
}

export async function findPost(id) {
  try {
    return await getPost(id);
  } catch (_) {
    return null;
  }
}

export async function savePost(post, previousKey) {
  post.updatedAt = new Date().toISOString();
  const key = keyFor(post);
  await setJSON(key, post);
  await setJSON(`pidx/${post.id}`, { key });
  if (previousKey && previousKey !== key) await del(previousKey);
  return post;
}

export async function listPosts({ from, to, drafts = false }) {
  const keys = [];
  const days = dateKeysBetween(from, to);
  const lists = await Promise.all(days.map((d) => listKeys(`post/${d}/`)));
  for (const l of lists) keys.push(...l);
  if (drafts) keys.push(...(await listKeys("post/draft/")));
  const posts = await getMany(keys);
  return posts.sort((a, b) => String(a.scheduledAt || "").localeCompare(String(b.scheduledAt || "")));
}

function normalise(input, accountsById) {
  const accountIds = [...new Set((input.accountIds || []).filter((id) => accountsById[id]))];
  const type = TYPES.includes(input.type) ? input.type : "post";
  const media = (input.media || []).slice(0, 20).map((m) => ({
    id: clean(m.id, 60),
    kind: m.kind === "video" ? "video" : "image",
    name: clean(m.name, 200),
    size: Number(m.size) || 0,
    mime: clean(m.mime, 80),
  }));
  const captions = {};
  for (const k of ["instagram", "facebook", "linkedin", "youtube", "pinterest", "manual"]) {
    if (input.captions && typeof input.captions[k] === "string" && input.captions[k].trim()) captions[k] = clean(input.captions[k], 5000);
  }
  const boardIds = {};
  for (const [acc, b] of Object.entries(input.boardIds || {})) if (accountsById[acc]) boardIds[acc] = clean(b, 40);
  let scheduledAt = null;
  if (input.scheduledAt) {
    const d = new Date(input.scheduledAt);
    if (isNaN(d.getTime())) throw new HttpError(400, "That date and time is not valid.");
    scheduledAt = d.toISOString();
  }
  return {
    accountIds,
    type,
    caption: clean(input.caption, 5000),
    captions,
    title: clean(input.title, 100),
    link: clean(input.link, 500),
    boardIds,
    firstComment: clean(input.firstComment, 2000),
    alsoStory: !!input.alsoStory,
    aiGenerated: !!input.aiGenerated,
    ytPrivacy: ["public", "unlisted", "private"].includes(input.ytPrivacy) ? input.ytPrivacy : "public",
    ytMadeForKids: !!input.ytMadeForKids,
    trial: ["manual", "auto", "off"].includes(input.trial) ? input.trial : "",
    cover: input.cover && (input.cover.mediaId || Number(input.cover.atSec) > 0)
      ? { mediaId: clean(input.cover.mediaId, 60) || "", atSec: Math.max(0, Math.min(Number(input.cover.atSec) || 0, 900)) }
      : null,
    media,
    scheduledAt,
    needsApproval: !!input.needsApproval,
    note: clean(input.note, 300),
  };
}

// The post as one account should get it: that account's saved caption ending, AI label and
// Trial Reel defaults applied (a post can switch a Trial Reel off with trial: "off").
export function forAccount(post, account) {
  const d = account?.defaults || {};
  const platform = account?.platform;
  const out = { ...post, captions: { ...(post.captions || {}) } };
  const ending = (d.captionEnding || "").trim();
  if (ending && ["instagram", "facebook", "youtube", "linkedin", "pinterest"].includes(platform)) {
    const base = (out.captions[platform] || out.caption || "").trim();
    if (!base.includes(ending)) out.captions[platform] = base ? `${base}\n\n${ending}` : ending;
  }
  if (d.aiLabel) out.aiGenerated = true;
  out.trial = post.trial === "off" ? "" : post.trial || (post.type === "reel" && platform === "instagram" ? d.trial || "" : "");
  return out;
}

// Returns a list of plain-language problems; empty = ready to schedule.
export function problems(post, accountsById) {
  const out = [];
  if (!post.accountIds.length) out.push("Pick at least one account.");
  const images = post.media.filter((m) => m.kind === "image");
  const videos = post.media.filter((m) => m.kind === "video");
  const text = (post.caption || "").trim();
  for (const id of post.accountIds) {
    const a = accountsById[id];
    if (!a) continue;
    const name = a.name;
    const cap = (post.captions[a.platform] || text).trim();
    switch (a.platform) {
      case "instagram":
        if (!post.media.length) out.push(`${name}: Instagram needs a photo or video.`);
        if (post.type === "carousel" && (post.media.length < 2 || post.media.length > 10)) out.push(`${name}: an Instagram carousel needs 2 to 10 photos or videos.`);
        if (post.type === "reel" && videos.length !== 1) out.push(`${name}: a Reel needs exactly one video.`);
        if (post.type === "story" && post.media.length !== 1) out.push(`${name}: a Story needs exactly one photo or video.`);
        if ((post.type === "post" || post.type === "text") && post.media.length > 1) out.push(`${name}: pick "Carousel" to post more than one photo.`);
        if (["manual", "auto"].includes(post.trial) && !(post.type === "reel" && videos.length === 1)) out.push(`${name}: a Trial Reel must be a Reel with one video.`);
        break;
      case "youtube":
        if (videos.length !== 1) out.push(`${name}: YouTube needs exactly one video.`);
        if (!(post.title || "").trim()) out.push(`${name}: add a YouTube title.`);
        break;
      case "pinterest":
        if (!post.media.length) out.push(`${name}: Pinterest needs a photo or video.`);
        if (!post.boardIds[id] && !a.meta?.defaultBoardId) out.push(`${name}: pick a Pinterest board.`);
        break;
      case "linkedin":
        if (!cap && !post.media.length) out.push(`${name}: LinkedIn needs text or a photo.`);
        if (videos.length > 1 || (videos.length && images.length)) out.push(`${name}: LinkedIn takes one video, or photos — not both.`);
        break;
      case "facebook":
        if (!cap && !post.media.length) out.push(`${name}: Facebook needs text or a photo.`);
        if (videos.length > 1 || (videos.length && images.length)) out.push(`${name}: Facebook takes one video, or photos — not both.`);
        break;
      default:
        break;
    }
  }
  return out;
}

function deriveStatus(post) {
  if (!post.scheduledAt) return "draft";
  if (post.needsApproval && !post.approvedAt) return "needs_ok";
  return "scheduled";
}

export async function createPost(input) {
  const accounts = await listAccounts();
  const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
  const data = normalise(input, byId);
  const post = {
    id: randomId(9),
    createdAt: new Date().toISOString(),
    ...data,
    approvedAt: input.approve ? new Date().toISOString() : null,
    targets: Object.fromEntries(data.accountIds.map((id) => [id, { status: "pending" }])),
  };
  post.status = deriveStatus(post);
  if (post.status !== "draft") {
    const p = problems(post, byId);
    if (p.length) throw new HttpError(400, p.join(" "), { problems: p });
  }
  return await savePost(post);
}

export async function updatePost(id, input) {
  const post = await getPost(id);
  if (!EDITABLE.includes(post.status)) throw new HttpError(400, "This post is already going out or has gone out, so it can't be edited.");
  const prevKey = keyFor(post);
  const accounts = await listAccounts();
  const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
  const data = normalise({ ...post, ...input }, byId);
  Object.assign(post, data);
  // Keep finished targets, add new ones as pending, drop removed ones.
  const targets = {};
  for (const accId of post.accountIds) targets[accId] = post.targets?.[accId]?.status === "posted" ? post.targets[accId] : { status: "pending" };
  post.targets = targets;
  post.retryAt = null;
  if (input.approve) post.approvedAt = new Date().toISOString();
  if (input.needsApproval === true && !input.approve) post.approvedAt = null;
  post.status = deriveStatus(post);
  if (post.status !== "draft") {
    const p = problems(post, byId);
    if (p.length) throw new HttpError(400, p.join(" "), { problems: p });
  }
  await del(`lock/${post.id}`);
  return await savePost(post, prevKey);
}

export async function deletePost(id) {
  const post = await getPost(id);
  if (post.status === "publishing") throw new HttpError(400, "This post is going out right now. Try again in a minute.");
  await del(keyFor(post));
  await del(`pidx/${id}`);
  await del(`lock/${id}`);
  return post;
}

export async function approvePost(id) {
  const post = await getPost(id);
  if (post.status !== "needs_ok") return post;
  post.approvedAt = new Date().toISOString();
  post.status = deriveStatus(post);
  return await savePost(post);
}

// Move a post to "now" so the publisher picks it up immediately.
export async function prepareNow(id, { retry = false } = {}) {
  const post = await getPost(id);
  const prevKey = keyFor(post);
  if (post.status === "publishing") throw new HttpError(400, "This post is already going out.");
  if (retry) {
    for (const t of Object.values(post.targets || {})) if (t.status === "failed") Object.assign(t, { status: "pending", error: "", tries: 0 });
  }
  post.retryAt = null;
  const hasPending = Object.values(post.targets || {}).some((t) => t.status === "pending");
  if (!hasPending) throw new HttpError(400, "Nothing left to post for this one.");
  post.scheduledAt = new Date().toISOString();
  post.approvedAt = post.approvedAt || new Date().toISOString();
  post.status = "scheduled";
  const accounts = await listAccounts();
  const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));
  const p = problems(post, byId);
  if (p.length) throw new HttpError(400, p.join(" "), { problems: p });
  await del(`lock/${post.id}`);
  return await savePost(post, prevKey);
}

export async function markManualDone(id, accountId) {
  const post = await getPost(id);
  const t = post.targets?.[accountId];
  if (!t) throw new HttpError(404, "That account isn't part of this post.");
  t.status = "posted";
  t.at = new Date().toISOString();
  t.manual = true;
  post.status = overallStatus(post);
  return await savePost(post);
}

export function overallStatus(post) {
  const ts = Object.values(post.targets || {});
  if (!ts.length) return post.status;
  const posted = ts.filter((t) => t.status === "posted").length;
  const failed = ts.filter((t) => t.status === "failed").length;
  const reminder = ts.filter((t) => t.status === "reminder").length;
  const pending = ts.filter((t) => t.status === "pending").length;
  if (pending) return post.status === "publishing" ? "publishing" : "scheduled";
  if (failed && !posted && !reminder) return "failed";
  if (failed) return "partial";
  if (reminder) return "reminder";
  return "done";
}

// Due = scheduled, approved, time reached. Looks at today and the previous two days (IST).
export async function duePosts(now = new Date()) {
  const today = istDateKey(now);
  const from = istDateKey(new Date(now.getTime() - 2 * 86400000));
  const posts = await listPosts({ from, to: today });
  // A post waiting for its automatic retry is due at retryAt, not at its original time.
  return posts.filter((p) => p.status === "scheduled" && p.scheduledAt && new Date(p.retryAt || p.scheduledAt).getTime() <= now.getTime() + 60000);
}

export async function claim(postId) {
  const { modified } = await setJSON(`lock/${postId}`, { at: new Date().toISOString() }, { onlyIfNew: true });
  return !!modified;
}

export async function releaseClaim(postId) {
  await del(`lock/${postId}`);
}
