// What Claude can do in Social HQ. Each tool is a thin layer over the same code the
// website uses, so Claude follows the same checks (photo rules, approvals, timings).

import { listAccounts, publicAccount } from "./accounts.mjs";
import { listPosts, getPost, createPost, updatePost, deletePost } from "./posts.mjs";
import { plan, suggestions, insightsList, insightsDetail } from "./views.mjs";
import { initUpload, putPart, completeUpload, CHUNK_SIZE } from "./media.mjs";
import { getSettings } from "./settings.mjs";
import { HttpError, istDateKey, istToDate, istParts, addDaysKey, clean } from "./util.mjs";
import { logEvent } from "./audit.mjs";

const MAX_IMPORT = 80 * 1024 * 1024;

// "2026-11-24 19:30" (India time) or a full ISO time with offset.
export function parseWhen(s) {
  if (s === undefined || s === null || s === "") return null;
  const str = String(s).trim();
  const m = str.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/);
  const d = m ? istToDate(m[1], `${m[2].padStart(2, "0")}:${m[3]}`) : new Date(str);
  if (isNaN(d.getTime())) throw new HttpError(400, `“${str}” is not a date and time I understand. Use YYYY-MM-DD HH:mm in India time.`);
  return d.toISOString();
}

function ist(iso) {
  if (!iso) return null;
  const p = istParts(iso);
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return `${istDateKey(iso)} ${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")} IST (${days[p.dow]})`;
}

function postView(p, byId) {
  return {
    id: p.id,
    status: p.status,
    when: ist(p.scheduledAt),
    type: p.type,
    accounts: p.accountIds.map((id) => ({ id, name: byId[id]?.name || id, platform: byId[id]?.platform || "removed", status: p.targets?.[id]?.status || "pending", url: p.targets?.[id]?.url || undefined, error: p.targets?.[id]?.error || undefined })),
    caption: (p.caption || "").slice(0, 400),
    captions: Object.keys(p.captions || {}).length ? p.captions : undefined,
    title: p.title || undefined,
    media: (p.media || []).map((m) => ({ id: m.id, kind: m.kind, name: m.name })),
    needsYourOk: p.status === "needs_ok" || undefined,
    note: p.note || undefined,
  };
}

