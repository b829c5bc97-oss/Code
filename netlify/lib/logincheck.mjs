// Daily login check. Warns a few days before an account's login ends, and as soon as one stops
// working, so you can reconnect it before a post fails.
//
// Meta (Instagram and Facebook): asks Meta's debug_token when the login, and its 90-day data access,
// end. Google, LinkedIn and Pinterest: refreshes the login the same way publishing does.

import { listAccounts, saveAccount, tokenOf } from "./accounts.mjs";
import { getSettings } from "./settings.mjs";
import { platforms } from "./platforms/index.mjs";
import { call, qs } from "./platforms/common.mjs";
import { sendAlert, explain } from "./alerts.mjs";
import { errMessage } from "./util.mjs";

const DAY = 86400000;

async function metaLogin(settings, account, fetchCall) {
  const k = settings.instagram?.appId ? settings.instagram : settings.facebook || {};
  const appId = k.appId || settings.facebook?.appId;
  const secret = k.appSecret || settings.facebook?.appSecret;
  if (!appId || !secret) return {};
  const v = settings.general?.graphVersion || "v25.0";
  const { data } = await fetchCall(`https://graph.facebook.com/${v}/debug_token?${qs({ input_token: tokenOf(account), access_token: `${appId}|${secret}` })}`);
  const d = data?.data || {};
  const ends = [d.expires_at, d.data_access_expires_at].filter((x) => Number(x) > 0).map((x) => Number(x) * 1000);
  return {
    problem: d.is_valid === false ? d.error?.message || "Meta says this login is no longer valid." : "",
    endsAt: ends.length ? new Date(Math.min(...ends)).toISOString() : null,
  };
}

export async function checkLogins({ siteUrl, now = new Date(), platformsOverride, fetchCall = call } = {}) {
  const impl = platformsOverride || platforms;
  const settings = await getSettings();
  const warnDays = Math.max(1, Number(settings.alerts?.loginDays || 7));
  const today = now.toISOString().slice(0, 10);
  const report = [];
  for (const a of await listAccounts()) {
    if (a.platform === "manual") continue;
    let problem = "";
    let endsAt = null;
    try {
      if (a.platform === "instagram" || a.platform === "facebook") {
        ({ problem = "", endsAt = null } = await metaLogin(settings, a, fetchCall));
      } else if (impl[a.platform]?.ensureToken) {
        const { account: fresh, changed } = await impl[a.platform].ensureToken({ account: a, settings });
        if (changed) await saveAccount(fresh);
        endsAt = a.platform === "pinterest" ? fresh.refreshExpiresAt || null : a.platform === "linkedin" ? fresh.refreshExpiresAt || fresh.tokenExpiresAt || null : null;
      }
    } catch (e) {
      const why = explain(e, a.platform);
      if (why.kind === "login" || why.kind === "permission") problem = why.reason;
      else {
        report.push({ id: a.id, name: a.name, note: `Could not check: ${errMessage(e)}` });
        continue;
      }
    }

    const fresh = { ...a, loginCheckedAt: now.toISOString(), loginEndsAt: endsAt };
    const daysLeft = endsAt ? Math.ceil((new Date(endsAt).getTime() - now.getTime()) / DAY) : null;
    if (problem) {
      fresh.status = "error";
      fresh.lastError = problem;
      await sendAlert(settings, {
        key: `login-bad-${a.id}-${today}`,
        title: `${a.name}: login stopped working`,
        text: `${problem}\nPosts to this account will fail until you reconnect it. Open Accounts and press Reconnect.`,
        link: `${siteUrl}/#/accounts`,
      });
    } else if (daysLeft !== null && daysLeft <= warnDays) {
      await sendAlert(settings, {
        key: `login-ends-${a.id}-${String(endsAt).slice(0, 10)}`,
        title: `${a.name}: login ends in ${Math.max(daysLeft, 0)} day${daysLeft === 1 ? "" : "s"}`,
        text: `Reconnect it before ${new Date(endsAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })} so scheduled posts keep going out. It takes one click on the Accounts screen.`,
        link: `${siteUrl}/#/accounts`,
      });
    } else if (a.status === "error" && !problem && (a.platform === "instagram" || a.platform === "facebook") && endsAt) {
      // Meta says the login is fine again (for example after a reconnect elsewhere).
      fresh.status = "ok";
      fresh.lastError = "";
    }
    await saveAccount(fresh);
    report.push({ id: a.id, name: a.name, endsAt, daysLeft, problem });
  }
  return { checked: report.length, accounts: report };
}
