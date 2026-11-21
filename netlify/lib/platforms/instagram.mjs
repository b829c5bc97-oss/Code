// Instagram API with Unified Login (graph.facebook.com).
// Meta's only Instagram option for apps made after Oct 2026. You log in with Instagram or
// Facebook, tick the Instagram accounts to share, and Meta returns one "system user" key
// that never expires and works for every account you ticked.

import { call, qs, captionFor, waitFor, PlatformError } from "./common.mjs";
import { tokenOf } from "../accounts.mjs";
import { metaKeys } from "../settings.mjs";

function version(settings) {
  return settings.general.graphVersion || "v25.0";
}
function base(settings) {
  return `https://graph.facebook.com/${version(settings)}`;
}

export function authUrl({ settings, redirectUri, state }) {
  const k = metaKeys(settings, "instagram");
  return `https://www.facebook.com/${version(settings)}/dialog/oauth?${qs({
    client_id: k.appId,
    config_id: k.configId,
    redirect_uri: redirectUri,
    response_type: "code",
    override_default_response_type: "true",
    display: "page",
    state,
  })}`;
}

// Every Instagram account the login key can use. Meta's docs list a few ways to find them,
// so try each and merge what comes back.
async function grantedAccountIds(settings, token, k) {
  const ids = new Set();
  try {
    const { data } = await call(`${base(settings)}/debug_token?${qs({ input_token: token, access_token: `${k.appId}|${k.appSecret}` })}`);
    for (const g of data.data?.granular_scopes || []) {
      if (String(g.scope).startsWith("instagram_")) for (const id of g.target_ids || []) ids.add(String(id));
    }
  } catch (_) { /* fall through to the other ways */ }
  for (const edge of ["assigned_instagram_accounts", "instagram_accounts"]) {
    try {
      const { data } = await call(`${base(settings)}/me/${edge}?${qs({ fields: "id", limit: 100, access_token: token })}`);
      for (const a of data.data || []) ids.add(String(a.id));
    } catch (_) { /* edge not available for this kind of key */ }
  }
  if (!ids.size) {
    try {
      const { data } = await call(`${base(settings)}/me/accounts?${qs({ fields: "instagram_business_account", limit: 100, access_token: token })}`);
      for (const p of data.data || []) if (p.instagram_business_account?.id) ids.add(String(p.instagram_business_account.id));
    } catch (_) { /* no Pages */ }
  }
  return [...ids];
}

export async function callback({ settings, redirectUri, code }) {
  const k = metaKeys(settings, "instagram");
  const { data: tok } = await call(`${base(settings)}/oauth/access_token?${qs({ client_id: k.appId, client_secret: k.appSecret, redirect_uri: redirectUri, code })}`);
  const token = tok.access_token;
  if (!token) throw new PlatformError("Meta did not return a login key.");
  const ids = await grantedAccountIds(settings, token, k);
  if (!ids.length) throw new PlatformError("No Instagram account came back. On Meta's screen, tick the Instagram accounts you want to add.");
  const out = [];
  for (const id of ids) {
    let p = {};
    try {
      ({ data: p } = await call(`${base(settings)}/${id}?${qs({ fields: "id,username,name,profile_picture_url", access_token: token })}`));
    } catch (_) { /* keep the id; details fill in on the next insights run */ }
    out.push({
      platform: "instagram",
      kind: "ig_business",
      remoteId: id,
      name: p.name || p.username || `Instagram ${id}`,
      handle: p.username ? "@" + p.username : "",
      avatar: p.profile_picture_url || "",
      token,
      tokenExpiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null,
      meta: { username: p.username || "", login: "unified" },
    });
  }
  return out;
}

// Unified Login keys don't expire, so there is nothing to renew.
export async function ensureToken({ account }) {
  return { account, changed: false };
}

async function createContainer(settings, account, params) {
  const { data } = await call(`${base(settings)}/${account.remoteId}/media`, {
    method: "POST",
    form: { ...params, access_token: tokenOf(account) },
  });
  return data;
}

async function uploadVideo(settings, container, account, bytes) {
  const uri = container.uri || `https://rupload.facebook.com/ig-api-upload/${version(settings)}/${container.id}`;
  await call(uri, {
    method: "POST",
    headers: { Authorization: `OAuth ${tokenOf(account)}`, offset: "0", file_size: String(bytes.length) },
    body: bytes,
    timeout: 600000,
  });
}

