// Facebook Pages via Facebook Login for Business. One login brings in every Page you tick.
// (Personal profiles can't be posted to by any app; those are reminder-only accounts.)

import { call, qs, captionFor, waitFor, PlatformError } from "./common.mjs";
import { tokenOf } from "../accounts.mjs";
import { metaKeys } from "../settings.mjs";

const SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "read_insights", "business_management"];

function version(settings) {
  return settings.general.graphVersion || "v25.0";
}
function base(settings) {
  return `https://graph.facebook.com/${version(settings)}`;
}

export function authUrl({ settings, redirectUri, state }) {
  const k = metaKeys(settings, "facebook");
  // Business-type Meta apps use a login "configuration" (config_id) instead of a scope list.
  const ask = k.configId ? { config_id: k.configId, override_default_response_type: "true" } : { scope: SCOPES.join(",") };
  return `https://www.facebook.com/${version(settings)}/dialog/oauth?${qs({
    client_id: k.appId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    display: "page",
    ...ask,
  })}`;
}

export async function callback({ settings, redirectUri, code }) {
  const s = metaKeys(settings, "facebook");
  const { data: short } = await call(`${base(settings)}/oauth/access_token?${qs({ client_id: s.appId, client_secret: s.appSecret, redirect_uri: redirectUri, code })}`);
  let userToken = short.access_token;
  try {
    const { data: long } = await call(`${base(settings)}/oauth/access_token?${qs({ grant_type: "fb_exchange_token", client_id: s.appId, client_secret: s.appSecret, fb_exchange_token: short.access_token })}`);
    if (long.access_token) userToken = long.access_token;
  } catch (_) { /* already a long-lived key */ }
  const { data: pages } = await call(`${base(settings)}/me/accounts?${qs({ fields: "id,name,access_token,picture{url},username", limit: 100, access_token: userToken })}`);
  const list = pages.data || [];
  if (!list.length) throw new PlatformError("No Facebook Pages came back. Make sure you ticked your Pages on Facebook's screen.");
  return list.map((p) => ({
    platform: "facebook",
    kind: "fb_page",
    remoteId: p.id,
    name: p.name,
    handle: p.username ? "@" + p.username : "Facebook Page",
    avatar: p.picture?.data?.url || "",
    token: p.access_token, // Page tokens made from a long-lived login don't expire.
    tokenExpiresAt: null,
  }));
}

export async function ensureToken({ account }) {
  return { account, changed: false };
}

async function multipart(url, fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== "") fd.append(k, String(v));
  if (file) fd.append(file.field, new Blob([file.bytes], { type: file.mime }), file.name || "upload");
  return await call(url, { method: "POST", body: fd, timeout: 600000 });
}

async function uploadPhoto(settings, account, item, ctx, { published, message }) {
  const { data } = await multipart(
    `${base(settings)}/${account.remoteId}/photos`,
    { access_token: tokenOf(account), published: published ? "true" : "false", message },
    { field: "source", bytes: await ctx.bytes(item.id), mime: item.mime || "image/jpeg", name: item.name || "photo.jpg" }
  );
  return data;
}

