// Background work: publishing posts and collecting insights.

import { getPost, savePost, overallStatus, duePosts, claim, releaseClaim, listPosts, forAccount } from "./posts.mjs";

const RETRY_MINUTES = 10;
import { getAccount, saveAccount, listAccounts } from "./accounts.mjs";
import { getSettings } from "./settings.mjs";
import { readAll, deleteMedia } from "./media.mjs";
import { platforms } from "./platforms/index.mjs";
import { sendReminder } from "./notify.mjs";
import { explain, alertPostFailed, alertPostRetrying } from "./alerts.mjs";
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
  const failures = [];
  const retrying = [];

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
      const res = await p.publish({ settings, account: fresh, post: forAccount(post, fresh), ctx });
      post.targets[accId] = { status: "posted", remoteId: res.remoteId || "", url: res.url || "", note: res.note || "", at: new Date().toISOString() };
      if (fresh.status !== "ok" && fresh.status !== "reminder") {
        fresh.status = "ok";
        fresh.lastError = "";
        await saveAccount(fresh);
      }
    } catch (e) {
      const why = explain(e, account.platform);
      const tries = target.tries || 0;
      if (why.retry && tries < 1) {
        // One automatic retry, 10 minutes later. Most network and "busy" errors clear by then.
        const retryAt = new Date(Date.now() + RETRY_MINUTES * 60000).toISOString();
        post.targets[accId] = { status: "pending", tries: tries + 1, retryAt, lastError: errMessage(e), reason: why.reason };
        retrying.push({ account, why, retryAt });
      } else {
        post.targets[accId] = { status: "failed", error: errMessage(e), reason: why.reason, fix: why.fix, tries: tries + 1, at: new Date().toISOString() };
        failures.push({ account, why, retried: tries >= 1 });
      }
      if (why.kind === "login") {
        account.status = "error";
        account.lastError = why.reason;
        await saveAccount(account);
      }
    }
    await savePost(post);
  }

  const waiting = Object.values(post.targets).filter((t) => t.status === "pending" && t.retryAt);
  if (waiting.length) {
    post.status = "scheduled";
    post.retryAt = waiting.map((t) => t.retryAt).sort()[0];
    post.retryRound = (post.retryRound || 0) + 1;
    await savePost(post);
    await releaseClaim(post.id);
  } else {
    post.retryAt = null;
    post.status = overallStatus(post);
    post.publishedAt = new Date().toISOString();
    await savePost(post);
  }
  for (const r of retrying) {
    try {
      await alertPostRetrying(settings, { post, account: r.account, why: r.why, siteUrl, retryAt: r.retryAt });
    } catch (_) { /* alerts never block publishing */ }
  }
  for (const f of failures) {
    try {
      await alertPostFailed(settings, { post, account: f.account, why: f.why, siteUrl, retried: f.retried });
    } catch (_) { /* alerts never block publishing */ }
  }
  if (waiting.length) return post;

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
      if (impl[fresh.platform]?.analysisPosts) {
        try {
          const { collectAnalysis } = await import("./analysis.mjs");
          await collectAnalysis({ account: fresh, settings, impl });
        } catch (_) { /* analysis is refreshed next run */ }
      }
      if (snap.avatar && (snap.avatar !== fresh.avatar || !fresh.avatarCached || Date.now() - new Date(fresh.avatarAt || 0) > 3 * 86400000)) {
        const { cacheAvatar } = await import("./avatars.mjs");
        if (!(await cacheAvatar(fresh, snap.avatar))) fresh.avatar = snap.avatar;
      }
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
  if (!only && !platformsOverride) {
    try {
      const { refreshCompetitors } = await import("./competitors.mjs");
      await refreshCompetitors();
    } catch (_) { /* competitor numbers are a bonus; never fail the run */ }
    // Once a day: check every login and warn before one ends.
    try {
      const last = await getJSON("meta/logincheck");
      if (!last || Date.now() - new Date(last.at).getTime() > 20 * 3600000) {
        const { checkLogins } = await import("./logincheck.mjs");
        const r = await checkLogins({ siteUrl: (process.env.URL || "").replace(/\/$/, "") });
        await setJSON("meta/logincheck", { at: new Date().toISOString(), ...r });
      }
    } catch (e) {
      console.error("Login check failed:", errMessage(e));
    }
  }
  await setJSON("meta/insights-run", { at: new Date().toISOString(), results });
  return results;
}

export async function getModel(account) {
  return (await getJSON(`bt/${account.id}`)) || model(account, null);
}