async function waitReady(settings, account, containerId) {
  const result = await waitFor(async () => {
    const { data } = await call(`${base(settings)}/${containerId}?${qs({ fields: "status_code,status", access_token: tokenOf(account) })}`);
    if (data.status_code === "FINISHED") return "ok";
    if (data.status_code === "ERROR" || data.status_code === "EXPIRED") throw new PlatformError(`Instagram could not process the file: ${data.status || data.status_code}`);
    return null;
  }, { tries: 60, every: 5000 });
  if (!result) throw new PlatformError("Instagram is still processing the video after 5 minutes. It will be retried.");
}

async function mediaContainer(settings, account, item, ctx, extra) {
  if (item.kind === "image") {
    return await createContainer(settings, account, { image_url: ctx.publicUrl(item.id), ...extra });
  }
  const c = await createContainer(settings, account, { upload_type: "resumable", ...extra });
  await uploadVideo(settings, c, account, await ctx.bytes(item.id));
  return c;
}

async function publishContainer(settings, account, creationId) {
  const { data } = await call(`${base(settings)}/${account.remoteId}/media_publish`, {
    method: "POST",
    form: { creation_id: creationId, access_token: tokenOf(account) },
  });
  return data.id;
}

async function permalink(settings, account, mediaId) {
  try {
    const { data } = await call(`${base(settings)}/${mediaId}?${qs({ fields: "permalink", access_token: tokenOf(account) })}`);
    return data.permalink || "";
  } catch (_) {
    return "";
  }
}

export async function publish({ settings, account, post, ctx }) {
  const caption = captionFor(post, "instagram");
  const media = post.media;
  let creationId;
  const isStory = post.type === "story";

  if (isStory) {
    const c = await mediaContainer(settings, account, media[0], ctx, { media_type: "STORIES" });
    await waitReady(settings, account, c.id);
    creationId = c.id;
  } else if (post.type === "carousel" || media.length > 1) {
    const children = [];
    for (const item of media.slice(0, 10)) {
      const c = await mediaContainer(settings, account, item, ctx, { is_carousel_item: "true", ...(item.kind === "video" ? { media_type: "VIDEO" } : {}) });
      children.push(c.id);
    }
    for (const id of children) await waitReady(settings, account, id);
    const parent = await createContainer(settings, account, { media_type: "CAROUSEL", children: children.join(","), caption });
    await waitReady(settings, account, parent.id);
    creationId = parent.id;
  } else if (media[0].kind === "video") {
    const c = await mediaContainer(settings, account, media[0], ctx, { media_type: "REELS", caption, share_to_feed: "true" });
    await waitReady(settings, account, c.id);
    creationId = c.id;
  } else {
    const c = await mediaContainer(settings, account, media[0], ctx, { caption });
    await waitReady(settings, account, c.id);
    creationId = c.id;
  }

  const mediaId = await publishContainer(settings, account, creationId);
  const url = isStory ? `https://www.instagram.com/stories/${account.meta?.username || ""}/` : await permalink(settings, account, mediaId);

  const notes = [];
  if (post.firstComment && !isStory) {
    try {
      await call(`${base(settings)}/${mediaId}/comments`, { method: "POST", form: { message: post.firstComment, access_token: tokenOf(account) } });
    } catch (e) {
      notes.push(`First comment failed: ${e.message}`);
    }
  }
  // Instagram's API has no "share Reel to Story" button, so the same file is posted as a Story.
  if (post.alsoStory && !isStory && media.length === 1) {
    try {
      const c = await mediaContainer(settings, account, media[0], ctx, { media_type: "STORIES" });
      await waitReady(settings, account, c.id);
      await publishContainer(settings, account, c.id);
    } catch (e) {
      notes.push(`Story copy failed: ${e.message}`);
    }
  }
  return { remoteId: mediaId, url, note: notes.join(" ") };
}

async function totals(settings, account, metrics, sinceDays) {
  const until = Math.floor(Date.now() / 1000);
  const since = until - sinceDays * 86400;
  const out = {};
  const tryFetch = async (list) => {
    const { data } = await call(`${base(settings)}/${account.remoteId}/insights?${qs({ metric: list.join(","), period: "day", metric_type: "total_value", since, until, access_token: tokenOf(account) })}`);
    for (const m of data.data || []) out[m.name] = m.total_value?.value ?? 0;
  };
  try {
    await tryFetch(metrics);
  } catch (_) {
    for (const m of metrics) {
      try {
        await tryFetch([m]);
      } catch (_) { /* metric not available for this account */ }
    }
  }
  return out;
}

