// Local preview server with demo data (in-memory). Run:
// HQ_LOCAL=1 MASTER_KEY=local-test-master-key-123 SETUP_CODE=123456 node test/dev-server.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { handle } from "../netlify/functions/api.mjs";
import { upsertConnected, addReminderAccount, updateAccount } from "../netlify/lib/accounts.mjs";
import { collectInsights } from "../netlify/lib/jobs.mjs";
import { createPost } from "../netlify/lib/posts.mjs";
import { setJSON } from "../netlify/lib/store.mjs";
import { istToDate, istDateKey, addDaysKey } from "../netlify/lib/util.mjs";

const PORT = 8899;
const BASE = `http://localhost:${PORT}`;
const pub = new URL("../public/", import.meta.url).pathname;

// --- demo data ---
const mk = async (platform, remoteId, name, handle, brand, cadence = 0, meta) => {
  const a = await upsertConnected({ platform, kind: "x", remoteId, name, handle, token: "t", tokenExpiresAt: platform === "linkedin" ? new Date(Date.now() + 6 * 86400000).toISOString() : null, meta });
  await updateAccount(a.id, { brand, cadence });
  return a;
};
await mk("instagram", "1", "LIFTLINE", "@info.liftline", "LIFTLINE", 4);
await mk("facebook", "2", "Lift Line", "Facebook Page", "LIFTLINE", 4);
await mk("youtube", "3", "LIFTLINE Shorts", "YouTube", "LIFTLINE", 4);
await mk("pinterest", "infoliftline", "infoliftline", "@infoliftline", "LIFTLINE", 2, { boards: [{ id: "b1", name: "Forklifts" }], defaultBoardId: "b1" });
await mk("instagram", "4", "MM Spares", "@mmspares", "MM Spares", 2);
await mk("facebook", "5", "MM Spares", "Facebook Page", "MM Spares", 2);
await mk("instagram", "6", "KAIU", "@kaiu", "KAIU", 3);
await mk("instagram", "7", "Coinwise Kids", "@coinwisekids", "Coinwise Kids", 4);
await mk("instagram", "8", "Wrong Door", "@wrongdoor", "Wrong Door", 4);
await mk("instagram", "9", "The Backstory", "@thebackstorydaily", "The Backstory", 4);
await mk("linkedin", "10", "Pratham Bansal", "Personal profile", "Personal", 2, { urn: "urn:li:person:10" });
await addReminderAccount({ name: "Pratham Bansal (profile)", brand: "Personal" });

const fake = (followers) => ({
  ensureToken: async ({ account }) => ({ account, changed: false }),
  refreshBoards: async (a) => a,
  insights: async () => ({
    followers, followersLabel: "Followers", reach7: Math.round(followers * 7), reach28: followers * 25, views28: followers * 40, interactions28: Math.round(followers * 1.2), engagementRate: 0.048,
    kpis: [{ label: "Accounts reached", value: followers * 25, period: "28 days" }, { label: "Views", value: followers * 40, period: "28 days" }, { label: "Interactions", value: Math.round(followers * 1.2), period: "28 days" }],
    posts: [0, 1, 2, 3, 4, 5].map((i) => ({ id: "p" + i, title: ["Mini Pro in a warehouse", "OneTon on one charge", "HeavyLift Pro loading", "Lunch post", "Truck-Mounted Stacker", "Barrel lifter"][i], type: "Reel", at: new Date(Date.now() - (i * 2 + 1) * 86400000 + (i % 2 ? 0 : 5 * 3600000)).toISOString(), interactions: 300 - i * 40, views: 12000 - i * 1500, reach: 9000 - i * 1000 })),
  }),
});
const P = { instagram: fake(1240), facebook: fake(410), youtube: fake(260), pinterest: fake(85), linkedin: fake(2950) };
await collectInsights({ platformsOverride: P });
// pretend a week of history
for (const id of ["instagram-1", "instagram-7", "instagram-8"]) {
  const hist = [];
  for (let i = 10; i >= 0; i--) hist.push({ d: addDaysKey(istDateKey(new Date()), -i), followers: 1100 + (10 - i) * 14, reach7: 7000 + (10 - i) * 300 });
  await setJSON(`ins/${id}/hist`, hist);
}
const today = istDateKey(new Date());
const at = (dOff, hm) => istToDate(addDaysKey(today, dOff), hm).toISOString();
const img = [{ id: "m1", kind: "image", name: "a.jpg", size: 10, mime: "image/jpeg" }];
const vid = [{ id: "m2", kind: "video", name: "reel.mp4", size: 10, mime: "video/mp4" }];
const plan = [
  [0, "19:30", ["instagram-1", "facebook-2"], "reel", "Mini Pro in a warehouse — lifts 300 kg with one person", vid],
  [0, "20:00", ["instagram-8"], "reel", "Episode 12 — you decide which door", vid],
  [0, "21:30", ["instagram-9"], "reel", "Why your tea got costlier", vid],
  [1, "09:30", ["linkedin-10"], "post", "Lessons from the China supplier visit", []],
  [1, "12:30", ["instagram-7"], "reel", "Word of the day: Savings", vid],
  [2, "19:30", ["instagram-1"], "reel", "HeavyLift Pro loading a truck", vid, true],
  [2, "18:00", ["youtube-3"], "short", "OneTon lifts a full pallet", vid],
  [3, "13:30", ["facebook-5"], "post", "New stock: forklift spare parts", img],
  [3, "19:00", ["instagram-6"], "post", "Barware for the wedding season", img],
  [4, "21:00", ["pinterest-infoliftline"], "pin", "OneTon spec card", img],
];
for (const [d, hm, ids, type, caption, media, ok] of plan) {
  const t = at(d, hm);
  if (new Date(t) < new Date()) continue;
  try {
    await createPost({ accountIds: ids, type, caption, title: caption.slice(0, 60), media, scheduledAt: t, approve: !ok, needsApproval: !!ok });
  } catch (e) {
    console.error("seed", e.message);
  }
}

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/m/") || url.pathname.startsWith("/internal/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await handle(new Request(BASE + req.url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }), { site: { url: BASE } });
    const headers = Object.fromEntries(r.headers);
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  const file = path.join(pub, url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(pub) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
}).listen(PORT, () => console.log("ready " + BASE));