async function importMedia(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    throw new HttpError(400, `Not a web address: ${url}`);
  }
  if (u.protocol !== "https:") throw new HttpError(400, "Media links must start with https://");
  const res = await fetch(u, { redirect: "follow" });
  if (!res.ok) throw new HttpError(400, `Could not download ${u.hostname}${u.pathname}: HTTP ${res.status}`);
  const mime = (res.headers.get("content-type") || "").split(";")[0].trim();
  if (!/^(image|video)\//.test(mime)) throw new HttpError(400, `That link is not a photo or video (it is ${mime || "unknown"}).`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_IMPORT) throw new HttpError(400, "That file is over 80 MB. Upload it on the Social HQ website instead.");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMPORT) throw new HttpError(400, "That file is over 80 MB. Upload it on the Social HQ website instead.");
  const name = decodeURIComponent(u.pathname.split("/").pop() || "file").slice(0, 120);
  const up = await initUpload({ name, size: buf.length, mime });
  for (let i = 0; i < up.chunks; i++) await putPart(up.id, i, buf.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
  const done = await completeUpload(up.id);
  return { ...done, warn: done.kind === "image" && mime !== "image/jpeg" ? `${name} is ${mime}; Instagram only takes JPEG photos.` : "" };
}

function captionsArg(c) {
  if (!c || typeof c !== "object") return undefined;
  const out = {};
  for (const [k, v] of Object.entries(c)) if (typeof v === "string") out[k] = v;
  return out;
}

const ACCOUNT_IDS = { type: "array", items: { type: "string" }, description: "Account ids from list_accounts." };
const POST_FIELDS = {
  account_ids: ACCOUNT_IDS,
  type: { type: "string", enum: ["post", "reel", "carousel", "story", "short", "pin", "text"], description: "post = one photo (or text on Facebook/LinkedIn); reel = one vertical video; carousel = 2-10 photos/videos; story = one photo/video for 24h; short = YouTube Short + Reels; pin = Pinterest." },
  caption: { type: "string", description: "Main caption, used for every platform unless captions has its own text." },
  captions: { type: "object", description: "Optional different text per platform, e.g. {\"linkedin\": \"...\", \"instagram\": \"...\"}.", additionalProperties: { type: "string" } },
  title: { type: "string", description: "YouTube title (needed for YouTube)." },
  link: { type: "string", description: "Link for Pinterest pins or Facebook link posts." },
  first_comment: { type: "string", description: "Posted as the first comment (Instagram, Facebook)." },
  also_story: { type: "boolean", description: "Also share the same photo/video (first one of a carousel) to the Instagram and Facebook Page Story." },
  media_urls: { type: "array", items: { type: "string" }, description: "Public https links to photos/videos to attach, in order. Instagram photos must be JPEG. Max 80 MB each." },
  media_ids: { type: "array", items: { type: "string" }, description: "Ids of media already in Social HQ (from get_post), to reuse." },
  when: { type: "string", description: "When to post: \"YYYY-MM-DD HH:mm\" in India time (IST). Leave empty to save as a draft. Use best_times to pick a good slot." },
  note: { type: "string", description: "Private note shown in Social HQ." },
};

export const TOOLS = [
  {
    name: "list_accounts",
    description: "List every connected social account in Social HQ (Instagram, Facebook Pages, LinkedIn, YouTube, Pinterest, and reminder-only Facebook profiles) with ids, brands and login status.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "week_plan",
    description: "The posting plan for one week (Monday to Sunday, India time): what is scheduled each day, the perfect posting time per day, accounts behind their weekly target, and drafts.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "Any date in the week, YYYY-MM-DD. Default: this week." }, brand: { type: "string", description: "Only this brand, e.g. LIFTLINE." } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_posts",
    description: "Posts between two dates (India time), with status per account and links once posted.",
    inputSchema: { type: "object", properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD (max 62 days after from)" }, include_drafts: { type: "boolean" } }, required: ["from"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_post",
    description: "Full details of one post.",
    inputSchema: { type: "object", properties: { post_id: { type: "string" } }, required: ["post_id"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "best_times",
    description: "The 3 best upcoming times to post for the given accounts, learned from their own results (avoids clashing with posts already scheduled).",
    inputSchema: { type: "object", properties: { account_ids: ACCOUNT_IDS, date: { type: "string", description: "Only this day, YYYY-MM-DD (optional)." } }, required: ["account_ids"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_post",
    description: "Create a post for one or more accounts. With `when` it is scheduled and goes out by itself (or waits for Pratham's OK if he switched that on); without `when` it is saved as a draft. Confirm the details with Pratham before scheduling.",
    inputSchema: { type: "object", properties: POST_FIELDS, required: ["account_ids", "type"] },
    annotations: { destructiveHint: false },
  },
  {
    name: "update_post",
    description: "Change a post that has not gone out yet: time, caption, accounts, media. Only send the fields to change. Set when to \"\" to turn it back into a draft.",
    inputSchema: { type: "object", properties: { post_id: { type: "string" }, ...POST_FIELDS }, required: ["post_id"] },
  },
  {
    name: "delete_post",
    description: "Delete a post that has not gone out yet (or remove a posted one from Social HQ's calendar; it stays on the platform).",
    inputSchema: { type: "object", properties: { post_id: { type: "string" } }, required: ["post_id"] },
    annotations: { destructiveHint: true },
  },
  {
    name: "get_insights",
    description: "How the accounts are doing. Without account_id: followers, 28-day reach, engagement and growth for every account. With account_id: that account's numbers, top posts and best posting hours.",
    inputSchema: { type: "object", properties: { account_id: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
];

async function byIdMap() {
  return Object.fromEntries((await listAccounts()).map((a) => [a.id, a]));
}

async function buildMedia(args, existing = []) {
  const media = [];
  const warnings = [];
  for (const id of args.media_ids || []) {
    const found = existing.find((m) => m.id === id);
    if (found) media.push(found);
  }
  for (const url of (args.media_urls || []).slice(0, 10)) {
    const m = await importMedia(String(url));
    if (m.warn) warnings.push(m.warn);
    media.push({ id: m.id, kind: m.kind, name: m.name, size: m.size, mime: m.mime });
  }
  return { media, warnings };
}

export async function callTool(name, args = {}, { req, grant } = {}) {
  const who = grant?.clientName || "Claude";
  switch (name) {
    case "list_accounts": {
      const accounts = (await listAccounts()).map(publicAccount).map((a) => ({ id: a.id, platform: a.platform, name: a.name, handle: a.handle || undefined, brand: a.brand, weeklyTarget: a.cadence || undefined, status: a.status, note: a.lastError || undefined }));
      return { accounts, timezone: "All times are India time (IST, UTC+05:30)." };
    }
    case "week_plan": {
      const p = await plan({ from: args.date || null, brand: args.brand || null });
      const byId = await byIdMap();
      return {
        week: `${p.weekFrom} to ${p.weekTo}`,
        days: p.days.map((d) => ({ date: d.date, perfectTime: ist(d.perfect), posts: d.posts.map((x) => ({ id: x.id, when: ist(x.scheduledAt), status: x.status, type: x.type, accounts: (x.accountIds || []).map((id) => byId[id]?.name || id), caption: (x.caption || "").slice(0, 120), atPerfectTime: x.best })) })),
        behindTarget: p.gaps.map((g) => ({ account: g.name, accountId: g.accountId, have: g.have, want: g.want, suggestedSlot: ist(g.slot) })),
        drafts: p.drafts.map((x) => ({ id: x.id, type: x.type, caption: (x.caption || "").slice(0, 120) })),
      };
    }
    case "list_posts": {
      const from = clean(args.from, 10);
      const to = clean(args.to || addDaysKey(from, 6), 10);
      const byId = await byIdMap();
      const posts = await listPosts({ from, to, drafts: !!args.include_drafts });
      return { from, to, posts: posts.map((p) => postView(p, byId)) };
    }
    case "get_post": {
      const byId = await byIdMap();
      return postView(await getPost(clean(args.post_id, 40)), byId);
    }
    case "best_times": {
      const slots = await suggestions({ accountIds: args.account_ids || [], dateKey: args.date || null });
      return { slots: slots.map((s) => ({ when: ist(s.at), whenValue: `${istDateKey(s.at)} ${ist(s.at).slice(11, 16)}`, score: s.score, why: s.why || s.reason || undefined })) };
    }
    case "create_post": {
      const settings = await getSettings();
      const { media, warnings } = await buildMedia(args);
      const scheduledAt = parseWhen(args.when);
      const post = await createPost({
        accountIds: args.account_ids || [],
        type: args.type,
        caption: args.caption,
        captions: captionsArg(args.captions),
        title: args.title,
        link: args.link,
        firstComment: args.first_comment,
        alsoStory: !!args.also_story,
        media,
        scheduledAt,
        needsApproval: !!settings.claude?.requireApproval,
        note: args.note || `Added by ${who}`,
      });
      await logEvent("claude", `${who} ${scheduledAt ? `scheduled a ${post.type} for ${ist(scheduledAt)}` : `saved a draft ${post.type}`}`, req, { postId: post.id });
      return { created: postView(post, await byIdMap()), warnings: warnings.length ? warnings : undefined };
    }
    case "update_post": {
      const id = clean(args.post_id, 40);
      const current = await getPost(id);
      const patch = {};
      if (args.account_ids) patch.accountIds = args.account_ids;
      if (args.type) patch.type = args.type;
      for (const [k, f] of [["caption", "caption"], ["title", "title"], ["link", "link"], ["first_comment", "firstComment"], ["note", "note"]]) if (typeof args[k] === "string") patch[f] = args[k];
      if (args.captions) patch.captions = captionsArg(args.captions);
      if (typeof args.also_story === "boolean") patch.alsoStory = args.also_story;
      if (args.media_urls || args.media_ids) {
        const { media, warnings } = await buildMedia(args, current.media);
        patch.media = media;
        patch._warnings = warnings;
      }
      if (args.when !== undefined) patch.scheduledAt = args.when === "" ? null : parseWhen(args.when);
      const warnings = patch._warnings;
      delete patch._warnings;
      const post = await updatePost(id, patch);
      await logEvent("claude", `${who} changed a post${post.scheduledAt ? ` (now ${ist(post.scheduledAt)})` : " (now a draft)"}`, req, { postId: id });
      return { updated: postView(post, await byIdMap()), warnings: warnings?.length ? warnings : undefined };
    }
    case "delete_post": {
      const p = await deletePost(clean(args.post_id, 40));
      await logEvent("claude", `${who} deleted a ${p.type}${p.scheduledAt ? ` planned for ${ist(p.scheduledAt)}` : ""}`, req, { postId: p.id });
      return { deleted: p.id };
    }
    case "get_insights": {
      if (!args.account_id) {
        const l = await insightsList();
        return {
          lastUpdated: l.lastRun,
          accounts: l.accounts.map((a) => ({ id: a.id, name: a.name, platform: a.platform, brand: a.brand, followers: a.followers, followerChange28d: a.growth28, reach28d: a.reach28, engagementRate: a.engagementRate === null ? null : `${(a.engagementRate * 100).toFixed(1)}%`, postsLast28d: a.posts28 })),
        };
      }
      const d = await insightsDetail(clean(args.account_id, 80));
      if (!d) throw new HttpError(404, "No account with that id. Use list_accounts.");
      const L = d.latest || {};
      return {
        account: { id: d.account.id, name: d.account.name, platform: d.account.platform },
        updated: L.at || null,
        followers: L.followers ?? null,
        kpis: L.kpis || [],
        topPosts: (L.posts || []).slice().sort((a, b) => (b.interactions || 0) - (a.interactions || 0)).slice(0, 5).map((p) => ({ title: p.title, type: p.type, at: ist(p.at), views: p.views, reach: p.reach, interactions: p.interactions, url: p.url })),
        bestTimes: (d.top || []).map((t) => t.label || t),
        followerHistory: (d.hist || []).slice(-14),
      };
    }
    default:
      throw new HttpError(404, `Unknown tool ${name}`);
  }
}
