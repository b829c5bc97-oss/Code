// Reminder emails for accounts that can't be posted to automatically (Facebook personal profiles).
// Uses Resend if a key is set in Settings; otherwise the reminder only shows on the Overview screen.

import { call } from "./platforms/common.mjs";

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export async function sendReminder({ settings, post, account, siteUrl, song = null }) {
  const r = settings.reminders || {};
  if (!r.resendKey || !r.to) return { sent: false, reason: "no email set up" };
  const caption = song ? post.captions?.instagram || post.caption || "" : post.captions?.manual || post.captions?.facebook || post.caption || "";
  const why = song
    ? `Instagram only lets you add its songs inside the Instagram app, so here is everything ready. Song: <b>${escapeHtml(song.name)}</b>${song.part ? ` (${escapeHtml(song.part)})` : ""}.`
    : "Facebook doesn't let apps post to personal profiles, so here is everything ready:";
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:15px;color:#14161A">
      <p><b>Time to post on ${escapeHtml(account.name)}.</b></p>
      <p>${why}</p>
      <div style="white-space:pre-wrap;background:#F3F4F7;border-radius:8px;padding:12px">${escapeHtml(caption)}</div>
      <p><a href="${siteUrl}/#/overview">Open Social HQ</a> to copy the caption, download the photo or video, and mark it as posted.</p>
    </div>`;
  await call("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${r.resendKey}` },
    json: { from: r.from || "Social HQ <onboarding@resend.dev>", to: [r.to], subject: `Post now: ${account.name}`, html },
  });
  return { sent: true };
}
