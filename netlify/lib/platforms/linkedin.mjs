// LinkedIn: your personal profile (Share on LinkedIn, self-serve) and, once LinkedIn approves
// the Community Management API, company pages such as LIFTLINE. Logins last 60 days.

import { call, qs, captionFor, waitFor, PlatformError } from "./common.mjs";
import { tokenOf } from "../accounts.mjs";

const API = "https://api.linkedin.com/rest";

function headers(settings, token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    "LinkedIn-Version": settings.linkedin.version || "202608",
    "X-Restli-Protocol-Version": "2.0.0",
    ...extra,
  };
}

function scopes(settings) {
  const s = ["openid", "profile", "email", "w_member_social"];
  if (settings.linkedin.orgAccess) s.push("w_organization_social", "r_organization_social", "rw_organization_admin");
  return s.join(" ");
}

export function authUrl({ settings, redirectUri, state }) {
  return `https://www.linkedin.com/oauth/v2/authorization?${qs({
    response_type: "code",
    client_id: settings.linkedin.clientId,
    redirect_uri: redirectUri,
    state,
    scope: scopes(settings),
  })}`;
}

export async function callback({ settings, redirectUri, code }) {
  const s = settings.linkedin;
  const { data: tok } = await call("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    form: { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: s.clientId, client_secret: s.clientSecret },
  });
  const token = tok.access_token;
  const exp = new Date(Date.now() + (tok.expires_in || 5184000) * 1000).toISOString();
  const { data: me } = await call("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${token}` } });
  const out = [
    {
      platform: "linkedin",
      kind: "li_member",
      remoteId: me.sub,
      name: me.name || "LinkedIn profile",
      handle: "Personal profile",
      avatar: me.picture || "",
      token,
      refreshToken: tok.refresh_token,
      tokenExpiresAt: exp,
      refreshExpiresAt: tok.refresh_token_expires_in ? new Date(Date.now() + tok.refresh_token_expires_in * 1000).toISOString() : null,
      meta: { urn: `urn:li:person:${me.sub}`, isOrg: false },
    },
  ];
  if (s.orgAccess) {
    try {
      const { data: acls } = await call(`${API}/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`, { headers: headers(settings, token) });
      for (const el of acls.elements || []) {
        const urn = el.organization || el.organizationTarget;
        if (!urn) continue;
        const orgId = urn.split(":").pop();
        let name = `Company page ${orgId}`;
        let vanity = "";
        try {
          const { data: org } = await call(`${API}/organizations/${orgId}`, { headers: headers(settings, token) });
          name = org.localizedName || name;
          vanity = org.vanityName || "";
        } catch (_) { /* name lookup failed */ }
        out.push({
          platform: "linkedin",
          kind: "li_org",
          remoteId: `org${orgId}`,
          name,
          handle: "Company page",
          avatar: "",
          token,
          refreshToken: tok.refresh_token,
          tokenExpiresAt: exp,
          meta: { urn, isOrg: true, vanity },
        });
      }
    } catch (e) {
      // Not approved for company pages yet: keep the personal profile.
    }
  }
  return out;
}

export async function ensureToken({ account, settings }) {
  // LinkedIn gives refresh tokens only to approved apps; otherwise you log in again every 60 days.
  const exp = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : 0;
  const refresh = account.refreshToken;
  if (exp && exp - Date.now() < 7 * 86400000 && refresh) {
    const { decrypt } = await import("../crypto.mjs");
    const { setTokens } = await import("../accounts.mjs");
    const { data } = await call("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      form: { grant_type: "refresh_token", refresh_token: decrypt(refresh), client_id: settings.linkedin.clientId, client_secret: settings.linkedin.clientSecret },
    });
    setTokens(account, { token: data.access_token, refreshToken: data.refresh_token, tokenExpiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString() });
    return { account, changed: true };
  }
  if (exp && exp < Date.now()) throw new PlatformError("LinkedIn login has ended. Click Reconnect on the Accounts screen.", { authProblem: true });
  return { account, changed: false };
}