export async function insights({ settings, account }) {
  const token = tokenOf(account);
  const { data: me } = await call(`${base(settings)}/${account.remoteId}?${qs({ fields: "id,username,name,profile_picture_url,followers_count,follows_count,media_count", access_token: token })}`);
  const t28 = await totals(settings, account, ["reach", "views", "accounts_engaged", "total_interactions"], 28);
  const t7 = await totals(settings, account, ["reach", "views", "total_interactions"], 7);

  const posts = [];
  try {
    const { data: list } = await call(`${base(settings)}/${account.remoteId}/media?${qs({ fields: "id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count", limit: 25, access_token: token })}`);
    for (const m of (list.data || []).slice(0, 20)) {
      const item = {
        id: m.id,
        title: (m.caption || "").split("\n")[0].slice(0, 90) || m.media_product_type || m.media_type,
        type: m.media_product_type === "REELS" ? "Reel" : m.media_type === "CAROUSEL_ALBUM" ? "Carousel" : m.media_type === "VIDEO" ? "Video" : "Post",
        url: m.permalink,
        at: m.timestamp,
        thumb: m.thumbnail_url || (m.media_type === "IMAGE" ? m.media_url : ""),
        likes: m.like_count || 0,
        comments: m.comments_count || 0,
        reach: 0,
        views: 0,
        interactions: (m.like_count || 0) + (m.comments_count || 0),
      };
      try {
        const { data: mi } = await call(`${base(settings)}/${m.id}/insights?${qs({ metric: "reach,views,total_interactions", access_token: token })}`);
        for (const x of mi.data || []) {
          const v = x.values?.[0]?.value ?? x.total_value?.value ?? 0;
          if (x.name === "reach") item.reach = v;
          if (x.name === "views") item.views = v;
          if (x.name === "total_interactions") item.interactions = v;
        }
      } catch (_) { /* some posts have no insights */ }
      posts.push(item);
    }
  } catch (_) { /* media list unavailable */ }

  const reach28 = t28.reach || 0;
  const inter28 = t28.total_interactions || 0;
  const onlineHours = await online({ settings, account });
  return {
    online: onlineHours,
    name: me.name || me.username,
    handle: me.username ? "@" + me.username : "",
    avatar: me.profile_picture_url || "",
    followers: me.followers_count || 0,
    followersLabel: "Followers",
    reach7: t7.reach || 0,
    views7: t7.views || 0,
    reach28,
    views28: t28.views || 0,
    interactions28: inter28,
    engagementRate: reach28 ? inter28 / reach28 : null,
    postsCount: me.media_count || 0,
    kpis: [
      { label: "Accounts reached", value: reach28, period: "28 days" },
      { label: "Views", value: t28.views || 0, period: "28 days" },
      { label: "Interactions", value: inter28, period: "28 days" },
      { label: "Accounts engaged", value: t28.accounts_engaged || 0, period: "28 days" },
    ],
    posts,
  };
}

// ---------- Account page: profile, every past post, one post's numbers ----------
const IG_POST_FIELDS = "id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count";

function igType(m) {
  if (m.media_product_type === "REELS") return "Reel";
  if (m.media_product_type === "STORY") return "Story";
  if (m.media_type === "CAROUSEL_ALBUM") return "Carousel";
  if (m.media_type === "VIDEO") return "Video";
  return "Photo";
}
function igItem(m) {
  return {
    id: m.id,
    type: igType(m),
    caption: m.caption || "",
    url: m.permalink || "",
    at: m.timestamp,
    thumb: m.thumbnail_url || (m.media_type !== "VIDEO" ? m.media_url : "") || "",
    likes: m.like_count ?? null,
    comments: m.comments_count ?? null,
  };
}

export async function profile({ settings, account }) {
  const { data: me } = await call(`${base(settings)}/${account.remoteId}?${qs({ fields: "id,username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count", access_token: tokenOf(account) })}`);
  return {
    name: me.name || me.username,
    handle: me.username ? "@" + me.username : account.handle,
    avatar: me.profile_picture_url || account.avatar || "",
    bio: me.biography || "",
    website: me.website || "",
    link: me.username ? `https://www.instagram.com/${me.username}/` : "",
    linkLabel: "Open on Instagram",
    counts: [
      { label: "Posts", value: me.media_count ?? null },
      { label: "Followers", value: me.followers_count ?? null },
      { label: "Following", value: me.follows_count ?? null },
    ],
  };
}

