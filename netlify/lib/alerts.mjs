// Failure alerts and login warnings.
// Channels (all free): WhatsApp to yourself through CallMeBot, a phone notification through the
// ntfy app, and email through Resend. Every alert is also kept in a list shown on the Overview
// and Settings screens, so nothing is lost when no channel is set up.

import { call } from "./platforms/common.mjs";
import { getJSON, setJSON } from "./store.mjs";
import { errMessage } from "./util.mjs";
import { pushAll } from "./push.mjs";

const LOG = "alert/log";

// Turn a raw platform error into a plain reason, what to do about it, and whether a retry can help.
export function explain(error, platform = "") {
  const raw = errMessage(error) || "";
  const s = raw.toLowerCase();
  const name = { instagram: "Instagram", facebook: "Facebook", youtube: "YouTube", linkedin: "LinkedIn", pinterest: "Pinterest" }[platform] || "The platform";
  const out = (kind, reason, fix, retry) => ({ kind, reason, fix, retry, raw });
  if (/aspect ratio|\bratio\b/.test(s))
    return out("shape", "The photo or video shape isn't allowed here.", "Instagram photos must be between 4:5 (tall) and 1.91:1 (wide); Reels and Stories should be 9:16.", false);
  if (/duration|too long|longer than|video length|exceeds the maximum length/.test(s))
    return out("length", "The video is too long for this kind of post.", "Reels can be up to 15 minutes (90 seconds to show in the Reels tab); Stories up to 60 seconds; YouTube Shorts up to 3 minutes.", false);
  if (/too large|file size|too big|payload|maximum size|413/.test(s))
    return out("size", "The file is too big.", "Keep videos under about 300 MB for Reels and photos under 8 MB.", false);
  if (/jpeg|unsupported|codec|format|could not be processed|media type|corrupt/.test(s))
    return out("format", "The file type or format isn't accepted.", "Use JPEG photos and MP4 (H.264) videos.", false);
  const code = error?.data?.error?.code;
  // Meta has paused the app or the developer account ("API access blocked"): nothing is wrong with
  // the post. It waits and goes out by itself once Meta lifts the pause.
  if (/api access blocked|app is restricted|application has been deleted|app not active|application does not have the capability/.test(s))
    return out("paused", `${name} has paused Social HQ's access (Meta asks for an account check on developers.facebook.com).`, "Complete the check on developers.facebook.com. The post waits and goes out by itself afterwards.", true);
  if (code === 190 || error?.status === 401 || /expired|session has been invalidated|error validating access token|invalid_grant|invalid oauth|token is invalid|revoked|unauthori[sz]ed client/.test(s))
    return out("login", `${name} login for this account has expired or was removed.`, "Open Accounts and press Reconnect on this account, then press Retry on the post.", false);
  if (code === 10 || code === 200 || /permission|not authori[sz]ed|insufficient|forbidden/.test(s))
    return out("permission", `${name} says Social HQ isn't allowed to do this on this account.`, "Reconnect the account and tick every permission on the login screen.", false);
  if (/quota/.test(s)) return out("limit", `${name}'s daily limit for apps was reached.`, "It resets at midnight Pacific time (about 1:30 PM India time). Social HQ tries again.", true);
  if (/rate limit|too many|request limit|\(#4\)|\(#17\)|\(#32\)|\(#613\)|429/.test(s))
    return out("busy", `${name} is limiting requests right now.`, "Nothing to do — Social HQ tries again.", true);
  if (/timed out|timeout|etimedout|econnreset|fetch failed|socket|5\d\d|temporarily|unavailable|try again/.test(s))
    return out("network", `${name} didn't answer in time.`, "Nothing to do — Social HQ tries again.", true);
  return out("other", `${name} refused the post.`, "Open the post to see the exact message, fix it, then press Retry.", true);
}

export async function alertLog() {
  return (await getJSON(LOG)) || [];
}

async function remember(entry) {
  const log = await alertLog();
  log.unshift(entry);
  await setJSON(LOG, log.slice(0, 60));
}

// Send one alert to every channel that is set up. `key` stops the same alert going out twice.
export async function sendAlert(settings, { key, title, text, link = "" }, { fetchImpl } = {}) {
  if (key) {
    const seen = await getJSON(`alert/sent/${key}`);
    if (seen) return { skipped: true };
    await setJSON(`alert/sent/${key}`, { at: new Date().toISOString() });
  }
  const a = settings.alerts || {};
  const r = settings.reminders || {};
  const sent = [];
  const errors = [];
  const plain = `${title}\n${text}${link ? `\n${link}` : ""}`;
  const go = async (channel, fn) => {
    try {
      await fn();
      sent.push(channel);
    } catch (e) {
      errors.push(`${channel}: ${errMessage(e)}`);
    }
  };
  const doCall = fetchImpl || call;
  if (a.whatsappPhone && a.callmebotKey) {
    await go("WhatsApp", () => doCall(`https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(a.whatsappPhone.replace(/[^\d+]/g, ""))}&text=${encodeURIComponent(`*Social HQ* — ${plain}`)}&apikey=${encodeURIComponent(a.callmebotKey)}`, { method: "GET" }));
  }
  // Notifications from the Social HQ app on your phone (needs "Turn on notifications" on that phone once).
  try {
    const r2 = await pushAll({ title: `Social HQ: ${title}`, body: text, url: link ? new URL(link).hash ? `/${new URL(link).hash}` : "/" : "/", tag: key || "" });
    if (r2.sent) sent.push(r2.sent > 1 ? `Phone app (${r2.sent} devices)` : "Phone app");
  } catch (e) {
    errors.push(`Phone app: ${errMessage(e)}`);
  }
  if (a.ntfyTopic) {
    await go("Phone", () => doCall(`https://ntfy.sh/${encodeURIComponent(a.ntfyTopic)}`, { method: "POST", headers: { Title: `Social HQ: ${title}`.slice(0, 120), ...(link ? { Click: link } : {}), Tags: "warning" }, body: `${text}` }));
  }
  const to = a.email || r.to;
  if (r.resendKey && to) {
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#14161A"><p><b>${esc(title)}</b></p><p style="white-space:pre-wrap">${esc(text)}</p>${link ? `<p><a href="${esc(link)}">Open Social HQ</a></p>` : ""}</div>`;
    await go("Email", () => doCall("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${r.resendKey}` }, json: { from: r.from || "Social HQ <onboarding@resend.dev>", to: [to], subject: `Social HQ: ${title}`, html } }));
  }
  await remember({ at: new Date().toISOString(), title, text, link, sent, errors });
  return { sent, errors };
}

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function ist(iso) {
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export async function alertPostFailed(settings, { post, account, why, siteUrl, retried }) {
  const what = (post.caption || post.title || "").replace(/\s+/g, " ").slice(0, 70);
  return await sendAlert(settings, {
    key: `fail-${post.id}-${account.id}-${post.retryRound || 0}`,
    title: `${account.name} post failed`,
    text: `${post.type || "post"} for ${ist(post.scheduledAt)}${what ? ` — "${what}"` : ""}\nWhy: ${why.reason}\nFix: ${why.fix}${retried ? "\n(Social HQ already tried once more.)" : ""}`,
    link: `${siteUrl}/#/create?id=${post.id}`,
  });
}

export async function alertPostRetrying(settings, { post, account, why, siteUrl, retryAt }) {
  // Only the final failure is worth a ping; a retry is noted on the post and in the alert list.
  await remember({ at: new Date().toISOString(), title: `${account.name}: trying again at ${ist(retryAt)}`, text: why.reason, link: `${siteUrl}/#/create?id=${post.id}`, sent: [], errors: [] });
}