// LinkedIn's post text format treats some characters as commands; hashtags use a template.
export function littleText(s) {
  return String(s)
    .split(/(#[\p{L}\p{N}_]+)/u)
    .map((p) => (/^#[\p{L}\p{N}_]+$/u.test(p) ? `{hashtag|\\#|${p.slice(1)}}` : p.replace(/[\\|{}@[\]()<>#*_~]/g, (m) => "\\" + m)))
    .join("");
}

async function uploadImage(settings, account, item, ctx) {
  const token = tokenOf(account);
  const { data } = await call(`${API}/images?action=initializeUpload`, {
    method: "POST",
    headers: headers(settings, token),
    json: { initializeUploadRequest: { owner: account.meta.urn } },
  });
  const { uploadUrl, image } = data.value;
  await call(uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: await ctx.bytes(item.id), timeout: 300000 });
  return image;
}

async function uploadVideo(settings, account, item, ctx) {
  const token = tokenOf(account);
  const bytes = await ctx.bytes(item.id);
  const { data } = await call(`${API}/videos?action=initializeUpload`, {
    method: "POST",
    headers: headers(settings, token),
    json: { initializeUploadRequest: { owner: account.meta.urn, fileSizeBytes: bytes.length, uploadCaptions: false, uploadThumbnail: false } },
  });
  const { video, uploadInstructions, uploadToken } = data.value;
  const etags = [];
  for (const part of uploadInstructions) {
    const res = await call(part.uploadUrl, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes.subarray(part.firstByte, part.lastByte + 1), timeout: 300000 });
    etags.push(res.headers.get("etag"));
  }
  await call(`${API}/videos?action=finalizeUpload`, {
    method: "POST",
    headers: headers(settings, token),
    json: { finalizeUploadRequest: { video, uploadToken: uploadToken || "", uploadedPartIds: etags } },
  });
  const ready = await waitFor(async () => {
    const { data: v } = await call(`${API}/videos/${encodeURIComponent(video)}`, { headers: headers(settings, token) });
    if (v.status === "AVAILABLE") return true;
    if (v.status === "PROCESSING_FAILED") throw new PlatformError("LinkedIn could not process the video.");
    return null;
  }, { tries: 60, every: 5000 });
  if (!ready) throw new PlatformError("LinkedIn is still processing the video after 5 minutes.");
  return video;
}

export async function publish({ settings, account, post, ctx }) {
  const token = tokenOf(account);
  const text = captionFor(post, "linkedin");
  const body = {
    author: account.meta.urn,
    commentary: littleText(text),
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  const video = post.media.find((m) => m.kind === "video");
  const images = post.media.filter((m) => m.kind === "image");
  if (video) {
    body.content = { media: { id: await uploadVideo(settings, account, video, ctx), title: post.title || undefined } };
  } else if (images.length === 1) {
    body.content = { media: { id: await uploadImage(settings, account, images[0], ctx) } };
  } else if (images.length > 1) {
    const ids = [];
    for (const img of images.slice(0, 20)) ids.push({ id: await uploadImage(settings, account, img, ctx) });
    body.content = { multiImage: { images: ids } };
  }
  const res = await call(`${API}/posts`, { method: "POST", headers: headers(settings, token), json: body });
  const urn = res.headers.get("x-restli-id") || res.data?.id || "";
  return { remoteId: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : "" };
}

export async function insights({ settings, account }) {
  const token = tokenOf(account);
  if (!account.meta?.isOrg) {
    // Post stats for personal profiles need LinkedIn's approval; Social HQ counts its own posts instead.
    return { name: account.name, avatar: account.avatar, followers: null, followersLabel: "Followers", kpis: [], posts: [], limited: "LinkedIn shares personal-profile stats only with approved apps." };
  }
  const urn = account.meta.urn;
  let followers = null;
  try {
    const { data } = await call(`${API}/networkSizes/${encodeURIComponent(urn)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, { headers: headers(settings, token) });
    followers = data.firstDegreeSize ?? null;
  } catch (_) { /* not approved */ }
  const kpis = [];
  let interactions = 0;
  let reach = 0;
  try {
    const { data } = await call(`${API}/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(urn)}`, { headers: headers(settings, token) });
    const t = data.elements?.[0]?.totalShareStatistics || {};
    reach = t.uniqueImpressionsCount || 0;
    interactions = (t.likeCount || 0) + (t.commentCount || 0) + (t.shareCount || 0) + (t.clickCount || 0);
    kpis.push({ label: "Unique impressions", value: reach, period: "all time" }, { label: "Clicks", value: t.clickCount || 0, period: "all time" }, { label: "Reactions", value: t.likeCount || 0, period: "all time" });
  } catch (_) { /* not approved */ }
  return { name: account.name, followers, followersLabel: "Followers", reach28: reach, interactions28: interactions, engagementRate: reach ? interactions / reach : null, kpis, posts: [] };
}
