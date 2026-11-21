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
  const note = data.status?.privacyStatus === "private" && post.ytPrivacy !== "private" ? "Uploaded as Private: Google has not finished checking the app yet." : "";
  return { remoteId: data.id, url, note };
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
        const { data: vids } = await call(`https://www.googleapis.com/youtube/v3/videos?${qs({ part: "snippet,statistics", id: ids })}`, { headers: auth });
        for (const v of vids.items || []) {
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