// Reels and video Stories share the same 3-step upload.
async function phasedVideo(settings, account, item, ctx, edge, finishFields) {
  const token = tokenOf(account);
  const { data: start } = await call(`${base(settings)}/${account.remoteId}/${edge}`, { method: "POST", form: { upload_phase: "start", access_token: token } });
  const bytes = await ctx.bytes(item.id);
  await call(start.upload_url || `https://rupload.facebook.com/video-upload/${version(settings)}/${start.video_id}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(bytes.length) },
    body: bytes,
    timeout: 600000,
  });
  const { data: fin } = await call(`${base(settings)}/${account.remoteId}/${edge}`, {
    method: "POST",
    form: { upload_phase: "finish", video_id: start.video_id, access_token: token, ...finishFields },
  });
  return { videoId: start.video_id, postId: fin.post_id || fin.id || "" };
}

async function permalink(settings, account, id) {
  try {
    const { data } = await call(`${base(settings)}/${id}?${qs({ fields: "permalink_url", access_token: tokenOf(account) })}`);
    return data.permalink_url || "";
  } catch (_) {
    return "";
  }
}

export async function publish({ settings, account, post, ctx }) {
  const message = captionFor(post, "facebook");
  const media = post.media;
  const token = tokenOf(account);
  let postId = "";
  let url = "";

  if (post.type === "story") {
    const item = media[0];
    if (!item) throw new PlatformError("A Facebook Story needs a photo or video.");
    if (item.kind === "video") {
      const r = await phasedVideo(settings, account, item, ctx, "video_stories", {});
      postId = r.postId || r.videoId;
    } else {
      const photo = await uploadPhoto(settings, account, item, ctx, { published: false });
      const { data } = await call(`${base(settings)}/${account.remoteId}/photo_stories`, { method: "POST", form: { photo_id: photo.id, access_token: token } });
      postId = data.post_id || photo.id;
    }
    url = `https://www.facebook.com/${account.remoteId}`;
    return { remoteId: postId, url };
  }

  const video = media.find((m) => m.kind === "video");
  const images = media.filter((m) => m.kind === "image");

  if (video && (post.type === "reel" || post.type === "short")) {
    const r = await phasedVideo(settings, account, video, ctx, "video_reels", { video_state: "PUBLISHED", description: message });
    postId = r.postId || r.videoId;
    url = `https://www.facebook.com/reel/${r.videoId}`;
  } else if (video) {
    const { data } = await multipart(
      `${base(settings)}/${account.remoteId}/videos`,
      { access_token: token, description: message, title: post.title },
      { field: "source", bytes: await ctx.bytes(video.id), mime: video.mime || "video/mp4", name: video.name || "video.mp4" }
    );
    postId = data.id;
    url = `https://www.facebook.com/${account.remoteId}/videos/${data.id}`;
  } else if (images.length === 1) {
    const data = await uploadPhoto(settings, account, images[0], ctx, { published: true, message });
    postId = data.post_id || data.id;
    url = await permalink(settings, account, postId);
  } else if (images.length > 1) {
    const ids = [];
    for (const img of images.slice(0, 10)) ids.push((await uploadPhoto(settings, account, img, ctx, { published: false })).id);
    const form = { message, access_token: token };
    ids.forEach((id, i) => (form[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
    const { data } = await call(`${base(settings)}/${account.remoteId}/feed`, { method: "POST", form });
    postId = data.id;
    url = await permalink(settings, account, postId);
  } else {
    const { data } = await call(`${base(settings)}/${account.remoteId}/feed`, { method: "POST", form: { message, link: post.link || undefined, access_token: token } });
    postId = data.id;
    url = await permalink(settings, account, postId);
  }

  let note = "";
  if (post.firstComment && postId) {
    try {
      await call(`${base(settings)}/${postId}/comments`, { method: "POST", form: { message: post.firstComment, access_token: token } });
    } catch (e) {
      note = `First comment failed: ${e.message}`;
    }
  }
  return { remoteId: postId, url, note };
}

async function series(settings, account, metric, days) {
  const until = Math.floor(Date.now() / 1000);
  const since = until - days * 86400;
  const { data } = await call(`${base(settings)}/${account.remoteId}/insights?${qs({ metric, period: "day", since, until, access_token: tokenOf(account) })}`);
  return (data.data?.[0]?.values || []).map((v) => (typeof v.value === "number" ? v.value : 0));
}

export async function insights({ settings, account }) {
  const token = tokenOf(account);
  const { data: page } = await call(`${base(settings)}/${account.remoteId}?${qs({ fields: "name,fan_count,followers_count,picture{url}", access_token: token })}`);
  const sums = {};
  // Meta renames Page metrics from time to time; use whichever ones this Page still returns.
  for (const m of ["page_impressions_unique", "page_media_view", "page_post_engagements", "page_views_total", "page_daily_follows_unique"]) {
    try {
      const vals = await series(settings, account, m, 28);
      sums[m] = { d28: vals.reduce((a, b) => a + b, 0), d7: vals.slice(-7).reduce((a, b) => a + b, 0) };
    } catch (_) { /* metric not available */ }
  }
  const posts = [];
  try {
    const { data: list } = await call(`${base(settings)}/${account.remoteId}/published_posts?${qs({ fields: "id,message,created_time,permalink_url,full_picture,reactions.summary(total_count),comments.summary(total_count),shares", limit: 20, access_token: token })}`);
    for (const p of list.data || []) {
      const likes = p.reactions?.summary?.total_count || 0;
      const comments = p.comments?.summary?.total_count || 0;
      const shares = p.shares?.count || 0;
      posts.push({ id: p.id, title: (p.message || "Post").split("\n")[0].slice(0, 90), type: "Post", url: p.permalink_url, at: p.created_time, thumb: p.full_picture || "", likes, comments, reach: 0, views: 0, interactions: likes + comments + shares });
    }
  } catch (_) { /* posts unavailable */ }
  const reach = sums.page_impressions_unique || sums.page_media_view || { d28: 0, d7: 0 };
  const inter = sums.page_post_engagements || { d28: posts.reduce((a, p) => a + p.interactions, 0), d7: 0 };
  return {
    name: page.name,
    avatar: page.picture?.data?.url || "",
    followers: page.followers_count || page.fan_count || 0,
    followersLabel: "Followers",
    reach7: reach.d7,
    reach28: reach.d28,
    views28: sums.page_media_view?.d28 || 0,
    interactions28: inter.d28,
    engagementRate: reach.d28 ? inter.d28 / reach.d28 : null,
    kpis: [
      { label: sums.page_impressions_unique ? "People reached" : "Views", value: reach.d28, period: "28 days" },
      { label: "Post engagements", value: inter.d28, period: "28 days" },
      { label: "Page views", value: sums.page_views_total?.d28 || 0, period: "28 days" },
      { label: "New follows", value: sums.page_daily_follows_unique?.d28 || 0, period: "28 days" },
    ],
    posts,
  };
}

// ---------- Account page: profile, every past post, one post's numbers ----------
const FB_POST_FIELDS = "id,message,created_time,permalink_url,full_picture,status_type,attachments{media_type,type,media,url,subattachments},reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares";

function fbType(p) {
  const a = p.attachments?.data?.[0];
  const t = (a?.media_type || a?.type || p.status_type || "").toLowerCase();
  if (t.includes("reel")) return "Reel";
  if (t.includes("video")) return "Video";
  if (t.includes("album")) return "Album";
  if (t.includes("photo") || p.full_picture) return "Photo";
  if (t.includes("link") || t.includes("share")) return "Link";
  return "Post";
}
function fbItem(p) {
  return {
    id: p.id,
    type: fbType(p),
    caption: p.message || "",
    url: p.permalink_url || "",
    at: p.created_time,
    thumb: p.full_picture || "",
    likes: p.reactions?.summary?.total_count ?? null,
    comments: p.comments?.summary?.total_count ?? null,
    shares: p.shares?.count ?? 0,
  };
}

export async function profile({ settings, account }) {
  const { data: page } = await call(`${base(settings)}/${account.remoteId}?${qs({ fields: "name,username,about,link,fan_count,followers_count,picture.type(large){url}", access_token: tokenOf(account) })}`);
  return {
    name: page.name,
    handle: page.username ? "@" + page.username : account.handle,
    avatar: page.picture?.data?.url || account.avatar || "",
    bio: page.about || "",
    website: "",
    link: page.link || `https://www.facebook.com/${account.remoteId}`,
    linkLabel: "Open on Facebook",
    counts: [
      { label: "Followers", value: page.followers_count ?? null },
      { label: "Likes", value: page.fan_count ?? null },
    ],
  };
}

export async function feed({ settings, account, after }) {
  const { data } = await call(`${base(settings)}/${account.remoteId}/published_posts?${qs({ fields: FB_POST_FIELDS, limit: 24, after, access_token: tokenOf(account) })}`);
  return { posts: (data.data || []).map(fbItem), next: data.paging?.cursors?.after && (data.paging?.next || (data.data || []).length >= 24) ? data.paging.cursors.after : null };
}

const FB_LABEL = {
  post_impressions_unique: "People reached",
  post_impressions: "Impressions",
  post_media_view: "Views",
  post_total_media_view_unique: "People who viewed",
  post_clicks: "Clicks",
  post_video_views: "Video views (3s+)",
  post_video_avg_time_watched: "Avg. watch time",
};

export async function postDetail({ settings, account, postId }) {
  const token = tokenOf(account);
  const { data: p } = await call(`${base(settings)}/${encodeURIComponent(postId)}?${qs({ fields: FB_POST_FIELDS, access_token: token })}`);
  const item = fbItem(p);
  const wanted = ["post_impressions_unique", "post_media_view", "post_total_media_view_unique", "post_impressions", "post_clicks"];
  if (item.type === "Video" || item.type === "Reel") wanted.push("post_video_views", "post_video_avg_time_watched");
  const got = {};
  await Promise.all(wanted.map(async (m) => {
    try {
      const { data } = await call(`${base(settings)}/${encodeURIComponent(postId)}/insights?${qs({ metric: m, access_token: token })}`);
      const row = (data.data || [])[0];
      if (row) got[m] = row.values?.[0]?.value ?? 0;
    } catch (_) { /* Meta no longer offers this one */ }
  }));
  const stats = [];
  for (const m of wanted) {
    if (got[m] === undefined || typeof got[m] === "object") continue;
    if (m === "post_video_avg_time_watched") stats.push({ key: m, label: FB_LABEL[m], value: null, text: `${Math.round(got[m] / 1000)}s` });
    else stats.push({ key: m, label: FB_LABEL[m], value: got[m] });
  }
  stats.push({ key: "reactions", label: "Reactions", value: item.likes ?? 0 }, { key: "comments", label: "Comments", value: item.comments ?? 0 }, { key: "shares", label: "Shares", value: item.shares ?? 0 });
  const reach = got.post_impressions_unique || got.post_total_media_view_unique || 0;
  const inter = (item.likes || 0) + (item.comments || 0) + (item.shares || 0) + (got.post_clicks || 0);
  const a = p.attachments?.data?.[0];
  const subs = a?.subattachments?.data || [];
  const media = (subs.length ? subs : a ? [a] : []).map((x) => ({ kind: /video/i.test(x.media_type || x.type || "") ? "video" : "image", url: x.media?.source || x.media?.image?.src || "", thumb: x.media?.image?.src || "" })).filter((x) => x.thumb || x.url);
  if (!media.length && item.thumb) media.push({ kind: "image", url: item.thumb, thumb: item.thumb });
  return { ...item, media, stats, engagementRate: reach ? inter / reach : null, note: "", linkLabel: "Open on Facebook" };
}

// ---------- Analysis: per-post numbers (cached) ----------
export async function analysisPosts({ settings, account, cache = {}, limit = 50, now = Date.now() }) {
  const token = tokenOf(account);
  const { data } = await call(`${base(settings)}/${account.remoteId}/published_posts?${qs({ fields: FB_POST_FIELDS, limit, access_token: token })}`);
  const items = (data.data || []).map((p) => ({ ...fbItem(p), saves: null, reach: null, views: null, interactions: null }));
  for (const it of items) {
    const c = cache[it.id];
    const fresh = c && c.fetchedAt && (now - new Date(it.at).getTime() > 21 * 86400000 || now - new Date(c.fetchedAt).getTime() < 12 * 3600000);
    if (fresh) {
      Object.assign(it, { reach: c.reach, views: c.views, fetchedAt: c.fetchedAt });
      continue;
    }
    const got = {};
    await Promise.all(["post_impressions_unique", "post_total_media_view_unique", "post_media_view", "post_clicks"].map(async (m) => {
      try {
        const { data: d } = await call(`${base(settings)}/${encodeURIComponent(it.id)}/insights?${qs({ metric: m, access_token: token })}`);
        const v = d.data?.[0]?.values?.[0]?.value;
        if (typeof v === "number") got[m] = v;
      } catch (_) { /* metric retired by Meta */ }
    }));
    it.reach = got.post_impressions_unique ?? got.post_total_media_view_unique ?? null;
    it.views = got.post_media_view ?? null;
    it.clicks = got.post_clicks ?? null;
    it.fetchedAt = new Date(now).toISOString();
  }
  for (const it of items) it.interactions = (it.likes || 0) + (it.comments || 0) + (it.shares || 0);
  return items;
}
