// Pinterest API v5. Until Pinterest grants Standard access, new pins go to the sandbox
// (visible only to you). Flip "sandbox" off in Settings once approved.

import { call, qs, captionFor, waitFor, ymd, daysAgo, PlatformError } from "./common.mjs";
import { tokenOf, refreshTokenOf, setTokens } from "../accounts.mjs";

const SCOPES = ["boards:read", "boards:write", "pins:read", "pins:write", "user_accounts:read"];

function readBase() {
  return "https://api.pinterest.com/v5";
}

function writeBase(settings) {
  return settings.pinterest.sandbox ? "https://api-sandbox.pinterest.com/v5" : "https://api.pinterest.com/v5";
}

function basic(settings) {
  return "Basic " + Buffer.from(`${settings.pinterest.appId}:${settings.pinterest.appSecret}`).toString("base64");
}

export function authUrl({ settings, redirectUri, state }) {
  return `https://www.pinterest.com/oauth/?${qs({
    client_id: settings.pinterest.appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(","),
    state,
  })}`;
}

async function boards(token) {
  const out = [];
  let bookmark = "";
  for (let i = 0; i < 5; i++) {
    const { data } = await call(`${readBase()}/boards?${qs({ page_size: 100, bookmark })}`, { headers: { Authorization: `Bearer ${token}` } });
    for (const b of data.items || []) out.push({ id: b.id, name: b.name });
    bookmark = data.bookmark;
    if (!bookmark) break;
  }
  return out;
}

export async function callback({ settings, redirectUri, code }) {
  const { data: tok } = await call(`${readBase()}/oauth/token`, {
    method: "POST",
    headers: { Authorization: basic(settings) },
    form: { grant_type: "authorization_code", code, redirect_uri: redirectUri },
  });
  const auth = { Authorization: `Bearer ${tok.access_token}` };
  const { data: me } = await call(`${readBase()}/user_account`, { headers: auth });
  let bl = [];
  try {
    bl = await boards(tok.access_token);
  } catch (_) { /* boards later */ }
  return [
    {
      platform: "pinterest",
      kind: "pin_user",
      remoteId: me.username,
      name: me.business_name || me.username,
      handle: "@" + me.username,
      avatar: me.profile_image || "",
      token: tok.access_token,
      refreshToken: tok.refresh_token,
      tokenExpiresAt: new Date(Date.now() + (tok.expires_in || 2592000) * 1000).toISOString(),
      refreshExpiresAt: tok.refresh_token_expires_in ? new Date(Date.now() + tok.refresh_token_expires_in * 1000).toISOString() : null,
      meta: { boards: bl, defaultBoardId: bl[0]?.id || "" },
    },
  ];
}

export async function ensureToken({ account, settings }) {
  const exp = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : 0;
  if (exp - Date.now() > 3 * 86400000) return { account, changed: false };
  const rt = refreshTokenOf(account);
  if (!rt) throw new PlatformError("Pinterest login needs to be reconnected.", { authProblem: true });
  const { data } = await call(`${readBase()}/oauth/token`, {
    method: "POST",
    headers: { Authorization: basic(settings) },
    form: { grant_type: "refresh_token", refresh_token: rt },
  });
  setTokens(account, {
    token: data.access_token,
    refreshToken: data.refresh_token,
    tokenExpiresAt: new Date(Date.now() + (data.expires_in || 2592000) * 1000).toISOString(),
    refreshExpiresAt: data.refresh_token_expires_in ? new Date(Date.now() + data.refresh_token_expires_in * 1000).toISOString() : undefined,
  });
  return { account, changed: true };
}

export async function refreshBoards(account) {
  const bl = await boards(tokenOf(account));
  account.meta = { ...(account.meta || {}), boards: bl, defaultBoardId: account.meta?.defaultBoardId || bl[0]?.id || "" };
  return account;
}

export async function publish({ settings, account, post, ctx }) {
  const token = tokenOf(account);
  const auth = { Authorization: `Bearer ${token}` };
  const boardId = post.boardIds?.[account.id] || account.meta?.defaultBoardId;
  if (!boardId) throw new PlatformError("Pick a Pinterest board for this pin.");
  const description = captionFor(post, "pinterest").slice(0, 800);
  const item = post.media[0];
  let media_source;
  if (item.kind === "image") {
    const bytes = await ctx.bytes(item.id);
    media_source = { source_type: "image_base64", content_type: item.mime === "image/png" ? "image/png" : "image/jpeg", data: bytes.toString("base64") };
  } else {
    const { data: reg } = await call(`${writeBase(settings)}/media`, { method: "POST", headers: auth, json: { media_type: "video" } });
    const fd = new FormData();
    for (const [k, v] of Object.entries(reg.upload_parameters || {})) fd.append(k, v);
    fd.append("file", new Blob([await ctx.bytes(item.id)], { type: item.mime || "video/mp4" }), item.name || "video.mp4");
    await call(reg.upload_url, { method: "POST", body: fd, timeout: 600000 });
    const ok = await waitFor(async () => {
      const { data: st } = await call(`${writeBase(settings)}/media/${reg.media_id}`, { headers: auth });
      if (st.status === "succeeded") return true;
      if (st.status === "failed") throw new PlatformError("Pinterest could not process the video.");
      return null;
    }, { tries: 60, every: 5000 });
    if (!ok) throw new PlatformError("Pinterest is still processing the video after 5 minutes.");
    media_source = { source_type: "video_id", media_id: reg.media_id, cover_image_key_frame_time: 1 };
  }
  const { data } = await call(`${writeBase(settings)}/pins`, {
    method: "POST",
    headers: auth,
    json: { board_id: boardId, title: (post.title || "").slice(0, 100) || undefined, description, link: post.link || undefined, media_source },
  });
  const note = settings.pinterest.sandbox ? "Posted to the Pinterest sandbox: only you can see it until Pinterest approves the app." : "";
  return { remoteId: data.id, url: `https://www.pinterest.com/pin/${data.id}/`, note };
}

export async function insights({ account }) {
  const auth = { Authorization: `Bearer ${tokenOf(account)}` };
  const { data: me } = await call(`${readBase()}/user_account`, { headers: auth });
  let imp28 = 0, imp7 = 0, saves = 0, clicks = 0, outbound = 0, eng = 0;
  try {
    const { data } = await call(`${readBase()}/user_account/analytics?${qs({ start_date: ymd(daysAgo(28)), end_date: ymd(new Date()), metric_types: "IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK,ENGAGEMENT" })}`, { headers: auth });
    const daily = data.all?.daily_metrics || [];
    daily.forEach((d, i) => {
      const m = d.metrics || {};
      imp28 += m.IMPRESSION || 0; saves += m.SAVE || 0; clicks += m.PIN_CLICK || 0; outbound += m.OUTBOUND_CLICK || 0; eng += m.ENGAGEMENT || 0;
      if (i >= daily.length - 7) imp7 += m.IMPRESSION || 0;
    });
  } catch (_) { /* analytics not available */ }
  return {
    name: me.business_name || me.username,
    avatar: me.profile_image || "",
    followers: me.follower_count ?? 0,
    followersLabel: "Followers",
    reach7: imp7,
    reach28: imp28,
    interactions28: eng,
    engagementRate: imp28 ? eng / imp28 : null,
    kpis: [
      { label: "Impressions", value: imp28, period: "28 days" },
      { label: "Saves", value: saves, period: "28 days" },
      { label: "Pin clicks", value: clicks, period: "28 days" },
      { label: "Clicks to your site", value: outbound, period: "28 days" },
    ],
    posts: [],
  };
}
