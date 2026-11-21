// Watchdog and honest timing: overdue posts are flagged (never shown as fine), late posts show when they really went out.
// Run: HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 node test/watchdog.mjs
import assert from "node:assert/strict";
import { upsertConnected } from "../netlify/lib/accounts.mjs";
import { createPost, savePost, getPost, timingOf } from "../netlify/lib/posts.mjs";
import { runWatchdog, runScheduler } from "../netlify/lib/jobs.mjs";
import { alertLog } from "../netlify/lib/alerts.mjs";
import { overview } from "../netlify/lib/views.mjs";
import { callTool } from "../netlify/lib/mcp-tools.mjs";

const realFetch = globalThis.fetch;
const started = [];
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith("/internal/publish")) { started.push(JSON.parse(init.body).postId); return new Response("{}", { status: 202 }); }
  return realFetch(url, init);
};

await upsertConnected({ platform: "instagram", kind: "ig_business", remoteId: "77", name: "DeskCrew", handle: "@deskcrew_", token: "T" });
const media = [{ id: "v", kind: "video", name: "a.mp4", mime: "video/mp4" }];

// 1. Timer never ran + a post 6h40m overdue
const six = new Date(Date.now() - 400 * 60000).toISOString();
const p = await createPost({ accountIds: ["instagram-77"], type: "reel", caption: "They work harder than me", media, scheduledAt: six });
assert.equal(timingOf(p).overdueMin >= 399, true);
let ov = await overview();
assert.equal(ov.posting.ok, false);
assert.ok(ov.attention.some((a) => /NOT running/.test(a.title)));
assert.ok(ov.attention.some((a) => /overdue/.test(a.title)));
const view = await callTool("get_post", { post_id: p.id });
assert.equal(view.status, "overdue_not_posted");
assert.match(view.warning, /NOT POSTED YET/);
console.log("✓ an overdue post is shown as 'Overdue · not posted' everywhere, including to Claude");

const w = await runWatchdog("https://hq.test");
assert.ok(w.alerted.includes("stopped"));
assert.ok(w.alerted.includes(p.id));
assert.ok(started.includes(p.id), "watchdog pushes the overdue post out");
const titles = (await alertLog()).map((a) => a.title);
assert.ok(titles.some((t) => /Automatic posting has stopped/.test(t)));
assert.ok(titles.some((t) => /6h \d+m late and not out yet/.test(t)));
const again = await runWatchdog("https://hq.test");
assert.ok(!again.alerted.includes(p.id), "the same overdue alert isn't repeated");
console.log("✓ watchdog: alerts when posting stops or a post is late, and pushes the post out (once per post)");

// 2. After it goes out late, the real time and lateness are kept
const done = await getPost(p.id);
done.status = "done";
done.targets["instagram-77"] = { status: "posted", at: new Date().toISOString(), url: "https://instagram.com/reel/x" };
await savePost(done);
const t = timingOf(done);
assert.equal(t.overdueMin, 0);
assert.ok(t.lateMin >= 399);
const v2 = await callTool("get_post", { post_id: p.id });
assert.match(v2.went_out_late, /Went out \d+ minutes after its planned time/);
assert.ok(v2.accounts[0].posted_at);
console.log("✓ a late post shows when it really went out and how late");

// 3. Heartbeat makes 'running' true
await runScheduler("https://hq.test");
ov = await overview();
assert.equal(ov.posting.ok, true);
console.log("✓ Overview says 'Automatic posting is running' only when the timer has run in the last 15 minutes");
globalThis.fetch = realFetch;
console.log("\nWatchdog test passed.");