export async function feed({ settings, account, after }) {
  const { data } = await call(`${base(settings)}/${account.remoteId}/media?${qs({ fields: IG_POST_FIELDS, limit: 24, after, access_token: tokenOf(account) })}`);
  return { posts: (data.data || []).map(igItem), next: data.paging?.cursors?.after && (data.paging?.next || (data.data || []).length >= 24) ? data.paging.cursors.after : null };
}

const IG_LABEL = {
  reach: "Accounts reached",
  views: "Views",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  saved: "Saves",
  total_interactions: "Interactions",
  profile_visits: "Profile visits",
  follows: "Follows",
  ig_reels_avg_watch_time: "Avg. watch time",
  ig_reels_video_view_total_time: "Total watch time",
  replies: "Replies",
  navigation: "Taps (back, forward, exit)",
};

// Meta refuses the whole request if one metric doesn't fit the post type, so ask in one go
// and, if that fails, one metric at a time and keep whatever comes back.
async function metaMetrics(url, token, metrics) {
  const read = (rows) => {
    const out = {};
    for (const x of rows || []) out[x.name] = x.values?.[0]?.value ?? x.total_value?.value ?? 0;
    return out;
  };
  try {
    const { data } = await call(`${url}?${qs({ metric: metrics.join(","), access_token: token })}`);
    return read(data.data);
  } catch (e) {
    if (e.authProblem && e.status === 401) throw e;
    const parts = await Promise.all(metrics.map(async (m) => {
      try {
        const { data } = await call(`${url}?${qs({ metric: m, access_token: token })}`);
        return read(data.data);
      } catch (_) {
        return {};
      }
    }));
    return Object.assign({}, ...parts);
  }
}

