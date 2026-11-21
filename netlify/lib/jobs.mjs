// Background work: publishing posts and collecting insights.

import { getPost, savePost, overallStatus, duePosts, claim, releaseClaim, listPosts } from "./posts.mjs";
import { getAccount, saveAccount, listAccounts } from "./accounts.mjs";
import { getSettings } from "./settings.mjs";
import { readAll, deleteMedia } from "./media.mjs";
import { platforms } from "./platforms/index.mjs";
import { sendReminder } from "./notify.mjs";
import { model } from "./besttime.mjs";
import { getJSON, setJSON } from "./store.mjs";
import { internalSecret } from "./crypto.mjs";
import { errMessage, istDateKey } from "./util.mjs";

export function makeCtx(siteUrl) {
  const cache = new Map();
  return {
    siteUrl,
    publicUrl: (id) => `${siteUrl}/m/${id}.jpg`,
    async bytes(id) {
      if (!cache.has(id)) cache.set(id, await readAll(id));
      return cache.get(id);
    },
  };
}

export async function publishPost(postId, siteUrl, { platformsOverride } = {}) {
  const impl = platformsOverride || platforms;
  let post = await getPost(postId);
  if (!["scheduled", "publishing"].includes(post.status)) return post;
  post.status = "publishing";
  post.publishStartedAt = new Date().toISOString();
  post = await savePost(post);
  const settings = await getSettings();
  const ctx = makeCtx(siteUrl);

  for (const accId of post.accountIds) {
    const target = post.targets[accId] || { status: "pending" };
    if (target.status !== "pending") continue;
    let account;
    try {
      account = await getAccount(accId);
    } catch (_) {
      post.targets[accId] = { status: "failed", error: "This account was removed.", at: new Date().toISOString() };
      await savePost(post);
      continue;
    }
    if (account.platform === "manual") {
      let note = "";
      try {
        const r = await sendReminder({ settings, post, account, siteUrl });
        note = r.sent ? "Reminder email sent." : "Reminder is on the Overview screen.";
      } catch (e) {
        note = `Reminder email failed (${errMessage(e)}); it is on the Overview screen.`;
      }
      post.targets[accId] = { status: "reminder", note, at: new Date().toISOString() };
      await savePost(post);
      continue;
    }
    const p = impl[account.platform];
    try {
      const { account: fresh, changed } = await p.ensureToken({ account, settings });
      if (changed) await saveAccount(fresh);
      const res = await p.publish({ settings, account: fresh, post, ctx });
      post.targets[accId] = { status: "posted", remoteId: res.remoteId || "", url: res.url || "", note: res.note || "", at: new Date().toISOString() };
      if (fresh.status !== "ok" && fresh.status !== "reminder") {
        fresh.status = "ok";
        fresh.lastError = "";
        await saveAccount(fresh);
      }
    } catch (e) {
      post.targets[accId] = { status: "failed", error: errMessage(e), at: new Date().toISOString() };
      if (e.authProblem) {
        account.status = "error";
        account.lastError = errMessage(e);
        await saveAccount(account);
      }
    }
    await savePost(post);
  }

  post.status = overallStatus(post);
  post.publishedAt = new Date().toISOString();
  await savePost(post);

  // Free storage once everything is out and nothing needs a manual repost.
  const allPosted = Object.values(post.targets).every((t) => t.status === "posted");
  if (allPosted) {
    for (const m of post.media) {
      try {
        await deleteMedia(m.id);
      } catch (_) { /* already gone */ }
    }
    post.mediaDeleted = true;
    await savePost(post);
  }
  return post;
}

// Hand a claimed post to the background publisher. If that fails, release the claim so the
// next scheduler run (5 minutes later) tries again.
export async function triggerPublish(siteUrl, postId) {
  try {
    const res = await fetch(`${siteUrl}/internal/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hq-secret": internalSecret() },
      body: JSON.stringify({ postId }),
    });
    if (res.status === 202 || res.ok) return true;
    console.error("Publisher answered", res.status);
  } catch (e) {
    console.error("Could not start publisher:", errMessage(e));
  }
  await releaseClaim(postId);
  return false;
}

// A publish job that has been "going out" for over 20 minutes has died (the background limit is 15).
async function recoverStale(now) {
  const today = istDateKey(now);
  const posts = await listPosts({ from: istDateKey(new Date(now.getTime() - 2 * 86400000)), to: today });
  for (const p of posts) {
    if (p.status !== "publishing") continue;
    const started = new Date(p.publishStartedAt || p.updatedAt || 0).getTime();
    if (now.getTime() - started < 20 * 60000) continue;
    for (const t of Object.values(p.targets || {})) if (t.status === "pending") Object.assign(t, { status: "failed", error: "Timed out while uploading. Press Retry." });
    p.status = overallStatus({ ...p, status: "done" });
    await savePost(p);
  }
}

export async function runScheduler(siteUrl, now = new Date()) {
  await recoverStale(now);
  const due = await duePosts(now);
  const fired = [];
  for (const p of due) {
    if (await claim(p.id)) {
      if (await triggerPublish(siteUrl, p.id)) fired.push(p.id);
    }
  }
  return fired;
}

export async function collectInsights({ only, platformsOverride } = {}) {
  const impl = platformsOverride || platforms;
  const settings = await getSettings();
  const accounts = await listAccounts();
  const today = istDateKey(new Date());
  const results = [];
  for (const account of accounts) {
    if (only && account.id !== only) continue;
    if (account.platform === "manual") continue;
    const p = impl[account.platform];
    if (!p) continue;
    try {
      const { account: fresh, changed } = await p.ensureToken({ account, settings });
      const snap = await p.insights({ settings, account: fresh });
      snap.at = new Date().toISOString();
      await setJSON(`ins/${fresh.id}/latest`, snap);
      if (typeof snap.followers === "number" || typeof snap.reach7 === "number") {
        const hist = ((await getJSON(`ins/${fresh.id}/hist`)) || []).filter((h) => h.d !== today);
        hist.push({ d: today, followers: snap.followers ?? null, reach7: snap.reach7 ?? null });
        await setJSON(`ins/${fresh.id}/hist`, hist.slice(-120));
      }
      await setJSON(`bt/${fresh.id}`, model(fresh, snap));
      if (snap.avatar) fresh.avatar = snap.avatar;
      if (fresh.platform === "pinterest" && impl.pinterest.refreshBoards) {
        try {
          await impl.pinterest.refreshBoards(fresh);
        } catch (_) { /* keep old boards */ }
      }
      if (fresh.status === "error") fresh.status = "ok";
      fresh.lastError = "";
      fresh.insightsAt = snap.at;
      await saveAccount(fresh);
      results.push({ id: fresh.id, ok: true });
      void changed;
    } catch (e) {
      account.lastError = errMessage(e);
      if (e.authProblem) account.status = "error";
      await saveAccount(account);
      results.push({ id: account.id, ok: false, error: errMessage(e) });
    }
  }
  await setJSON("meta/insights-run", { at: new Date().toISOString(), results });
  return results;
}

export async function getModel(account) {
  return (await getJSON(`bt/${account.id}`)) || model(account, null);
}
