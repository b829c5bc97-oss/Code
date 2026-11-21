// Facebook Pages via Facebook Login. One login brings in every Page you manage.
// (Personal profiles can't be posted to by any app; those are reminder-only accounts.)

import { call, qs, captionFor, waitFor, PlatformError } from "./common.mjs";
import { tokenOf } from "../accounts.mjs";

const SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "read_insights", "business_management"];

function base(settings) {
  return `https://graph.facebook.com/${settings.general.graphVersion || "v23.0"}`;
}

export function authUrl({ settings, redirectUri, state }) {
  return `https://www.facebook.com/${settings.general.graphVersion || "v23.0"}/dialog/oauth?${qs({
    client_id: settings.facebook.appId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    scope: SCOPES.join(","),
  })}`;
}

export async function callback({ settings, redirectUri, code }) {
  const s = settings.facebook;
  const { data: short } = await call(`${base(settings)}/oauth/access_token?${qs({ client_id: s.appId, client_secret: s.appSecret, redirect_uri: redirectUri, code })}`);
  const { data: long } = await call(`${base(settings)}/oauth/access_token?${qs({ grant_type: "fb_exchange_token", client_id: s.appId, client_secret: s.appSecret, fb_exchange_token: short.access_token })}`);
  const { data: pages } = await call(`${base(settings)}/me/accounts?${qs({ fields: "id,name,access_token,picture{url},username", limit: 100, access_token: long.access_token })}`);
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
  await call(start.upload_url || `https://rupload.facebook.com/video-upload/${settings.general.graphVersion || "v23.0"}/${start.video_id}`, {
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
