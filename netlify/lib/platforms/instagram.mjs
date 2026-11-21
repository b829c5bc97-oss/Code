// Instagram API with Instagram Login (graph.instagram.com).
// Works for Instagram business/creator accounts. Each account connects with its own login.

import { call, qs, captionFor, waitFor, PlatformError } from "./common.mjs";
import { tokenOf, setTokens } from "../accounts.mjs";

const SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
  "instagram_business_manage_comments",
];

function base(settings) {
  return `https://graph.instagram.com/${settings.general.graphVersion || "v23.0"}`;
}

export function authUrl({ settings, redirectUri, state }) {
  const s = settings.instagram;
  return `https://www.instagram.com/oauth/authorize?${qs({
    client_id: s.appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(","),
    state,
    force_reauth: "true",
  })}`;
}

export async function callback({ settings, redirectUri, code }) {
  const s = settings.instagram;
  const { data: short } = await call("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    form: { client_id: s.appId, client_secret: s.appSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code: String(code).replace(/#_$/, "") },
  });
  const shortToken = short.access_token || short.data?.[0]?.access_token;
  if (!shortToken) throw new PlatformError("Instagram did not return a login key.");
  const { data: long } = await call(`https://graph.instagram.com/access_token?${qs({ grant_type: "ig_exchange_token", client_secret: s.appSecret, access_token: shortToken })}`);
  const token = long.access_token;
  const { data: me } = await call(`${base(settings)}/me?${qs({ fields: "user_id,username,name,profile_picture_url,account_type", access_token: token })}`);
  const igId = me.user_id || me.id;
  return [
    {
      platform: "instagram",
      kind: "ig_business",
      remoteId: igId,
      name: me.name || me.username,
      handle: "@" + me.username,
      avatar: me.profile_picture_url || "",
      token,
      tokenExpiresAt: new Date(Date.now() + (long.expires_in || 5184000) * 1000).toISOString(),
      meta: { username: me.username, accountType: me.account_type || "" },
    },
  ];
}

// Long-lived tokens last 60 days and can be renewed once they are a day old.
export async function ensureToken({ account }) {
  const exp = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : 0;
  const daysLeft = (exp - Date.now()) / 86400000;
  if (exp && daysLeft > 45) return { account, changed: false };
  const { data } = await call(`https://graph.instagram.com/refresh_access_token?${qs({ grant_type: "ig_refresh_token", access_token: tokenOf(account) })}`);
  setTokens(account, { token: data.access_token, tokenExpiresAt: new Date(Date.now() + (data.expires_in || 5184000) * 1000).toISOString() });
  return { account, changed: true };
}

async function createContainer(settings, account, params) {
  const { data } = await call(`${base(settings)}/${account.remoteId}/media`, {
    method: "POST",
    form: { ...params, access_token: tokenOf(account) },
  });
  return data;
}

async function uploadVideo(container, account, bytes) {
  if (!container.uri) throw new PlatformError("Instagram did not give an upload address for the video.");
  await call(container.uri, {
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
  await uploadVideo(c, account, await ctx.bytes(item.id));
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
  let isStory = post.type === "story";

  if (isStory) {
    const item = media[0];
    const c = await mediaContainer(settings, account, item, ctx, { media_type: "STORIES" });
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
  // Instagram's API has no "share Reel to Story" button, so the same video is posted as a Story.
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
  const { data: me } = await call(`${base(settings)}/me?${qs({ fields: "user_id,username,name,profile_picture_url,followers_count,follows_count,media_count", access_token: token })}`);
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
  return {
    name: me.name || me.username,
    handle: "@" + me.username,
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