function msText(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export async function postDetail({ settings, account, postId }) {
  const token = tokenOf(account);
  const { data: m } = await call(`${base(settings)}/${encodeURIComponent(postId)}?${qs({ fields: IG_POST_FIELDS + ",children{media_type,media_url,thumbnail_url}", access_token: token })}`);
  const item = igItem(m);
  const kind = igType(m);
  const metrics = kind === "Reel"
    ? ["reach", "views", "likes", "comments", "shares", "saved", "total_interactions", "ig_reels_avg_watch_time", "ig_reels_video_view_total_time"]
    : kind === "Story"
      ? ["reach", "views", "replies", "shares", "total_interactions", "navigation"]
      : ["reach", "views", "likes", "comments", "shares", "saved", "total_interactions", "profile_visits", "follows"];
  const got = await metaMetrics(`${base(settings)}/${encodeURIComponent(postId)}/insights`, token, metrics);
  if (got.likes === undefined && m.like_count !== undefined) got.likes = m.like_count;
  if (got.comments === undefined && m.comments_count !== undefined) got.comments = m.comments_count;
  const stats = metrics.filter((k) => got[k] !== undefined).map((k) => ({
    key: k,
    label: IG_LABEL[k] || k,
    value: k.includes("watch_time") || k.includes("view_total_time") ? null : got[k],
    text: k.includes("watch_time") || k.includes("view_total_time") ? msText(got[k]) : null,
  }));
  const reach = got.reach || 0;
  const inter = got.total_interactions ?? ((got.likes || 0) + (got.comments || 0) + (got.shares || 0) + (got.saved || 0));
  const media = (m.children?.data || []).map((c) => ({ kind: c.media_type === "VIDEO" ? "video" : "image", url: c.media_url || "", thumb: c.thumbnail_url || c.media_url || "" }));
  if (!media.length) media.push({ kind: m.media_type === "VIDEO" ? "video" : "image", url: m.media_url || "", thumb: item.thumb });
  return {
    ...item,
    media,
    stats,
    engagementRate: reach ? inter / reach : null,
    note: stats.length ? "" : "Instagram did not share numbers for this post (posts from before the account became a business account have none).",
    linkLabel: "Open on Instagram",
  };
}

// ---------- Comments: read, reply, hide, delete ----------
const C_FIELDS = "id,text,username,timestamp,like_count,hidden,replies{id,text,username,timestamp,like_count,hidden}";

function ownName(account) {
  return String(account.meta?.username || account.handle || "").replace(/^@/, "").toLowerCase();
}
function shapeComment(c, account, media) {
  const me = ownName(account);
  const replies = (c.replies?.data || []).map((r) => ({ id: r.id, text: r.text || "", username: r.username || "", at: r.timestamp, likes: r.like_count || 0, hidden: !!r.hidden, mine: (r.username || "").toLowerCase() === me })).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return {
    id: c.id,
    text: c.text || "",
    username: c.username || "",
    at: c.timestamp,
    likes: c.like_count || 0,
    hidden: !!c.hidden,
    mine: (c.username || "").toLowerCase() === me,
    replied: replies.some((r) => r.mine),
    replies,
    media,
  };
}

export async function comments({ settings, account, postId }) {
  const token = tokenOf(account);
  const { data } = await call(`${base(settings)}/${encodeURIComponent(postId)}/comments?${qs({ fields: C_FIELDS, limit: 50, access_token: token })}`);
  return (data.data || []).map((c) => shapeComment(c, account, null)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// Newest comments across the account's recent posts (for the inbox).
export async function recentComments({ settings, account, posts = 12 }) {
  const token = tokenOf(account);
  const { data } = await call(`${base(settings)}/${account.remoteId}/media?${qs({ fields: "id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,comments_count", limit: posts, access_token: token })}`);
  const withComments = (data.data || []).filter((m) => (m.comments_count || 0) > 0);
  const lists = await Promise.all(withComments.map(async (m) => {
    const media = { id: m.id, type: igType(m), caption: (m.caption || "").slice(0, 120), url: m.permalink || "", thumb: m.thumbnail_url || (m.media_type !== "VIDEO" ? m.media_url : "") || "", at: m.timestamp };
    try {
      const { data: cs } = await call(`${base(settings)}/${m.id}/comments?${qs({ fields: C_FIELDS, limit: 50, access_token: token })}`);
      return (cs.data || []).map((c) => shapeComment(c, account, media));
    } catch (_) {
      return [];
    }
  }));
  return lists.flat().filter((c) => !c.mine).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export async function replyComment({ settings, account, commentId, message }) {
  const { data } = await call(`${base(settings)}/${encodeURIComponent(commentId)}/replies`, { method: "POST", form: { message, access_token: tokenOf(account) } });
  return { id: data.id };
}

export async function hideComment({ settings, account, commentId, hide }) {
  await call(`${base(settings)}/${encodeURIComponent(commentId)}`, { method: "POST", form: { hide: hide ? "true" : "false", access_token: tokenOf(account) } });
  return { ok: true };
}

export async function deleteComment({ settings, account, commentId }) {
  await call(`${base(settings)}/${encodeURIComponent(commentId)}?${qs({ access_token: tokenOf(account) })}`, { method: "DELETE" });
  return { ok: true };
}

// ---------- Audience: who follows you and when they are online ----------
// Meta gives online hours per US Pacific day (end_time = the next Pacific midnight);
// turn them into India time, per weekday.
export function onlineGrid(values) {
  const sum = Array.from({ length: 7 }, () => Array(24).fill(0));
  const cnt = Array.from({ length: 7 }, () => Array(24).fill(0));
  let days = 0;
  for (const v of values || []) {
    const hours = v.value && typeof v.value === "object" ? v.value : null;
    if (!hours || !Object.keys(hours).length || !v.end_time) continue;
    days++;
    // end_time is the end of the Pacific day the counts belong to.
    const end = new Date(v.end_time);
    const dayStartUtc = end.getTime() - 24 * 3600000; // Pacific midnight, in UTC ms
    for (const [h, n] of Object.entries(hours)) {
      const t = new Date(dayStartUtc + Number(h) * 3600000 + 330 * 60000); // shift to IST clock
      const ist = new Date(t.getTime());
      const dow = (ist.getUTCDay() + 6) % 7;
      const hh = ist.getUTCHours();
      sum[dow][hh] += Number(n) || 0;
      cnt[dow][hh] += 1;
    }
  }
  if (!days) return null;
  const grid = sum.map((row, d) => row.map((s, h) => (cnt[d][h] ? Math.round(s / cnt[d][h]) : 0)));
  return { grid, days };
}

async function breakdown(settings, account, by) {
  const { data } = await call(`${base(settings)}/${account.remoteId}/insights?${qs({ metric: "follower_demographics", period: "lifetime", metric_type: "total_value", breakdown: by, access_token: tokenOf(account) })}`);
  const rows = data.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
  return rows.map((r) => ({ label: (r.dimension_values || []).join(", "), value: r.value || 0 })).sort((a, b) => b.value - a.value);
}

export async function online({ settings, account, withError = false }) {
  try {
    const { data } = await call(`${base(settings)}/${account.remoteId}/insights?${qs({ metric: "online_followers", period: "lifetime", access_token: tokenOf(account) })}`);
    const g = onlineGrid(data.data?.[0]?.values || []);
    return withError && !g ? { error: `no data (${JSON.stringify(data).slice(0, 160)})` } : g;
  } catch (e) {
    return withError ? { error: e.message } : null;
  }
}

export async function audience({ settings, account }) {
  const out = { age: [], gender: [], city: [], country: [], online: null, note: "" };
  const [age, gender, city, country, on] = await Promise.all(["age", "gender", "city", "country"].map((b) => breakdown(settings, account, b).catch((e) => ({ error: e.message }))).concat([online({ settings, account, withError: true })]));
  const errs = [age, gender, city, country].filter((x) => x && x.error);
  out.age = Array.isArray(age) ? age.sort((a, b) => a.label.localeCompare(b.label)) : [];
  out.gender = Array.isArray(gender) ? gender.map((g) => ({ ...g, label: { F: "Women", M: "Men", U: "Not shared" }[g.label] || g.label })) : [];
  out.city = Array.isArray(city) ? city.slice(0, 10) : [];
  out.country = Array.isArray(country) ? country.slice(0, 10) : [];
  out.online = on && on.grid ? on : null;
  out.onlineNote = on && on.error ? on.error : "";
  if (errs.length === 4 || (!out.age.length && !out.city.length)) out.note = "Instagram shows follower details (age, gender, cities) only once an account has 100 followers.";
  return out;
}

// For auto-replies: recent posts with their comment counts (one cheap call per check).
export async function recentMediaCounts({ settings, account }) {
  const { data } = await call(`${base(settings)}/${account.remoteId}/media?${qs({ fields: "id,comments_count,timestamp", limit: 15, access_token: tokenOf(account) })}`);
  return (data.data || []).map((m) => ({ id: m.id, comments: m.comments_count || 0, at: m.timestamp }));
}

// A private message to the person who left a comment (Instagram allows one, within 7 days).
export async function privateReply({ settings, account, commentId, message }) {
  const { data } = await call(`${base(settings)}/${account.remoteId}/messages?${qs({ access_token: tokenOf(account) })}`, {
    method: "POST",
    json: { recipient: { comment_id: commentId }, message: { text: message } },
  });
  return { id: data.message_id || data.id || "" };
}

// ---------- Analysis: per-post numbers for the last ~60 posts (cached) ----------
export async function analysisPosts({ settings, account, cache = {}, limit = 60, now = Date.now() }) {
  const token = tokenOf(account);
  const list = [];
  let url = `${base(settings)}/${account.remoteId}/media?${qs({ fields: IG_POST_FIELDS, limit: 50, access_token: token })}`;
  while (url && list.length < limit) {
    const { data } = await call(url);
    list.push(...(data.data || []));
    url = data.paging?.next && (data.data || []).length ? data.paging.next : null;
  }
  const items = list.slice(0, limit).map((m) => ({ ...igItem(m), saves: null, shares: null, reach: null, views: null, interactions: null, watchMs: null }));
  const todo = items.filter((it) => {
    const c = cache[it.id];
    if (!c || !c.fetchedAt) return true;
    const age = now - new Date(it.at).getTime();
    return age < 21 * 86400000 && now - new Date(c.fetchedAt).getTime() > 12 * 3600000;
  });
  for (const it of items) {
    const c = cache[it.id];
    if (c && !todo.includes(it)) Object.assign(it, { reach: c.reach, views: c.views, saves: c.saves, shares: c.shares, interactions: c.interactions, watchMs: c.watchMs, fetchedAt: c.fetchedAt });
  }
  for (let i = 0; i < todo.length; i += 6) {
    await Promise.all(todo.slice(i, i + 6).map(async (it) => {
      const metrics = it.type === "Reel" ? ["reach", "views", "likes", "comments", "shares", "saved", "total_interactions", "ig_reels_avg_watch_time"] : ["reach", "views", "likes", "comments", "shares", "saved", "total_interactions"];
      const got = await metaMetrics(`${base(settings)}/${encodeURIComponent(it.id)}/insights`, token, metrics).catch(() => ({}));
      it.reach = got.reach ?? null;
      it.views = got.views ?? null;
      it.saves = got.saved ?? null;
      it.shares = got.shares ?? null;
      it.interactions = got.total_interactions ?? null;
      it.watchMs = got.ig_reels_avg_watch_time ?? null;
      if (typeof got.likes === "number") it.likes = got.likes;
      if (typeof got.comments === "number") it.comments = got.comments;
      it.fetchedAt = new Date(now).toISOString();
    }));
  }
  return items;
}
