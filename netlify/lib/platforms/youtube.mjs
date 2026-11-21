// YouTube via Google login. Reading stats works straight away; uploads stay Private
// until Google's audit of the app is passed (Google's rule for new apps).

import { call, qs, captionFor, ymd, daysAgo, PlatformError } from "./common.mjs";
import { tokenOf, refreshTokenOf, setTokens } from "../accounts.mjs";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

export function authUrl({ settings, redirectUri, state }) {
  return `https://accounts.google.com/o/oauth2/v2/auth?${qs({
    client_id: settings.youtube.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state,
  })}`;
}

export async function callback({ settings, redirectUri, code }) {
  const s = settings.youtube;
  const { data: tok } = await call("https://oauth2.googleapis.com/token", {
    method: "POST",
    form: { code, client_id: s.clientId, client_secret: s.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" },
  });
  const { data } = await call(`https://www.googleapis.com/youtube/v3/channels?${qs({ part: "snippet,contentDetails", mine: "true" })}`, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  const ch = data.items?.[0];
  if (!ch) throw new PlatformError("This Google account has no YouTube channel. Pick the account that owns the channel.");
  return [
    {
      platform: "youtube",
      kind: "yt_channel",
      remoteId: ch.id,
      name: ch.snippet.title,
      handle: ch.snippet.customUrl || "YouTube channel",
      avatar: ch.snippet.thumbnails?.default?.url || "",
      token: tok.access_token,
      refreshToken: tok.refresh_token,
      tokenExpiresAt: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(),
      meta: { uploads: ch.contentDetails?.relatedPlaylists?.uploads || "" },
    },
  ];
}

export async function ensureToken({ account, settings }) {
  const exp = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : 0;
  if (exp - Date.now() > 5 * 60000) return { account, changed: false };
  const rt = refreshTokenOf(account);
  if (!rt) throw new PlatformError("YouTube login needs to be reconnected.", { authProblem: true });
  try {
    const { data } = await call("https://oauth2.googleapis.com/token", {
      method: "POST",
      form: { client_id: settings.youtube.clientId, client_secret: settings.youtube.clientSecret, refresh_token: rt, grant_type: "refresh_token" },
    });
    setTokens(account, { token: data.access_token, tokenExpiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString() });
    return { account, changed: true };
  } catch (e) {
    throw new PlatformError(`YouTube login needs to be reconnected (${e.message}).`, { authProblem: true });
  }
}

export async function publish({ account, post, ctx }) {
  const video = post.media.find((m) => m.kind === "video");
  if (!video) throw new PlatformError("YouTube needs a video.");
  const bytes = await ctx.bytes(video.id);
  const description = captionFor(post, "youtube");
  let title = (post.title || "").slice(0, 100);
  if (post.type === "short" && !/#shorts/i.test(title + " " + description)) title = (title + " #Shorts").slice(0, 100);
  const tags = (description.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.slice(1)).slice(0, 15);
  const start = await call(`https://www.googleapis.com/upload/youtube/v3/videos?${qs({ uploadType: "resumable", part: "snippet,status" })}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenOf(account)}`,
      "X-Upload-Content-Length": String(bytes.length),
      "X-Upload-Content-Type": video.mime || "video/mp4",
    },
    json: {
      snippet: { title, description, tags, categoryId: "22" },
      status: {
        privacyStatus: post.ytPrivacy || "public",
        selfDeclaredMadeForKids: !!post.ytMadeForKids,
        containsSyntheticMedia: !!post.aiGenerated,
      },
    },
  });
  const location = start.headers.get("location");
  if (!location) throw new PlatformError("YouTube did not give an upload address.");
  const { data } = await call(location, {
    method: "PUT",
    headers: { Authorization: `Bearer ${tokenOf(account)}`, "content-type": video.mime || "video/mp4" },
    body: bytes,
    timeout: 840000,
  });
  const url = post.type === "short" ? `https://www.youtube.com/shorts/${data.id}` : `https://www.youtube.com/watch?v=${data.id}`;
  const notes = [];
  if (data.status?.privacyStatus === "private" && post.ytPrivacy !== "private") notes.push("Uploaded as Private: Google has not finished checking the app yet.");
  // Custom cover (YouTube only allows custom thumbnails on phone-verified channels).
  if (post.cover?.mediaId) {
    try {
      await call(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?${qs({ videoId: data.id, uploadType: "media" })}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenOf(account)}`, "content-type": "image/jpeg" },
        body: await ctx.bytes(post.cover.mediaId),
      });
    } catch (e) {
      notes.push(`Cover not set: ${e.message}`);
    }
  }
  return { remoteId: data.id, url, note: notes.join(" ") };
}

export async function insights({ account }) {
  const auth = { Authorization: `Bearer ${tokenOf(account)}` };
  const { data: chData } = await call(`https://www.googleapis.com/youtube/v3/channels?${qs({ part: "snippet,statistics,contentDetails", mine: "true" })}`, { headers: auth });
  const ch = chData.items?.[0] || {};
  const st = ch.statistics || {};
  let views28 = 0, views7 = 0, minutes28 = 0, subsGained = 0, subsLost = 0, likes28 = 0;
  try {
    const { data } = await call(`https://youtubeanalytics.googleapis.com/v2/reports?${qs({
      ids: "channel==MINE",
      startDate: ymd(daysAgo(28)),
      endDate: ymd(new Date()),
      metrics: "views,estimatedMinutesWatched,subscribersGained,subscribersLost,likes",
      dimensions: "day",
      sort: "day",
    })}`, { headers: auth });
    const rows = data.rows || [];
    rows.forEach((r, i) => {
      views28 += r[1]; minutes28 += r[2]; subsGained += r[3]; subsLost += r[4]; likes28 += r[5];
      if (i >= rows.length - 7) views7 += r[1];
    });
  } catch (_) { /* analytics not ready */ }
  const posts = [];
  try {
    const uploads = ch.contentDetails?.relatedPlaylists?.uploads || account.meta?.uploads;
    if (uploads) {
      const { data: pl } = await call(`https://www.googleapis.com/youtube/v3/playlistItems?${qs({ part: "contentDetails", playlistId: uploads, maxResults: 20 })}`, { headers: auth });
      const ids = (pl.items || []).map((i) => i.contentDetails.videoId).join(",");
      if (ids) {
        const { data: vids } = await call(`https://www.googleapis.com/youtube/v3/videos?${qs({ part: "snippet,statistics,status", id: ids })}`, { headers: auth });
        for (const v of vids.items || []) {
          // Private videos (including ones scheduled in YouTube Studio) are not live, so they must not show as "Posted".
          if (v.status?.privacyStatus === "private") continue;
          const s = v.statistics || {};
          const likes = Number(s.likeCount || 0), comments = Number(s.commentCount || 0);
          posts.push({ id: v.id, title: v.snippet.title, type: "Video", url: `https://www.youtube.com/watch?v=${v.id}`, at: v.snippet.publishedAt, thumb: v.snippet.thumbnails?.medium?.url || "", views: Number(s.viewCount || 0), likes, comments, reach: 0, interactions: likes + comments });
        }
      }
    }
  } catch (_) { /* uploads list unavailable */ }
  return {
    name: ch.snippet?.title || account.name,
    avatar: ch.snippet?.thumbnails?.default?.url || account.avatar,
    followers: Number(st.subscriberCount || 0),
    followersLabel: "Subscribers",
    reach7: views7,
    reach28: views28,
    views28,
    interactions28: likes28,
    engagementRate: views28 ? likes28 / views28 : null,
    kpis: [
      { label: "Views", value: views28, period: "28 days" },
      { label: "Watch time (hours)", value: Math.round(minutes28 / 60), period: "28 days" },
      { label: "Subscribers gained", value: subsGained - subsLost, period: "28 days" },
      { label: "Likes", value: likes28, period: "28 days" },
    ],
    posts,
  };
}

// ---------- Account page: profile, every past video, one video's numbers ----------
function ytAuth(account) {
  return { Authorization: `Bearer ${tokenOf(account)}` };
}
function ytThumb(sn) {
  const t = sn?.thumbnails || {};
  return (t.medium || t.high || t.default || {}).url || "";
}
function isoSeconds(d) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || "");
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}
function ytItem(v) {
  const s = v.statistics || {};
  const secs = isoSeconds(v.contentDetails?.duration);
  const short = secs > 0 && secs <= 180;
  return {
    id: v.id,
    type: short ? "Short" : "Video",
    caption: [v.snippet?.title, v.snippet?.description].filter(Boolean).join("\n\n"),
    title: v.snippet?.title || "",
    url: short ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`,
    at: v.snippet?.publishedAt,
    thumb: ytThumb(v.snippet),
    big: ((v.snippet?.thumbnails || {}).high || (v.snippet?.thumbnails || {}).standard || {}).url || "",
    views: Number(s.viewCount || 0),
    likes: s.likeCount === undefined ? null : Number(s.likeCount),
    comments: s.commentCount === undefined ? null : Number(s.commentCount),
    privacy: v.status?.privacyStatus || "",
  };
}

export async function profile({ account }) {
  const { data } = await call(`https://www.googleapis.com/youtube/v3/channels?${qs({ part: "snippet,statistics", mine: "true" })}`, { headers: ytAuth(account) });
  const ch = data.items?.[0] || {};
  const st = ch.statistics || {};
  return {
    name: ch.snippet?.title || account.name,
    handle: ch.snippet?.customUrl || account.handle,
    avatar: ytThumb(ch.snippet) || account.avatar || "",
    bio: ch.snippet?.description || "",
    website: "",
    link: ch.snippet?.customUrl ? `https://www.youtube.com/${ch.snippet.customUrl}` : `https://www.youtube.com/channel/${account.remoteId}`,
    linkLabel: "Open on YouTube",
    counts: [
      { label: "Videos", value: Number(st.videoCount || 0) },
      { label: "Subscribers", value: st.hiddenSubscriberCount ? null : Number(st.subscriberCount || 0) },
      { label: "Total views", value: Number(st.viewCount || 0) },
    ],
  };
}

export async function feed({ account, after }) {
  const auth = ytAuth(account);
  let uploads = account.meta?.uploads;
  if (!uploads) {
    const { data } = await call(`https://www.googleapis.com/youtube/v3/channels?${qs({ part: "contentDetails", mine: "true" })}`, { headers: auth });
    uploads = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  }
  if (!uploads) return { posts: [], next: null };
  const { data: pl } = await call(`https://www.googleapis.com/youtube/v3/playlistItems?${qs({ part: "contentDetails", playlistId: uploads, maxResults: 24, pageToken: after })}`, { headers: auth });
  const ids = (pl.items || []).map((i) => i.contentDetails.videoId).join(",");
  if (!ids) return { posts: [], next: null };
  const { data: vids } = await call(`https://www.googleapis.com/youtube/v3/videos?${qs({ part: "snippet,statistics,contentDetails,status", id: ids })}`, { headers: auth });
  return { posts: (vids.items || []).map(ytItem), next: pl.nextPageToken || null };
}

export async function postDetail({ account, postId }) {
  const auth = ytAuth(account);
  const { data } = await call(`https://www.googleapis.com/youtube/v3/videos?${qs({ part: "snippet,statistics,contentDetails,status", id: postId })}`, { headers: auth });
  const v = data.items?.[0];
  if (!v) throw new PlatformError("This video was not found on the channel.");
  const item = ytItem(v);
  const stats = [
    { key: "views", label: "Views", value: item.views },
    { key: "likes", label: "Likes", value: item.likes },
    { key: "comments", label: "Comments", value: item.comments },
  ];
  let note = "";
  try {
    const { data: r } = await call(`https://youtubeanalytics.googleapis.com/v2/reports?${qs({
      ids: "channel==MINE",
      startDate: (item.at || "2006-01-01").slice(0, 10),
      endDate: ymd(new Date()),
      metrics: "estimatedMinutesWatched,averageViewDuration,averageViewPercentage,shares,subscribersGained",
      filters: `video==${postId}`,
    })}`, { headers: auth });
    const row = r.rows?.[0];
    if (row) {
      stats.push(
        { key: "minutes", label: "Watch time", value: null, text: row[0] >= 60 ? `${Math.round(row[0] / 60)} h` : `${Math.round(row[0])} min` },
        { key: "avd", label: "Avg. view duration", value: null, text: row[1] >= 60 ? `${Math.floor(row[1] / 60)}m ${Math.round(row[1] % 60)}s` : `${Math.round(row[1])}s` },
        { key: "avp", label: "Avg. % watched", value: null, text: `${Math.round(row[2])}%` },
        { key: "shares", label: "Shares", value: row[3] },
        { key: "subs", label: "Subscribers gained", value: row[4] },
      );
    }
  } catch (_) {
    note = "Watch-time numbers come from YouTube Analytics and can take a day or two to appear.";
  }
  const inter = (item.likes || 0) + (item.comments || 0);
  return { ...item, media: [{ kind: "image", url: item.big || item.thumb, thumb: item.thumb }], stats, engagementRate: item.views ? inter / item.views : null, note, linkLabel: "Open on YouTube" };
}

// ---------- Analysis: views, likes, comments for the last 50 videos ----------
export async function analysisPosts({ account }) {
  const out = [];
  let after;
  for (let i = 0; i < 3 && out.length < 50; i++) {
    const r = await feed({ account, after });
    out.push(...r.posts);
    if (!r.next) break;
    after = r.next;
  }
  return out.filter((v) => v.privacy !== "private").map((v) => ({ ...v, reach: null, interactions: (v.likes || 0) + (v.comments || 0) }));
}
