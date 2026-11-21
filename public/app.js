// Social HQ — the app in your browser. Plain JavaScript, no build step.
// All times are shown in India time (Asia/Kolkata).

const TZ = "Asia/Kolkata";
const IST_MIN = 330;
const PLATFORM = {
  instagram: { label: "IG", name: "Instagram" },
  facebook: { label: "FB", name: "Facebook" },
  linkedin: { label: "in", name: "LinkedIn" },
  youtube: { label: "YT", name: "YouTube" },
  pinterest: { label: "P", name: "Pinterest" },
  manual: { label: "FB", name: "Facebook profile" },
  unknown: { label: "?", name: "Removed" },
};
const STATUS_TEXT = {
  draft: "Draft", needs_ok: "Needs your OK", scheduled: "Scheduled", publishing: "Going out…", done: "Posted",
  partial: "Partly posted", failed: "Failed", reminder: "Reminder", posted: "Posted", pending: "Waiting",
  ok: "Auto-post", error: "Reconnect needed", expired: "Login ended", expiring: "Log in again soon",
};
const TYPES = [
  ["post", "Post"], ["reel", "Reel"], ["carousel", "Carousel"], ["story", "Story"], ["short", "Short"], ["pin", "Pin"],
];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const app = $("#app");
const state = { authed: false, accounts: null };
if (/[?&](code|state|error)=/.test(location.search)) history.replaceState(null, "", location.pathname + location.hash);

// ---------- helpers ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function num(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  if (Math.abs(n) >= 100000) return (n / 1000).toFixed(0) + "K";
  if (Math.abs(n) >= 10000) return (n / 1000).toFixed(1) + "K";
  return Number(n).toLocaleString("en-IN");
}
function signed(n) {
  if (n === null || n === undefined) return "—";
  return (n > 0 ? "+" : n < 0 ? "−" : "") + num(Math.abs(n));
}
function pct(x) {
  return x === null || x === undefined ? "—" : (x * 100).toFixed(1) + "%";
}
function istKey(d) {
  return new Date(new Date(d).getTime() + IST_MIN * 60000).toISOString().slice(0, 10);
}
function istHM(d) {
  return new Date(new Date(d).getTime() + IST_MIN * 60000).toISOString().slice(11, 16);
}
function fromIST(dateKey, hm) {
  const [y, m, dd] = dateKey.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, dd, h, mi) - IST_MIN * 60000).toISOString();
}
function addDays(key, n) {
  const d = new Date(key + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const fmt = (opts) => new Intl.DateTimeFormat("en-IN", { timeZone: TZ, ...opts });
function time(iso) {
  return fmt({ hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)).toUpperCase().replace(/\s+/g, " ");
}
function dayName(iso) {
  return fmt({ weekday: "short", day: "numeric", month: "short" }).format(new Date(iso));
}
function whenText(iso) {
  if (!iso) return "No time set";
  const today = istKey(new Date());
  const k = istKey(iso);
  const day = k === today ? "Today" : k === addDays(today, 1) ? "Tomorrow" : k === addDays(today, -1) ? "Yesterday" : dayName(iso);
  return `${day} · ${time(iso)}`;
}
function longDate(d = new Date()) {
  return fmt({ weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d);
}
function badge(platform, sm = false) {
  const p = PLATFORM[platform] || PLATFORM.unknown;
  return `<span class="badge b-${esc(platform)}${sm ? " sm" : ""}" title="${esc(p.name)}">${esc(p.label)}</span>`;
}
function avatar(a, size = 30) {
  const p = PLATFORM[a?.platform] || PLATFORM.unknown;
  const pic = a?.avatar ? `<img src="${esc(a.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="badge b-${esc(a?.platform || "unknown")}" style="width:100%;height:100%;border-radius:50%">${esc(p.label)}</span>`;
  return `<span class="avw" style="width:${size}px;height:${size}px" title="${esc((a?.name || "") + " · " + p.name)}">${pic}${a?.avatar ? `<span class="pb b-${esc(a.platform)}">${esc(p.label)}</span>` : ""}</span>`;
}
function pill(status, text) {
  return `<span class="pill p-${esc(status)}">${esc(text || STATUS_TEXT[status] || status)}</span>`;
}
const ICON = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  cal: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  plus: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  chart: '<path d="M4 20V11M10 20V5M16 20v-6M21 20H3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2a5 5 0 0 1 5.5 5.8"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/>',
};
function icon(name, size = 18, stroke = 2) {
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;
}
let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), bad ? 6000 : 3000);
}
function parseHash() {
  const h = location.hash.slice(1) || "/overview";
  const [path, q] = h.split("?");
  return { path: path || "/overview", q: new URLSearchParams(q || "") };
}
function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

async function api(method, path, body) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try {
    data = await res.json();
  } catch (_) { /* no body */ }
  if (res.status === 401 && data?.code === "totp") throw Object.assign(new Error(data.error), { data });
  if (res.status === 401) {
    state.authed = false;
    renderAuth(data?.code === "setup" ? "setup" : "login");
    throw new Error(data?.error || "Please log in.");
  }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Something went wrong (${res.status}).`), { data });
  return data;
}

async function accounts(force = false) {
  if (!state.accounts || force) state.accounts = await api("GET", "/api/accounts");
  return state.accounts;
}

// ---------- shell ----------
const NAV = [
  ["/overview", "Overview", "grid"],
  ["/plan", "Plan", "cal"],
  ["/create", "Create post", "plus"],
  ["/inbox", "Comments", "chat"],
  ["/accounts", "Accounts", "link"],
  ["/insights", "Insights", "chart"],
  ["/competitors", "Competitors", "users"],
  ["/settings", "Settings", "gear"],
];
function shell(active) {
  app.innerHTML = `
  <div class="shell">
    <nav class="side" aria-label="Main menu">
      <div class="brandmark"><div class="logo">${icon("clock", 18, 2.2).replace('stroke="currentColor"', 'stroke="#fff"')}</div><span>Social HQ</span></div>
      <div class="nav">${NAV.map(([p, l, i]) => `<a href="#${p}" class="${active === p ? "on" : ""}" ${active === p ? 'aria-current="page"' : ""}>${icon(i)}${l}</a>`).join("")}</div>
      <div class="side-foot">
        <div class="side-card" id="side-count"><span>Connected</span><b>…</b></div>
        <div class="who"><span>Pratham Bansal</span><button id="logout" type="button">Log out</button></div>
      </div>
    </nav>
    <main class="main" id="main"><p class="muted">Loading…</p></main>
  </div>`;
  $("#logout").onclick = async () => {
    await api("POST", "/api/auth/logout");
    state.authed = false;
    renderAuth("login");
  };
  accounts().then((d) => {
    const c = {};
    for (const a of d.accounts) c[a.platform] = (c[a.platform] || 0) + 1;
    const parts = Object.entries(c).map(([p, n]) => `${n} ${PLATFORM[p].name}`).join(" · ");
    const el = $("#side-count");
    if (el) el.innerHTML = `<span>Connected</span><b>${d.accounts.length} account${d.accounts.length === 1 ? "" : "s"}</b><span>${esc(parts || "None yet")}</span>`;
  }).catch(() => {});
}
function main(html) {
  const m = $("#main");
  if (m) m.innerHTML = html;
  return m;
}

// ---------- auth screens ----------
function renderAuth(mode) {
  const setup = mode === "setup";
  app.innerHTML = `
  <div class="center"><div class="card login">
    <div class="brandmark" style="padding:0"><div class="logo">${icon("clock", 18, 2.2).replace('stroke="currentColor"', 'stroke="#fff"')}</div><span style="color:var(--ink)">Social HQ</span></div>
    <h1 style="font-size:24px">${setup ? "First-time setup" : "Log in"}</h1>
    <p class="muted">${setup ? "Enter the setup code from Claude, then choose your own password." : "Your private social media scheduler."}</p>
    <form id="auth-form" class="stack">
      ${setup ? '<label class="f">Setup code<input type="text" name="code" autocomplete="one-time-code" required></label>' : ""}
      <label class="f">${setup ? "Choose a password (8+ characters)" : "Password"}<input type="password" name="password" autocomplete="${setup ? "new-password" : "current-password"}" required minlength="${setup ? 8 : 1}"></label>
      ${setup ? "" : '<label class="f" id="code-wrap" hidden>6-digit code from your authenticator app (or a recovery code)<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="123 456"></label>'}
      <button class="btn primary" type="submit">${setup ? "Save and open Social HQ" : "Log in"}</button>
      <p class="note bad" id="auth-err" hidden></p>
    </form>
  </div></div>`;
  $("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!setup && !f.code) delete f.code;
    try {
      const r = await api("POST", setup ? "/api/auth/setup" : "/api/auth/login", f);
      state.authed = true;
      if (r?.recoveryLeft !== undefined) setTimeout(() => toast(`Recovery code used. ${r.recoveryLeft} left — make new ones in Settings → Security.`), 600);
      render();
    } catch (err) {
      const el = $("#auth-err");
      if (err.data?.code === "totp" && $("#code-wrap")) {
        $("#code-wrap").hidden = false;
        $("#code-wrap input").required = true;
        $("#code-wrap input").focus();
        if (!f.code) {
          el.hidden = true;
          return;
        }
      }
      if (el) {
        el.hidden = false;
        el.textContent = err.message;
      }
    }
  };
}

// ---------- router ----------
async function render() {
  if (!state.authed) {
    try {
      const s = await fetch("/api/auth/state", { credentials: "same-origin" }).then((r) => r.json());
      if (!s.setupDone) return renderAuth("setup");
      if (!s.loggedIn) return renderAuth("login");
      state.authed = true;
    } catch (e) {
      app.innerHTML = `<div class="center"><p class="note bad">Could not reach Social HQ: ${esc(e.message)}</p></div>`;
      return;
    }
  }
  const { path, q } = parseHash();
  const screens = { "/overview": screenOverview, "/plan": screenPlan, "/create": screenCreate, "/accounts": screenAccounts, "/account": screenAccount, "/inbox": screenInbox, "/autoreplies": screenAutoReplies, "/competitors": screenCompetitors, "/insights": screenInsights, "/settings": screenSettings };
  const fn = screens[path] || screenOverview;
  shell(path === "/account" ? "/accounts" : path === "/autoreplies" ? "/inbox" : screens[path] ? path : "/overview");
  try {
    await fn(q);
  } catch (e) {
    if (state.authed) main(`<p class="note bad">${esc(e.message)}</p>`);
  }
}
window.addEventListener("hashchange", render);

// ---------- Overview ----------
async function screenOverview(q) {
  const d = await api("GET", "/api/overview");
  const k = d.kpis;
  const counts = Object.entries(k.counts).map(([p, n]) => `${n} ${PLATFORM[p].name}`).join(" · ") || "None yet";
  const kpis = [
    ["Accounts connected", k.accounts, `${k.auto} auto-post · ${k.reminderOnly} reminder only`],
    ["Scheduled this week", k.scheduledThisWeek, `${dayName(fromIST(k.weekFrom, "12:00"))} – ${dayName(fromIST(addDays(k.weekFrom, 6), "12:00"))}`],
    ["Waiting for your OK", k.needsOk, k.needsOk ? "Approve them on the plan" : "Nothing waiting"],
    ["Reach, last 7 days", k.reach7 === null ? "—" : num(k.reach7), k.reach7 === null ? "Fills in after the first insights run" : "All accounts together"],
    ["New followers, 7 days", k.newFollowers7 === null ? "—" : signed(k.newFollowers7), k.newFollowers7 === null ? "Needs a week of history" : "All accounts together"],
  ];
  const todayRows = d.today_posts.length
    ? d.today_posts.map((p) => {
        const plats = [...new Set(p.accounts.map((a) => a.platform))];
        const names = p.accounts.map((a) => a.name).join(", ");
        return `<div class="list-row">
          <span class="t">${esc(time(p.scheduledAt))}</span>
          ${badge(plats[0] || "unknown")}
          <div style="min-width:0"><div style="font-weight:600;font-size:14px">${esc(names)}</div><div class="what">${esc(typeLabel(p.type))} · ${esc(p.caption || p.title || "(no caption)")}</div></div>
          <a class="pill p-${esc(p.status)}" style="text-decoration:none" href="#/create?id=${esc(p.id)}">${esc(STATUS_TEXT[p.status] || p.status)}</a>
        </div>`;
      }).join("")
    : `<p class="muted">Nothing goes out today. <a href="#/create">Create a post</a>.</p>`;
  const attention = d.attention.length
    ? d.attention.map((a) => `<div class="alert"><div class="ic">${icon("alert", 16, 2.2)}</div><div class="stack" style="gap:4px;min-width:0"><b style="font-size:14px">${esc(a.title)}</b>${a.detail ? `<span class="muted">${esc(a.detail)}</span>` : ""}<a href="${esc(a.href)}" style="font-size:13px;font-weight:700;text-decoration:none">${esc(a.action)} →</a></div></div>`).join("")
    : `<p class="muted">All clear.</p>`;
  const reminders = d.reminders.length
    ? `<section class="card" id="reminders"><h2>Post these by hand</h2><p class="muted">Facebook doesn't let any app post to personal profiles. Copy the caption, download the photo or video, post it, then tick it off.</p>
      ${d.reminders.map((r, i) => `<div class="file-row" style="align-items:flex-start;flex-wrap:wrap">
        <div class="stack" style="gap:6px;flex:1 1 260px;min-width:0"><b>${esc(r.accountName)} · ${esc(whenText(r.post.scheduledAt))}</b><span class="muted" style="white-space:pre-wrap">${esc(r.post.captions?.manual || r.post.captions?.facebook || r.post.caption || "")}</span></div>
        <div class="row"><button class="btn sm" data-copy="${i}" type="button">Copy caption</button>${r.post.mediaDeleted ? "" : r.post.media.map((m) => `<button class="btn sm" data-dl="${esc(m.id)}" data-name="${esc(m.name)}" type="button">Download ${esc(m.kind)}</button>`).join("")}<button class="btn sm primary" data-done="${esc(r.post.id)}" data-acc="${esc(r.accountId)}" type="button">Mark as posted</button></div>
      </div>`).join("")}</section>`
    : "";
  const rows = d.accounts.map((a) => `<tr>
      <td><a class="acc-cell" style="text-decoration:none;color:inherit" href="${a.platform === "manual" ? "#/accounts" : `#/account?id=${encodeURIComponent(a.id)}`}">${avatar(a, 34)}<div><div class="n">${esc(a.name)}</div><div class="h">${esc(a.handle || PLATFORM[a.platform].name)}</div></div></a></td>
      <td><b>${a.platform === "manual" ? "—" : num(a.followers)}</b></td>
      <td>${a.platform === "manual" ? "—" : num(a.reach7)}</td>
      <td class="${a.change7 > 0 ? "up" : a.change7 < 0 ? "down" : ""}">${signed(a.change7)}</td>
      <td>${spark(a.spark)}</td>
      <td class="muted">${a.nextAt ? esc(whenText(a.nextAt)) : "Nothing planned"}</td>
      <td>${a.status === "ok" || a.status === "reminder" ? "" : pill(a.status)}</td>
    </tr>`).join("");
  main(`
    <header class="head"><div><p class="sub">${esc(longDate())}</p><h1>Overview</h1></div>
      <div class="row"><a class="btn" href="#/plan">Open weekly plan</a><a class="btn primary" href="#/create">+ Create post</a></div></header>
    <section class="grid g-kpi">${kpis.map(([l, v, s]) => `<div class="kpi"><span class="l">${esc(l)}</span><span class="v">${esc(v)}</span><span class="s">${esc(s)}</span></div>`).join("")}</section>
    <div class="grid g-2">
      <section class="card"><div class="row between"><h2>Today · ${d.today_posts.length} post${d.today_posts.length === 1 ? "" : "s"}</h2></div><div>${todayRows}</div><a href="#/plan" style="font-size:14px;font-weight:600;text-decoration:none">See the full week →</a></section>
      <section class="card"><h2>Needs your attention</h2>${attention}${(d.alerts || []).length ? `<h3 style="margin-top:14px">Recent alerts</h3><div class="stack" style="gap:6px">${d.alerts.map((a) => `<div class="small"><b>${esc(a.title)}</b> <span class="muted">· ${esc(whenText(a.at))}${a.sent?.length ? ` · sent by ${esc(a.sent.join(", "))}` : ""}</span><br><span class="muted">${esc(a.text)}</span></div>`).join("")}</div>` : ""}</section>
    </div>
    ${reminders}
    <section class="card"><div class="row between"><h2>All accounts · last 7 days</h2><a href="#/insights" style="font-size:14px;font-weight:600;text-decoration:none">Open insights →</a></div>
      ${d.accounts.length ? `<div class="tbl"><table><thead><tr><th>Account</th><th>Followers</th><th>Reach / views</th><th>Followers +/−</th><th>Trend</th><th>Next post</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">No accounts yet. <a href="#/accounts">Connect your accounts</a>.</p>`}
      <p class="muted small">${esc(counts)}</p></section>`);
  bindReminders(d.reminders);
  if (q.get("reminders") && $("#reminders")) $("#reminders").scrollIntoView?.();
}
function typeLabel(t) {
  return (TYPES.find((x) => x[0] === t) || [t, t])[1];
}
function spark(arr) {
  if (!arr || arr.length < 2) return '<span class="muted small">—</span>';
  const min = Math.min(...arr), max = Math.max(...arr), span = max - min || 1;
  const pts = arr.map((v, i) => `${Math.round(i * (118 / (arr.length - 1))) + 1},${Math.round(30 - ((v - min) / span) * 26)}`).join(" ");
  const up = arr[arr.length - 1] >= arr[0];
  return `<svg role="img" aria-label="Trend" width="120" height="32" viewBox="0 0 120 32"><polyline points="${pts}" fill="none" stroke="${up ? "#2848E8" : "#9AA1AE"}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function bindReminders(list) {
  $$("[data-copy]").forEach((b) => (b.onclick = async () => {
    const r = list[Number(b.dataset.copy)];
    await navigator.clipboard.writeText(r.post.captions?.manual || r.post.captions?.facebook || r.post.caption || "");
    toast("Caption copied");
  }));
  $$("[data-dl]").forEach((b) => (b.onclick = () => download(b.dataset.dl, b.dataset.name, b)));
  $$("[data-done]").forEach((b) => (b.onclick = async () => {
    await api("POST", `/api/posts/${b.dataset.done}/done/${b.dataset.acc}`);
    toast("Marked as posted");
    render();
  }));
}
async function download(id, name, btn) {
  const old = btn.textContent;
  btn.textContent = "Downloading…";
  try {
    const meta = await api("GET", `/api/media/${id}`);
    const parts = [];
    for (let i = 0; i < meta.chunks; i++) {
      const r = await fetch(`/api/media/${id}/part/${i}`, { credentials: "same-origin" });
      if (!r.ok) throw new Error("Download failed");
      parts.push(await r.blob());
      btn.textContent = `Downloading ${Math.round(((i + 1) / meta.chunks) * 100)}%`;
    }
    const url = URL.createObjectURL(new Blob(parts, { type: meta.mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name || meta.name || "file";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.textContent = old;
  }
}

// ---------- Weekly plan ----------
async function screenPlan(q) {
  if (q.get("view") === "month") return screenMonth(q);
  const from = q.get("from") || istKey(new Date());
  const brand = q.get("brand") || "All";
  const d = await api("GET", `/api/plan?from=${encodeURIComponent(from)}&brand=${encodeURIComponent(brand)}`);
  const today = istKey(new Date());
  const link = (f, b) => `#/plan?from=${f}&brand=${encodeURIComponent(b)}`;
  const counts = Object.entries(d.counts).map(([p, n]) => `<span class="chip" style="cursor:default;padding-left:5px">${badge(p, true)}${n} on ${esc(PLATFORM[p].name)}</span>`).join("");
  const gapRow = (g) => `<div class="gap-row"><span class="muted">${esc(g.name)} (${esc(PLATFORM[g.platform].name)}): ${g.have} of ${g.want} this week</span>${g.slot ? `<a class="btn sm orange" href="#/create?account=${esc(g.accountId)}&at=${encodeURIComponent(g.slot)}">Add ${esc(whenText(g.slot))}</a>` : ""}</div>`;
  const gaps = d.gaps.length
    ? d.gaps.slice(0, 4).map(gapRow).join("") + (d.gaps.length > 4 ? `<details><summary class="link small" style="cursor:pointer">${d.gaps.length - 4} more gaps</summary><div class="stack" style="gap:10px;margin-top:10px">${d.gaps.slice(4).map(gapRow).join("")}</div></details>` : "") + `<p class="muted small">Each button opens a new post at that account's next perfect time.</p>`
    : `<p class="muted">No gaps. Set a weekly target per account on the Accounts screen and gaps show here.</p>`;
  const days = d.days.map((day) => {
    const posts = day.posts.map((p) => {
      const plats = [...new Set(p.accounts.map((a) => a.platform))];
      const brands = [...new Set(p.accounts.map((a) => a.brand))].join(", ");
      return `<a class="post-card ${p.best ? "best" : ""}" href="#/create?id=${esc(p.id)}" style="text-decoration:none;color:inherit">
        <div class="row between" style="gap:6px"><span class="pt">${esc(time(p.scheduledAt))}</span><span class="row" style="gap:3px">${plats.map((x) => badge(x, true)).join("")}</span></div>
        <span class="pb">${esc(brands)} · ${esc(typeLabel(p.type))}</span>
        <span class="pc">${esc(p.caption || p.title || "(no caption)")}</span>
        ${pill(p.status)}
      </a>`;
    }).join("");
    return `<div class="day ${day.date === today ? "today" : ""}">
      <div class="day-head"><div class="row between"><span class="display" style="font-size:17px;font-weight:700">${esc(dayName(fromIST(day.date, "12:00")))}</span><span class="muted small">${day.posts.length} post${day.posts.length === 1 ? "" : "s"}</span></div>
      ${day.perfect ? `<span class="perfect">${icon("clock", 12, 2.6)} Perfect ${esc(time(day.perfect))}</span>` : ""}</div>
      ${posts || `<p class="muted small" style="padding:4px">Nothing planned.</p>`}
      <a class="link small" href="#/create?date=${day.date}" style="font-size:12px;padding:4px">+ Add</a>
    </div>`;
  }).join("");
  const drafts = d.drafts.length ? `<section class="card"><h2>Drafts · no time set yet</h2>${d.drafts.map((p) => `<a href="#/create?id=${esc(p.id)}" class="row" style="text-decoration:none;color:inherit;border-top:1px solid var(--line-2);padding-top:10px">${[...new Set(p.accounts.map((a) => a.platform))].map((x) => badge(x, true)).join("")}<span style="font-weight:600">${esc(p.accounts.map((a) => a.name).join(", ") || "No account")}</span><span class="muted">${esc((p.caption || "").slice(0, 80))}</span></a>`).join("")}</section>` : "";
  main(`
    <header class="head"><div><p class="sub">What goes out, on which day, at what time</p><h1>Weekly plan</h1></div>
      <div class="row">
        <div class="seg"><button type="button" class="on">Week</button><button type="button" id="to-month">Month</button></div>
        <div class="row" style="gap:4px;background:#fff;border:1px solid #D9DCE3;border-radius:10px;padding:3px">
          <a class="btn sm" style="border:0" href="${link(addDays(d.weekFrom, -7), brand)}" aria-label="Previous week">‹</a>
          <span style="font-size:14px;font-weight:600;padding:0 8px">${esc(dayName(fromIST(d.weekFrom, "12:00")))} – ${esc(dayName(fromIST(d.weekTo, "12:00")))}</span>
          <a class="btn sm" style="border:0" href="${link(addDays(d.weekFrom, 7), brand)}" aria-label="Next week">›</a>
        </div>
        <a class="btn sm" href="${link(today, brand)}">This week</a>
        <a class="btn primary" href="#/create">+ Create post</a>
      </div></header>
    <div class="row" role="group" aria-label="Show brand">${["All", ...d.brands].map((b) => `<a class="chip ${b === brand ? "on" : ""}" style="text-decoration:none" href="${link(d.weekFrom, b)}">${esc(b === "All" ? "All brands" : b)}</a>`).join("")}</div>
    <div class="grid g-2">
      <section class="card tight"><div class="row between"><h3>${esc(brand === "All" ? "All brands" : brand)} · ${d.total} post${d.total === 1 ? "" : "s"} this week</h3><span class="muted small">${d.perfectCount} of ${d.total} at a perfect time</span></div><div class="row">${counts || '<span class="muted">Nothing scheduled yet.</span>'}</div></section>
      <section class="card tight"><h3>Gaps this week</h3>${gaps}</section>
    </div>
    <section class="grid g-week" aria-label="Week">${days}</section>
    ${drafts}
    <section class="card"><h2>Perfect times, by platform</h2><p class="muted">Learned from when your own followers react most. Until there's enough data (about 3 weeks of posts) Social HQ starts with these and keeps adjusting per account.</p>
      <div class="grid g-3">${Object.entries(d.windows).filter(([p]) => p !== "manual").map(([p, w]) => `<div class="row" style="align-items:flex-start;background:#FAFAFB;border:1px solid var(--line-2);border-radius:12px;padding:12px">${badge(p)}<div class="stack" style="gap:3px"><b style="font-size:13px">${esc(PLATFORM[p].name)}</b><span style="font-size:13px;font-weight:600;color:var(--orange)">${esc(w)}</span></div></div>`).join("")}</div></section>`);
  $("#to-month").onclick = () => (location.hash = `#/plan?view=month&month=${d.weekFrom.slice(0, 7)}&brand=${encodeURIComponent(brand)}`);
}

// ---------- Month calendar (drag a post to another day to move it) ----------
const MOVABLE = ["draft", "needs_ok", "scheduled", "failed", "partial"];
async function screenMonth(q) {
  const today = istKey(new Date());
  const month = /^\d{4}-\d{2}$/.test(q.get("month") || "") ? q.get("month") : today.slice(0, 7);
  const brand = q.get("brand") || "All";
  const first = `${month}-01`;
  const lastDay = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
  const last = `${month}-${String(lastDay).padStart(2, "0")}`;
  const lead = (new Date(first + "T12:00:00Z").getUTCDay() + 6) % 7;
  const gridFrom = addDays(first, -lead);
  const cells = Math.ceil((lead + lastDay) / 7) * 7;
  const gridTo = addDays(gridFrom, cells - 1);
  const [acc, posts, live] = await Promise.all([accounts(), api("GET", `/api/posts?from=${gridFrom}&to=${gridTo}`), api("GET", `/api/published?from=${gridFrom}&to=${gridTo}`).catch(() => [])]);
  const byId = Object.fromEntries(acc.accounts.map((a) => [a.id, a]));
  const brands = [...new Set(acc.accounts.map((a) => a.brand))].sort();
  const mine = posts.filter((p) => p.scheduledAt && (brand === "All" || (p.accountIds || []).some((id) => byId[id]?.brand === brand)));
  const byDay = {};
  for (const p of mine) (byDay[istKey(p.scheduledAt)] = byDay[istKey(p.scheduledAt)] || []).push(p);
  // Posts already live on the accounts (also ones made outside Social HQ), shown as "Posted".
  const sentIds = new Set(mine.flatMap((p) => Object.values(p.targets || {}).map((t) => t.url).filter(Boolean)));
  for (const l of live) {
    if (brand !== "All" && l.brand !== brand) continue;
    if (l.url && sentIds.has(l.url)) continue;
    (byDay[istKey(l.at)] = byDay[istKey(l.at)] || []).push({ live: true, id: l.accountId, scheduledAt: l.at, status: "done", accountIds: [l.accountId], caption: l.title, type: (l.type || "post").toLowerCase(), url: l.url, stat: l.reach || l.views || l.interactions });
  }
  const monthName = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(first + "T12:00:00Z"));
  const prevM = addDays(first, -1).slice(0, 7), nextM = addDays(last, 1).slice(0, 7);
  const link = (m, b) => `#/plan?view=month&month=${m}&brand=${encodeURIComponent(b)}`;
  const chip = (p) => {
    const accs = (p.accountIds || []).map((id) => byId[id]).filter(Boolean);
    if (p.live) return `<a class="mchip st-done live" href="#/account?id=${encodeURIComponent(p.id)}" title="${esc((accs[0]?.name || "") + " · " + (p.caption || ""))}"><b>${esc(time(p.scheduledAt).replace(":00", ""))}</b>${accs.map((a) => avatar(a, 16)).join("")}<span>${esc((accs[0]?.name || "") + (p.stat ? ` · ${num(p.stat)}` : ""))}</span></a>`;
    const plats = [...new Set(accs.map((a) => a.platform))];
    const movable = MOVABLE.includes(p.status);
    return `<a class="mchip st-${esc(p.status)}" href="#/create?id=${esc(p.id)}" ${movable ? `draggable="true" data-move="${esc(p.id)}" data-at="${esc(p.scheduledAt)}"` : ""} title="${esc((accs.map((a) => a.name).join(", ") || "") + " · " + (p.caption || p.title || ""))}">
      <b>${esc(time(p.scheduledAt).replace(":00", ""))}</b>${accs.slice(0, 3).map((a) => avatar(a, 16)).join("")}<span>${esc((p.caption || p.title || typeLabel(p.type)).slice(0, 40))}</span></a>`;
  };
  let html = "";
  for (let i = 0; i < cells; i++) {
    const dk = addDays(gridFrom, i);
    const list = (byDay[dk] || []).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    html += `<div class="mcell ${dk.slice(0, 7) !== month ? "out" : ""} ${dk === today ? "today" : ""} ${dk < today ? "past" : ""}" data-day="${dk}">
      <div class="row between"><span class="mday">${+dk.slice(8)}</span>${list.length ? `<span class="mcount">${list.length}</span>` : ""}</div>
      <div class="mlist">${list.map(chip).join("")}</div>
      <span class="mdots">${list.slice(0, 6).map((p) => `<i class="st-${esc(p.status)}"></i>`).join("")}</span>
      ${dk >= today ? `<a class="madd" href="#/create?date=${dk}" aria-label="Add a post on ${esc(dk)}">+</a>` : ""}
    </div>`;
  }
  const total = mine.filter((p) => istKey(p.scheduledAt).slice(0, 7) === month).length;
  const liveCount = Object.values(byDay).flat().filter((p) => p.live && istKey(p.scheduledAt).slice(0, 7) === month).length;
  main(`
    <header class="head"><div><p class="sub">${total} planned · ${liveCount} already posted in ${esc(monthName)} · drag a planned post to another day to move it</p><h1>Month plan</h1></div>
      <div class="row">
        <div class="seg"><button type="button" id="to-week">Week</button><button type="button" class="on">Month</button></div>
        <div class="row" style="gap:4px;background:#fff;border:1px solid #D9DCE3;border-radius:10px;padding:3px">
          <a class="btn sm" style="border:0" href="${link(prevM, brand)}" aria-label="Previous month">‹</a>
          <span style="font-size:14px;font-weight:600;padding:0 8px">${esc(monthName)}</span>
          <a class="btn sm" style="border:0" href="${link(nextM, brand)}" aria-label="Next month">›</a>
        </div>
        <a class="btn sm" href="${link(today.slice(0, 7), brand)}">This month</a>
        <a class="btn primary" href="#/create">+ Create post</a>
      </div></header>
    <div class="row" role="group" aria-label="Show brand">${["All", ...brands].map((b) => `<a class="chip ${b === brand ? "on" : ""}" style="text-decoration:none" href="${link(month, b)}">${esc(b === "All" ? "All brands" : b)}</a>`).join("")}</div>
    <section class="card" style="padding:12px">
      <div class="mgrid mhead">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((x) => `<span>${x}</span>`).join("")}</div>
      <div class="mgrid" id="mgrid">${html}</div>
    </section>
    <section class="card" id="mday-list" hidden></section>
    <div class="row muted small" style="gap:14px"><span><i class="lg st-scheduled"></i> Scheduled</span><span><i class="lg st-needs_ok"></i> Needs your OK</span><span><i class="lg st-done"></i> Posted</span><span><i class="lg st-failed"></i> Failed</span><span><i class="lg st-draft"></i> Draft</span></div>`);
  $("#to-week").onclick = () => (location.hash = `#/plan?from=${month === today.slice(0, 7) ? today : first}&brand=${encodeURIComponent(brand)}`);
  const grid = $("#mgrid");
  let dragging = null;
  grid.addEventListener("dragstart", (e) => {
    const c = e.target.closest("[data-move]");
    if (!c) return;
    dragging = c;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", c.dataset.move);
    c.classList.add("dragging");
  });
  grid.addEventListener("dragend", () => { dragging?.classList.remove("dragging"); dragging = null; $$(".mcell.over").forEach((x) => x.classList.remove("over")); });
  grid.addEventListener("dragover", (e) => {
    const cell = e.target.closest(".mcell");
    if (!cell || !dragging || cell.dataset.day < today) return;
    e.preventDefault();
    $$(".mcell.over").forEach((x) => x !== cell && x.classList.remove("over"));
    cell.classList.add("over");
  });
  grid.addEventListener("drop", async (e) => {
    const cell = e.target.closest(".mcell");
    if (!cell || !dragging) return;
    e.preventDefault();
    const id = dragging.dataset.move;
    const oldAt = dragging.dataset.at;
    const day = cell.dataset.day;
    if (istKey(oldAt) === day) return;
    const newAt = fromIST(day, istHM(oldAt));
    if (new Date(newAt) < new Date()) return toast("That time has already passed on that day.", true);
    try {
      await api("PUT", `/api/posts/${encodeURIComponent(id)}`, { scheduledAt: newAt });
      toast(`Moved to ${whenText(newAt)}`);
      render();
    } catch (err) {
      toast(err.message, true);
    }
  });
  // On phones the cells only show dots: tap a day to list its posts underneath.
  grid.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const cell = e.target.closest(".mcell");
    if (!cell) return;
    const dk = cell.dataset.day;
    const list = (byDay[dk] || []).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    const box = $("#mday-list");
    box.hidden = false;
    box.innerHTML = `<div class="row between"><h2>${esc(dayName(fromIST(dk, "12:00")))}</h2>${dk >= today ? `<a class="btn sm primary" href="#/create?date=${dk}">+ Add post</a>` : ""}</div>
      ${list.map((p) => { const accs = (p.accountIds || []).map((id) => byId[id]).filter(Boolean); return `<a class="list-row" style="grid-template-columns:70px minmax(0,1fr) auto;text-decoration:none;color:inherit" href="${p.live ? `#/account?id=${encodeURIComponent(p.id)}` : `#/create?id=${esc(p.id)}`}"><span class="t">${esc(time(p.scheduledAt))}</span><div style="min-width:0"><div style="font-weight:600;font-size:14px">${esc(accs.map((a) => a.name).join(", "))}</div><div class="what">${esc(typeLabel(p.type))} · ${esc(p.caption || p.title || "(no caption)")}</div></div>${pill(p.status)}</a>`; }).join("") || '<p class="muted">Nothing planned this day.</p>'}`;
    $$(".mcell.sel").forEach((x) => x.classList.remove("sel"));
    cell.classList.add("sel");
    if (window.innerWidth < 760) box.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  });
}

// ---------- Create / edit post ----------
let C = null;
function blankPost() {
  return { id: null, accountIds: [], type: "post", caption: "", captions: {}, title: "", link: "", boardIds: {}, firstComment: "", alsoStory: false, aiGenerated: false, ytPrivacy: "public", ytMadeForKids: false, media: [], needsApproval: false, date: "", time: "", slot: -1, suggestions: [], tab: "all", status: null, targets: {}, uploading: 0 };
}

async function screenCreate(q) {
  const acc = await accounts(true);
  C = blankPost();
  let readOnly = false;
  if (q.get("id")) {
    const p = await api("GET", `/api/posts/${q.get("id")}`);
    Object.assign(C, {
      id: p.id, accountIds: p.accountIds, type: p.type, caption: p.caption, captions: p.captions || {}, title: p.title, link: p.link, boardIds: p.boardIds || {},
      firstComment: p.firstComment, alsoStory: p.alsoStory, aiGenerated: p.aiGenerated, ytPrivacy: p.ytPrivacy, ytMadeForKids: p.ytMadeForKids,
      media: p.media, needsApproval: p.needsApproval && !p.approvedAt, status: p.status, targets: p.targets || {}, mediaDeleted: p.mediaDeleted,
      date: p.scheduledAt ? istKey(p.scheduledAt) : "", time: p.scheduledAt ? istHM(p.scheduledAt) : "",
    });
    readOnly = ["publishing", "done", "reminder"].includes(p.status);
  } else {
    if (q.get("account")) C.accountIds = [q.get("account")];
    if (q.get("at")) {
      C.date = istKey(q.get("at"));
      C.time = istHM(q.get("at"));
    }
    if (q.get("date")) C.date = q.get("date");
  }
  if (!acc.accounts.length) {
    main(`<header class="head"><h1>Create post</h1></header><section class="card"><p>Connect at least one account first.</p><a class="btn primary" href="#/accounts" style="align-self:flex-start">Go to Accounts</a></section>`);
    return;
  }
  const byBrand = {};
  for (const a of acc.accounts) (byBrand[a.brand] = byBrand[a.brand] || []).push(a);

  main(`
    <header class="head"><div><p class="sub">${C.id ? "Edit a post" : "One post, many accounts — each at its perfect time"}</p><h1>${C.id ? "Post" : "Create post"}</h1></div>
      ${C.id ? `<div class="row">${pill(C.status)}</div>` : ""}</header>
    <div id="c-status"></div>
    <div class="grid g-2">
      <div class="stack">
        <section class="card"><div class="row between"><h2>1. Post to</h2><span id="c-count" style="font-size:13px;font-weight:600;color:var(--blue)"></span></div><div id="c-accounts" class="stack" style="gap:10px"></div></section>
        <section class="card"><h2>2. What kind of post</h2><div class="row" id="c-type" role="group" aria-label="Post type"></div><p class="muted small" id="c-type-note"></p></section>
        <section class="card"><h2>3. Photo, video and caption</h2>
          <div id="c-media" class="stack" style="gap:10px"></div>
          <label class="drop" id="c-drop"><input type="file" id="c-file" accept="image/*,video/*" multiple class="sr">Click to add photos or a video (or drop them here)</label>
          <div class="row between"><label for="c-caption" style="font-size:13px;font-weight:700">Caption</label><div class="seg" id="c-tabs" role="group" aria-label="Edit caption for"></div></div>
          <textarea id="c-caption" rows="7"></textarea>
          <div class="row between muted small"><span id="c-cap-note">Same caption for every account. Use the tabs to change it for one platform.</span><span id="c-len"></span></div>
          <div id="c-extra" class="stack" style="gap:12px"></div>
          <div class="grid g-3" style="gap:8px" id="c-opts"></div>
        </section>
      </div>
      <div class="stack">
        <section class="card"><div class="stack" style="gap:4px"><h2>4. When to post</h2><p class="muted">Perfect times for the accounts you picked, from when their followers react most.</p></div>
          <div id="c-slots" class="stack" style="gap:8px" role="radiogroup" aria-label="Suggested times"></div>
          <div class="grid g-3" style="gap:10px;grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr))">
            <label class="f">Or pick a date<input type="date" id="c-date"></label>
            <label class="f">and time (India)<input type="time" id="c-time" step="300"></label>
          </div>
          <label class="check"><input type="checkbox" id="c-ok"> Ask me before it goes out</label>
          <div id="c-warn"></div>
          <div class="stack" style="gap:8px" id="c-actions"></div>
        </section>
        <section class="card"><h2>Preview</h2><div id="c-preview"></div></section>
      </div>
    </div>`);

  // static bindings
  const cap = $("#c-caption");
  cap.oninput = () => {
    if (C.tab === "all") C.caption = cap.value;
    else if (cap.value.trim()) C.captions[C.tab] = cap.value;
    else delete C.captions[C.tab];
    capLen();
    renderPreview();
  };
  $("#c-file").onchange = (e) => addFiles([...e.target.files]);
  const drop = $("#c-drop");
  drop.ondragover = (e) => { e.preventDefault(); drop.style.borderColor = "var(--blue)"; };
  drop.ondragleave = () => (drop.style.borderColor = "");
  drop.ondrop = (e) => { e.preventDefault(); drop.style.borderColor = ""; addFiles([...e.dataTransfer.files]); };
  $("#c-date").value = C.date;
  $("#c-time").value = C.time;
  $("#c-date").onchange = (e) => { C.date = e.target.value; C.slot = -1; renderSlots(); };
  $("#c-time").onchange = (e) => { C.time = e.target.value; C.slot = -1; renderSlots(); };
  $("#c-ok").checked = !!C.needsApproval;
  $("#c-ok").onchange = (e) => (C.needsApproval = e.target.checked);

  function selected() {
    return acc.accounts.filter((a) => C.accountIds.includes(a.id));
  }
  function platformsSel() {
    return [...new Set(selected().map((a) => a.platform))];
  }

  function renderAccounts() {
    $("#c-accounts").innerHTML = Object.entries(byBrand).map(([brand, list]) => `<div class="row" style="gap:8px"><span style="flex:0 0 112px;font-size:13px;font-weight:700;color:var(--ink-2)">${esc(brand)}</span>${list.map((a) => `<button type="button" class="acc-chip ${C.accountIds.includes(a.id) ? "on" : ""}" data-acc="${esc(a.id)}" aria-pressed="${C.accountIds.includes(a.id)}">${avatar(a, 26)}${esc(a.handle && a.platform === "instagram" ? a.handle : a.name)}</button>`).join("")}</div>`).join("");
    $$("#c-accounts [data-acc]").forEach((b) => (b.onclick = () => {
      if (readOnly) return;
      const id = b.dataset.acc;
      C.accountIds = C.accountIds.includes(id) ? C.accountIds.filter((x) => x !== id) : [...C.accountIds, id];
      renderAccounts();
      renderTabs();
      renderExtra();
      renderOpts();
      loadSlots();
      renderPreview();
    }));
    $("#c-count").textContent = `${C.accountIds.length} account${C.accountIds.length === 1 ? "" : "s"} selected`;
  }
  function renderType() {
    $("#c-type").innerHTML = TYPES.map(([v, l]) => `<button type="button" class="chip ${C.type === v ? "on" : ""}" data-type="${v}" aria-pressed="${C.type === v}">${l}</button>`).join("");
    $$("#c-type [data-type]").forEach((b) => (b.onclick = () => { if (readOnly) return; C.type = b.dataset.type; renderType(); renderOpts(); renderPreview(); }));
    const notes = {
      post: "One photo (or one video, which Instagram treats as a Reel). Text-only works on Facebook and LinkedIn.",
      reel: "One vertical video. Goes to Instagram Reels, Facebook Reels and LinkedIn as a video.",
      carousel: "2 to 10 photos or videos, swiped through on Instagram; several photos in one post elsewhere.",
      story: "One photo or video, shown for 24 hours (Instagram and Facebook Pages).",
      short: "One vertical video: YouTube Short, and a Reel on Instagram/Facebook.",
      pin: "One photo or video for Pinterest, with a title and a link.",
    };
    $("#c-type-note").textContent = notes[C.type] || "";
  }
  function renderTabs() {
    const plats = platformsSel().filter((p) => p !== "manual");
    if (!plats.includes(C.tab) && C.tab !== "all") C.tab = "all";
    $("#c-tabs").innerHTML = [["all", "Same for all"], ...plats.map((p) => [p, PLATFORM[p].name + (C.captions[p] ? " •" : "")])].map(([v, l]) => `<button type="button" class="${C.tab === v ? "on" : ""}" data-tab="${v}">${esc(l)}</button>`).join("");
    $$("#c-tabs [data-tab]").forEach((b) => (b.onclick = () => { C.tab = b.dataset.tab; renderTabs(); fillCaption(); }));
  }
  function fillCaption() {
    cap.value = C.tab === "all" ? C.caption : C.captions[C.tab] || "";
    cap.placeholder = C.tab === "all" ? "Write your caption. Hashtags and links are fine." : `Same as the main caption. Type here to use a different caption on ${PLATFORM[C.tab].name}.`;
    $("#c-cap-note").textContent = C.tab === "all" ? "Same caption for every account. Use the tabs to change it for one platform." : `Only for ${PLATFORM[C.tab].name}. Leave empty to use the main caption.`;
    capLen();
  }
  function capLen() {
    const limits = { instagram: 2200, facebook: 63206, linkedin: 3000, youtube: 5000, pinterest: 800 };
    const plats = C.tab === "all" ? platformsSel() : [C.tab];
    const lim = Math.min(...plats.map((p) => limits[p] || 5000), 5000);
    $("#c-len").textContent = `${cap.value.length} / ${lim.toLocaleString("en-IN")}`;
    $("#c-len").style.color = cap.value.length > lim ? "var(--red)" : "";
  }
  function renderExtra() {
    const plats = platformsSel();
    let h = "";
    if (plats.includes("youtube")) {
      h += `<div class="grid g-3" style="gap:10px"><label class="f">YouTube title<input type="text" id="x-title" maxlength="100" value="${esc(C.title)}"></label>
        <label class="f">YouTube visibility<select id="x-priv">${["public", "unlisted", "private"].map((v) => `<option value="${v}" ${C.ytPrivacy === v ? "selected" : ""}>${v[0].toUpperCase() + v.slice(1)}</option>`).join("")}</select></label></div>
        <label class="check"><input type="checkbox" id="x-kids" ${C.ytMadeForKids ? "checked" : ""}> Made for kids (YouTube requires this answer)</label>`;
    } else if (plats.includes("pinterest") || plats.includes("linkedin")) {
      h += `<label class="f">Title (Pinterest pin title / LinkedIn video title)<input type="text" id="x-title" maxlength="100" value="${esc(C.title)}"></label>`;
    }
    if (plats.includes("pinterest") || plats.includes("facebook")) {
      h += `<label class="f">Link (Pinterest pin link, or a link post on Facebook)<input type="url" id="x-link" placeholder="https://liftline.in" value="${esc(C.link)}"></label>`;
    }
    for (const a of selected().filter((x) => x.platform === "pinterest")) {
      const boards = a.meta.boards || [];
      const cur = C.boardIds[a.id] || a.meta.defaultBoardId || "";
      h += `<label class="f">Pinterest board for ${esc(a.name)}<select data-board="${esc(a.id)}">${boards.length ? boards.map((b) => `<option value="${esc(b.id)}" ${b.id === cur ? "selected" : ""}>${esc(b.name)}</option>`).join("") : '<option value="">No boards found — refresh on the Accounts screen</option>'}</select></label>`;
    }
    $("#c-extra").innerHTML = h;
    const t = $("#x-title");
    if (t) t.oninput = () => { C.title = t.value; renderPreview(); };
    const l = $("#x-link");
    if (l) l.oninput = () => (C.link = l.value);
    const p = $("#x-priv");
    if (p) p.onchange = () => (C.ytPrivacy = p.value);
    const k = $("#x-kids");
    if (k) k.onchange = () => (C.ytMadeForKids = k.checked);
    $$("[data-board]").forEach((s) => {
      C.boardIds[s.dataset.board] = s.value;
      s.onchange = () => (C.boardIds[s.dataset.board] = s.value);
    });
  }
  function renderOpts() {
    const plats = platformsSel();
    let h = "";
    const storyPlats = ["instagram", "facebook"].filter((p) => plats.includes(p));
    if (storyPlats.length && C.type !== "story" && C.type !== "pin") h += `<label class="check"><input type="checkbox" id="o-story" ${C.alsoStory ? "checked" : ""}> Also share it to the ${storyPlats.map((p) => (p === "instagram" ? "Instagram" : "Facebook")).join(" and ")} Story <span class="muted small">(${C.media.length > 1 ? "the first photo or video" : "same photo or video"}, posted right after)</span></label>`;
    if (plats.some((p) => ["instagram", "facebook"].includes(p))) h += `<label class="f" style="grid-column:1/-1">First comment (Instagram and Facebook)<input type="text" id="o-comment" value="${esc(C.firstComment)}" placeholder="e.g. Get a quote at liftline.in"></label>`;
    if (plats.includes("youtube")) h += `<label class="check"><input type="checkbox" id="o-ai" ${C.aiGenerated ? "checked" : ""}> Video has realistic AI-made content (YouTube label)</label>`;
    $("#c-opts").innerHTML = h;
    const s = $("#o-story");
    if (s) s.onchange = () => (C.alsoStory = s.checked);
    const c = $("#o-comment");
    if (c) c.oninput = () => (C.firstComment = c.value);
    const ai = $("#o-ai");
    if (ai) ai.onchange = () => (C.aiGenerated = ai.checked);
  }
  function renderMedia() {
    $("#c-media").innerHTML = C.media.map((m, i) => `<div class="file-row">
      ${m.preview && m.kind === "image" ? `<img class="thumb" src="${esc(m.preview)}" alt="">` : m.preview && m.kind === "video" ? `<video class="thumb" src="${esc(m.preview)}" muted></video>` : `<div class="thumb">${m.kind === "video" ? "VIDEO" : "PHOTO"}</div>`}
      <div class="stack" style="gap:4px;flex:1 1 auto;min-width:0"><span style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.name)}</span>
        <span class="muted small">${m.kind === "video" ? "Video" : "Photo"} · ${(m.size / 1048576).toFixed(1)} MB${m.ratio ? ` · ${m.ratio}` : ""}</span>
        ${m.progress !== undefined && m.progress < 1 ? `<div class="progress"><span style="width:${Math.round(m.progress * 100)}%"></span></div>` : ""}
        ${m.warn ? `<span class="small" style="color:var(--amber)">${esc(m.warn)}</span>` : ""}</div>
      ${readOnly ? "" : `<div class="row" style="gap:4px">${i > 0 ? `<button class="btn sm" data-up="${i}" type="button" aria-label="Move up">↑</button>` : ""}<button class="btn sm danger" data-rm="${i}" type="button">Remove</button></div>`}
    </div>`).join("") + (C.mediaDeleted ? `<p class="note">The files were deleted after posting to save space.</p>` : "");
    $$("[data-rm]").forEach((b) => (b.onclick = () => { C.media.splice(Number(b.dataset.rm), 1); renderMedia(); renderPreview(); }));
    $$("[data-up]").forEach((b) => (b.onclick = () => { const i = Number(b.dataset.up); [C.media[i - 1], C.media[i]] = [C.media[i], C.media[i - 1]]; renderMedia(); renderPreview(); }));
    $("#c-drop").hidden = readOnly;
  }
  async function addFiles(files) {
    for (const file of files) {
      const kind = file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : null;
      if (!kind) { toast(`${file.name}: only photos and videos`, true); continue; }
      const item = { id: null, kind, name: file.name, size: file.size, mime: file.type, progress: 0, preview: URL.createObjectURL(file) };
      C.media.push(item);
      C.uploading++;
      renderMedia();
      try {
        const done = await uploadFile(file, (p) => { item.progress = p; renderMedia(); }, item);
        Object.assign(item, done, { progress: 1 });
        if (C.type === "post" && C.media.length > 1) C.type = "carousel";
        if (C.type === "post" && kind === "video") C.type = "reel";
        renderType();
      } catch (e) {
        C.media.splice(C.media.indexOf(item), 1);
        toast(`${file.name}: ${e.message}`, true);
      } finally {
        C.uploading--;
        renderMedia();
        renderPreview();
      }
    }
  }
  function renderSlots() {
    const box = $("#c-slots");
    if (!C.accountIds.length) { box.innerHTML = `<p class="muted">Pick accounts to see their perfect times.</p>`; return; }
    if (!C.suggestions.length) { box.innerHTML = `<p class="muted">Working out the best times…</p>`; return; }
    box.innerHTML = C.suggestions.map((s, i) => `<button type="button" class="slot ${C.slot === i ? "on" : ""}" role="radio" aria-checked="${C.slot === i}" data-slot="${i}">
      <span class="stack" style="gap:3px"><span class="w">${esc(whenText(s.at))}</span><span class="muted small">${i === 0 ? "Best upcoming time for these accounts" : "Another strong time"}</span></span>
      <span class="stack" style="gap:5px"><span style="font-size:12px;font-weight:700;color:var(--orange);text-align:right">${s.score} / 100</span><span class="bar"><span style="width:${s.score}%"></span></span></span></button>`).join("");
    $$("[data-slot]").forEach((b) => (b.onclick = () => {
      if (readOnly) return;
      C.slot = Number(b.dataset.slot);
      const s = C.suggestions[C.slot];
      C.date = istKey(s.at);
      C.time = istHM(s.at);
      $("#c-date").value = C.date;
      $("#c-time").value = C.time;
      renderSlots();
      renderActions();
    }));
    renderActions();
  }
  let slotTimer;
  function loadSlots() {
    clearTimeout(slotTimer);
    C.suggestions = [];
    renderSlots();
    if (!C.accountIds.length) return;
    slotTimer = setTimeout(async () => {
      try {
        C.suggestions = await api("POST", "/api/suggest", { accountIds: C.accountIds });
        if (!C.suggestions.length) $("#c-slots").innerHTML = `<p class="muted">No free slot found in the next 7 days.</p>`;
        else renderSlots();
      } catch (e) {
        $("#c-slots").innerHTML = `<p class="note bad">${esc(e.message)}</p>`;
      }
    }, 300);
  }
  function renderActions() {
    const box = $("#c-actions");
    if (readOnly) {
      box.innerHTML = Object.values(C.targets).some((t) => t.status === "failed") ? `<button class="btn primary" id="a-retry" type="button">Retry the failed ones now</button>` : "";
      const r = $("#a-retry");
      if (r) r.onclick = retry;
      return;
    }
    const when = C.date && C.time ? whenText(fromIST(C.date, C.time)) : "";
    box.innerHTML = `
      <button class="btn primary" id="a-schedule" type="button" style="min-height:48px">${when ? `Schedule for ${esc(when)}` : "Pick a time to schedule"}</button>
      <div class="grid" style="gap:8px;grid-template-columns:repeat(auto-fit,minmax(min(160px,100%),1fr))">
        <button class="btn" id="a-queue" type="button">Add to queue — next perfect slot</button>
        <button class="btn" id="a-draft" type="button">Save as draft</button>
        <button class="btn" id="a-now" type="button">Post now</button>
        ${C.status === "needs_ok" ? `<button class="btn orange" id="a-approve" type="button">Approve</button>` : ""}
        ${C.id ? `<button class="btn danger" id="a-delete" type="button">Delete</button>` : ""}
      </div>`;
    $("#a-schedule").onclick = () => save("schedule");
    $("#a-queue").onclick = () => save("queue");
    $("#a-draft").onclick = () => save("draft");
    $("#a-now").onclick = () => save("now");
    const ap = $("#a-approve");
    if (ap) ap.onclick = async () => { await api("POST", `/api/posts/${C.id}/approve`); toast("Approved"); go(`#/plan?from=${C.date || istKey(new Date())}`); };
    const del = $("#a-delete");
    if (del) del.onclick = async () => { if (!confirm("Delete this post?")) return; await api("DELETE", `/api/posts/${C.id}`); toast("Deleted"); go("#/plan"); };
  }
  async function retry() {
    try {
      await api("POST", `/api/posts/${C.id}/retry`);
      toast("Trying again now");
      setTimeout(() => go(`#/create?id=${C.id}`), 1500);
    } catch (e) {
      toast(e.message, true);
    }
  }
  async function save(mode) {
    if (C.uploading) return toast("Wait for the upload to finish.", true);
    const body = {
      accountIds: C.accountIds, type: C.type, caption: C.caption, captions: C.captions, title: C.title, link: C.link, boardIds: C.boardIds,
      firstComment: C.firstComment, alsoStory: C.alsoStory, aiGenerated: C.aiGenerated, ytPrivacy: C.ytPrivacy, ytMadeForKids: C.ytMadeForKids,
      media: C.media.filter((m) => m.id).map(({ id, kind, name, size, mime }) => ({ id, kind, name, size, mime })),
      needsApproval: C.needsApproval,
    };
    if (mode === "schedule") {
      if (!C.date || !C.time) return toast("Pick a perfect time or a date and time first.", true);
      body.scheduledAt = fromIST(C.date, C.time);
      if (new Date(body.scheduledAt) < new Date(Date.now() - 60000)) return toast("That time has already passed. Pick a later time or press Post now.", true);
    } else if (mode === "queue") {
      if (!C.suggestions[0]) return toast("Pick accounts first so Social HQ can find a slot.", true);
      body.scheduledAt = C.suggestions[0].at;
    } else if (mode === "now") {
      body.scheduledAt = new Date().toISOString();
      body.publishNow = true;
      body.needsApproval = false;
    } else body.scheduledAt = null;
    if (!C.needsApproval && mode !== "draft") body.approve = true;
    try {
      const p = C.id ? await api("PUT", `/api/posts/${C.id}`, body) : await api("POST", "/api/posts", body);
      if (mode === "now") {
        toast("Posting now. This page refreshes with the result.");
        setTimeout(() => go(`#/create?id=${p.id}`), 2500);
      } else if (mode === "draft") {
        toast("Saved as draft");
        go("#/plan");
      } else {
        toast(p.status === "needs_ok" ? "Saved. It waits for your OK." : `Scheduled for ${whenText(p.scheduledAt)}`);
        go(`#/plan?from=${istKey(p.scheduledAt)}`);
      }
    } catch (e) {
      $("#c-warn").innerHTML = `<p class="note bad">${esc(e.message)}</p>`;
      toast("Couldn't save — see the note above the buttons.", true);
    }
  }
  function renderPreview() {
    const first = C.media[0];
    const a = selected()[0];
    const capText = (a && C.captions[a.platform]) || C.caption;
    $("#c-preview").innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;gap:10px">
      <div style="width:236px;${C.type === "post" || C.type === "carousel" || C.type === "pin" ? "height:295px" : "height:420px"};border-radius:18px;background:#1C2132;overflow:hidden;position:relative;display:flex;align-items:flex-end">
        ${first?.preview ? (first.kind === "image" ? `<img src="${esc(first.preview)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` : `<video src="${esc(first.preview)}" muted style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>`) : ""}
        <div style="position:relative;padding:12px;background:rgba(10,12,20,.6);width:100%;display:flex;flex-direction:column;gap:4px">
          <b style="font-size:12px;color:#fff">${esc(a ? (a.handle || a.name) : "Pick an account")}</b>
          <span style="font-size:11px;color:#fff;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical">${esc(capText || "Your caption shows here")}</span>
        </div>
      </div>
      <span class="muted small">${C.media.length > 1 ? `${C.media.length} files · first one shown` : "Rough preview"}</span></div>`;
  }
  function renderStatus() {
    if (!C.id) return;
    const targets = Object.entries(C.targets);
    if (!targets.length) return;
    const rows = targets.map(([id, t]) => {
      const a = acc.accounts.find((x) => x.id === id);
      return `<div class="row between" style="border-top:1px solid var(--line-2);padding-top:10px"><span class="row">${badge(a?.platform || "unknown", true)}<b style="font-size:14px">${esc(a?.name || "Removed account")}</b></span>
        <span class="row">${pill(t.status)}${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener" style="font-size:13px;font-weight:600">Open post</a>` : ""}</span></div>
        ${t.status === "pending" && t.retryAt ? `<p class="note warn">First try didn't work (${esc(t.reason || t.lastError || "")}). Social HQ tries again at ${esc(time(t.retryAt))}.</p>` : ""}
        ${t.error ? `<p class="note bad">${t.reason ? `<b>${esc(t.reason)}</b><br>${t.fix ? `What to do: ${esc(t.fix)}<br>` : ""}<span class="small">Exact message: ${esc(t.error)}</span>` : esc(t.error)}</p>` : ""}${t.note ? `<p class="note">${esc(t.note)}</p>` : ""}`;
    }).join("");
    $("#c-status").innerHTML = `<section class="card tight"><h3>Where this post stands</h3>${rows}</section>`;
  }

  renderAccounts();
  renderType();
  renderTabs();
  fillCaption();
  renderExtra();
  renderOpts();
  renderMedia();
  renderStatus();
  renderPreview();
  if (readOnly) {
    $("#c-slots").innerHTML = `<p class="muted">${esc(whenText(C.date ? fromIST(C.date, C.time) : null))}</p>`;
    $("#c-date").disabled = true;
    $("#c-time").disabled = true;
    $("#c-ok").disabled = true;
    cap.readOnly = true;
    renderActions();
    if (C.status === "publishing") setTimeout(() => { if (location.hash.includes(C.id)) render(); }, 8000);
  } else {
    loadSlots();
    renderActions();
  }
}

async function uploadFile(file, onProgress, item) {
  let blob = file;
  let name = file.name;
  let mime = file.type;
  if (mime.startsWith("image/")) {
    const out = await toJpeg(file);
    blob = out.blob;
    mime = "image/jpeg";
    name = name.replace(/\.[^.]+$/, "") + ".jpg";
    const r = out.w / out.h;
    item.ratio = `${out.w}×${out.h}`;
    if (r < 0.8 - 0.01 || r > 1.91 + 0.01) item.warn = "Instagram feed photos must be between 4:5 (tall) and 1.91:1 (wide). Crop it, or use it as a Story.";
  }
  const init = await api("POST", "/api/media", { name, size: blob.size, mime });
  for (let i = 0; i < init.chunks; i++) {
    const part = blob.slice(i * init.chunkSize, (i + 1) * init.chunkSize);
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const r = await fetch(`/api/media/${init.id}/part/${i}`, { method: "PUT", body: part, headers: { "content-type": "application/octet-stream" }, credentials: "same-origin" });
      ok = r.ok;
      if (!ok && attempt === 2) throw new Error((await r.json().catch(() => ({}))).error || "Upload failed");
    }
    onProgress((i + 1) / init.chunks);
  }
  const done = await api("POST", `/api/media/${init.id}/complete`);
  return { id: done.id, kind: done.kind, name, size: blob.size, mime };
}

async function toJpeg(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch (_) {
    throw new Error("This photo format can't be read here. Save it as JPG or PNG first.");
  }
  const max = 2160;
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  let q = 0.92, blob;
  do {
    blob = await new Promise((r) => c.toBlob(r, "image/jpeg", q));
    q -= 0.08;
  } while (blob.size > 2.9 * 1024 * 1024 && q > 0.4);
  return { blob, w, h };
}

// ---------- Accounts ----------
async function screenAccounts(q) {
  const [d, il] = await Promise.all([accounts(true), api("GET", "/api/insights").catch(() => ({ accounts: [] }))]);
  const fol = Object.fromEntries((il.accounts || []).map((x) => [x.id, x]));
  const msg = q.get("connected") ? `<p class="note good">Connected: ${esc(q.get("connected"))}</p>` : q.get("error") ? `<p class="note bad">${esc(q.get("error"))}</p>` : "";
  const connectBtn = (p, label) => d.configured[p]
    ? `<a class="btn" href="/api/oauth/${p}/start" style="padding-left:8px">${badge(p)}${esc(label)}</a>`
    : `<a class="btn" href="#/settings?missing=${p}" style="padding-left:8px;opacity:.7" title="Add the ${esc(PLATFORM[p].name)} app keys in Settings first">${badge(p)}${esc(label)} <span class="muted small">· keys needed</span></a>`;
  const groups = {};
  for (const a of d.accounts) (groups[a.brand] = groups[a.brand] || []).push(a);
  const brands = [...new Set([...Object.keys(groups), "LIFTLINE", "MM Spares", "KAIU", "AdmitX", "Coinwise Kids", "Wrong Door", "The Backstory", "Personal"])];
  const statusOf = (a) => (a.platform === "manual" ? pill("reminder", "Reminder only") : a.platform === "pinterest" && d.pinterestSandbox ? pill("waiting", "Pins visible only to you") : pill(a.status));
  main(`
    <header class="head"><div><p class="sub">${d.accounts.length} account${d.accounts.length === 1 ? "" : "s"}</p><h1>Accounts</h1></div><a class="btn" href="#connect" id="go-connect">+ Connect an account</a></header>
    ${msg}
    <section class="card"><div class="row between"><h2>Your accounts</h2><span class="muted small">Tap an account to see all its posts and how each one did</span></div>
      <div class="acc-grid">${d.accounts.filter((a) => a.platform !== "manual").sort((x, y) => x.platform.localeCompare(y.platform) || x.name.localeCompare(y.name)).map((a) => {
        const f = fol[a.id];
        return `<a class="acc-tile" href="#/account?id=${encodeURIComponent(a.id)}">
          ${avatar(a, 44)}
          <span class="stack" style="gap:2px;min-width:0;flex:1"><b>${esc(a.name)}</b><span class="muted small">${badge(a.platform, true).replace('class="badge', 'class="badge xs')} ${esc(a.handle || PLATFORM[a.platform].name)}</span>
          <span class="small" style="font-weight:600">${f && f.followers !== null ? `${esc(num(f.followers))} ${esc((f.followersLabel || "Followers").toLowerCase())}` : ""}${a.status !== "ok" ? ` ${pill(a.status)}` : ""}</span></span>
          <span class="go" aria-hidden="true">›</span></a>`;
      }).join("") || '<p class="muted">No accounts yet. Connect one below.</p>'}</div>
    </section>
    <section class="card" id="connect"><div class="stack" style="gap:4px"><h2>Connect an account</h2><p class="muted">You log in on the platform's own page. Social HQ never sees your password. On Meta's screen you can tick several Instagram accounts or Facebook Pages at once. If one is missing, press Connect again and pick it.</p></div>
      <div class="row">${connectBtn("instagram", "Instagram")}${connectBtn("facebook", "Facebook Pages")}${connectBtn("linkedin", "LinkedIn")}${connectBtn("youtube", "YouTube")}${connectBtn("pinterest", "Pinterest")}</div>
      <form class="row" id="link-form" style="border-top:1px solid var(--line-2);padding-top:14px"><b style="font-size:13px">Account signed in on another browser or phone?</b>
        <select name="p" style="max-width:180px">${["instagram", "facebook", "linkedin", "youtube", "pinterest"].filter((p) => d.configured[p]).map((p) => `<option value="${p}">${esc(PLATFORM[p].name)}</option>`).join("")}</select>
        <button class="btn sm" type="submit">Make a connect link</button>
        <input type="text" id="link-out" readonly hidden style="flex:1 1 260px" aria-label="Connect link"></form>
      <p class="muted small" style="margin:0">Open the link there. It works once, for 15 minutes.</p>
      <form class="row" id="rem-form" style="border-top:1px solid var(--line-2);padding-top:14px"><b style="font-size:13px">Facebook personal profile (reminders):</b>
        <input type="text" name="name" placeholder="Profile name" required style="max-width:220px"><input type="text" name="brand" placeholder="Brand" value="Personal" style="max-width:160px"><button class="btn sm" type="submit">Add</button></form>
    </section>
    <section class="grid g-3">
      <div class="card tight">${pill("ok", "Auto-post")}<b style="font-size:14px">Posts by itself at the set time</b><span class="muted">Instagram business or creator accounts, Facebook Pages, your LinkedIn profile.</span></div>
      <div class="card tight">${pill("reminder", "Reminder only")}<b style="font-size:14px">You get a nudge with everything ready</b><span class="muted">Facebook personal profiles. Facebook lets no app post there.</span></div>
      <div class="card tight">${pill("waiting", "Waiting for approval")}<b style="font-size:14px">Works fully once the platform says yes</b><span class="muted">YouTube (uploads Private till then), Pinterest (pins only you see), LinkedIn company pages.</span></div>
    </section>
    <h2 style="margin-top:6px">Manage accounts</h2><p class="muted" style="margin-top:-12px">Brand, weekly target, reconnect or remove.</p>
    <datalist id="brand-list">${brands.map((b) => `<option value="${esc(b)}">`).join("")}</datalist>
    <section class="grid g-2">${Object.entries(groups).map(([brand, list]) => `<div class="card"><div class="row between"><h2>${esc(brand)}</h2><span class="muted small">${list.length} account${list.length === 1 ? "" : "s"}</span></div>
      ${list.map((a) => `<div class="stack" style="gap:8px;border-top:1px solid var(--line-2);padding-top:12px">
        <div class="row between"><a class="row acc-open" href="#/account?id=${encodeURIComponent(a.id)}">${avatar(a, 36)}<span class="stack" style="gap:2px"><b style="font-size:14px">${esc(a.name)}</b><span class="muted small">${esc(PLATFORM[a.platform]?.name || "")} · ${esc(a.handle || "")}</span></span></a><span class="row">${statusOf(a)}</span></div>
        <span class="muted small">${esc(a.loginNote)}</span>${a.lastError ? `<p class="note bad">${esc(a.lastError)}</p>` : ""}
        <div class="row" style="gap:8px">
          <label class="f" style="flex:1 1 140px">Brand<input type="text" list="brand-list" data-brand="${esc(a.id)}" value="${esc(a.brand)}"></label>
          <label class="f" style="flex:0 1 130px">Posts a week target<input type="number" min="0" max="21" data-cad="${esc(a.id)}" value="${a.cadence || 0}"></label>
          ${a.platform === "pinterest" ? `<label class="f" style="flex:1 1 160px">Default board<select data-board="${esc(a.id)}">${(a.meta.boards || []).map((b) => `<option value="${esc(b.id)}" ${b.id === a.meta.defaultBoardId ? "selected" : ""}>${esc(b.name)}</option>`).join("") || '<option value="">No boards</option>'}</select></label>` : ""}
        </div>
        <div class="row" style="gap:8px">${a.platform !== "manual" ? `<a class="btn sm primary" href="#/account?id=${encodeURIComponent(a.id)}">Open account · posts &amp; insights</a><a class="btn sm" href="/api/oauth/${a.platform}/start">Reconnect</a>` : ""}${a.platform === "pinterest" ? `<button class="btn sm" data-refresh="${esc(a.id)}" type="button">Refresh boards</button>` : ""}<button class="btn sm danger" data-del="${esc(a.id)}" data-name="${esc(a.name)}" type="button">Remove</button></div>
      </div>`).join("")}</div>`).join("") || `<p class="muted">No accounts yet.</p>`}</section>`);
  $("#go-connect").onclick = (e) => { e.preventDefault(); $("#connect").scrollIntoView?.({ behavior: "smooth" }); };
  $("#link-form").onsubmit = async (e) => {
    e.preventDefault();
    const p = new FormData(e.target).get("p");
    if (!p) return toast("Add app keys in Settings first", true);
    try {
      const r = await api("GET", `/api/oauth/${p}/start?link=1`);
      const out = $("#link-out");
      out.hidden = false;
      out.value = r.url;
      out.select();
      try { await navigator.clipboard.writeText(r.url); toast("Link copied"); } catch (_) { toast("Link ready: copy it from the box"); }
    } catch (err) { toast(err.message, true); }
  };
  $("#rem-form").onsubmit = async (e) => {
    e.preventDefault();
    await api("POST", "/api/accounts/reminder", Object.fromEntries(new FormData(e.target)));
    toast("Added");
    render();
  };
  $$("[data-brand]").forEach((i) => (i.onchange = async () => { await api("PATCH", `/api/accounts/${i.dataset.brand}`, { brand: i.value }); toast("Saved"); state.accounts = null; }));
  $$("[data-cad]").forEach((i) => (i.onchange = async () => { await api("PATCH", `/api/accounts/${i.dataset.cad}`, { cadence: i.value }); toast("Saved"); }));
  $$("select[data-board]").forEach((s) => (s.onchange = async () => { await api("PATCH", `/api/accounts/${s.dataset.board}`, { boardId: s.value }); toast("Saved"); }));
  $$("[data-refresh]").forEach((b) => (b.onclick = async () => { try { await api("POST", `/api/accounts/${b.dataset.refresh}/boards`); toast("Boards refreshed"); render(); } catch (e) { toast(e.message, true); } }));
  $$("[data-del]").forEach((b) => (b.onclick = async () => {
    if (!confirm(`Remove ${b.dataset.name} from Social HQ? Scheduled posts for it will fail.`)) return;
    await api("DELETE", `/api/accounts/${b.dataset.del}`);
    toast("Removed");
    render();
  }));
}

// ---------- One account: profile, every past post, each post's numbers ----------
const POST_ICON = { Reel: "▶ Reel", Video: "▶ Video", Short: "▶ Short", Carousel: "▣ Carousel", Album: "▣ Album", Story: "◷ Story" };
async function screenAccount(q) {
  const id = q.get("id");
  if (!id) return (location.hash = "#/accounts");
  main(`<p class="muted">Opening the account…</p>`);
  const [d, ins] = await Promise.all([api("GET", `/api/accounts/${encodeURIComponent(id)}/profile`), api("GET", `/api/insights/${encodeURIComponent(id)}`).catch(() => null)]);
  const a = d.account;
  const P = d.profile || { name: a.name, handle: a.handle, avatar: a.avatar, bio: "", counts: [], link: "", linkLabel: "" };
  const L = ins?.latest;
  const kpis = L ? L.kpis : [];
  const tab = ["hq", "audience", "analysis"].includes(q.get("tab")) ? q.get("tab") : "posts";
  const tabLink = (t, label) => `<button type="button" class="${tab === t ? "on" : ""}" data-tab="${t}">${label}</button>`;
  main(`
    <div class="row"><a class="btn sm" href="#/accounts">← All accounts</a></div>
    <section class="card prof">
      <div class="prof-top">
        ${P.avatar ? `<img class="prof-av" src="${esc(P.avatar)}" alt="" referrerpolicy="no-referrer">` : `<div class="prof-av ph">${badge(a.platform)}</div>`}
        <div class="stack" style="gap:8px;min-width:0;flex:1 1 260px">
          <div class="row" style="gap:8px">${badge(a.platform, true)}<h1 class="prof-name">${esc(P.name || a.name)}</h1>${pill(a.status)}</div>
          <span class="muted">${esc(P.handle || a.handle || "")} · Brand: ${esc(a.brand)}</span>
          ${P.counts.length ? `<div class="prof-counts">${P.counts.map((c) => `<div><b>${esc(num(c.value))}</b><span>${esc(c.label)}</span></div>`).join("")}</div>` : ""}
          ${P.bio ? `<p class="prof-bio">${esc(P.bio)}</p>` : ""}
          ${P.website ? `<a href="${esc(P.website)}" target="_blank" rel="noopener" style="font-size:13px;font-weight:600">${esc(P.website.replace(/^https?:\/\//, ""))}</a>` : ""}
          <div class="row" style="gap:8px">
            <a class="btn sm primary" href="#/create?account=${encodeURIComponent(a.id)}">+ New post</a>
            ${P.link ? `<a class="btn sm" href="${esc(P.link)}" target="_blank" rel="noopener">${esc(P.linkLabel || "Open")} ↗</a>` : ""}
            <a class="btn sm" href="#/insights?id=${encodeURIComponent(a.id)}">Growth &amp; best times</a>
          </div>
        </div>
      </div>
      ${d.error ? `<p class="note warn">Could not load live profile: ${esc(d.error)}</p>` : ""}
    </section>
    ${kpis.length ? `<section class="grid g-kpi">${kpis.map((k) => `<div class="kpi"><span class="l">${esc(k.label)}</span><span class="v">${esc(num(k.value))}</span><span class="s">${esc(k.period)}</span></div>`).join("")}</section>` : ""}
    <div class="seg" role="tablist" style="align-self:flex-start">${tabLink("posts", "Posts on the account")}${["instagram", "facebook", "youtube"].includes(a.platform) ? tabLink("analysis", "Analysis") : ""}${a.platform === "instagram" ? tabLink("audience", "Audience") : ""}${tabLink("hq", `Planned in Social HQ (${d.hq.length})`)}</div>
    <section id="acc-body"></section>`);
  $$("[data-tab]").forEach((b) => (b.onclick = () => (location.hash = `#/account?id=${encodeURIComponent(id)}${b.dataset.tab !== "posts" ? `&tab=${b.dataset.tab}` : ""}`)));
  const body = $("#acc-body");
  if (tab === "analysis") return mountAnalysis(body, id);
  if (tab === "audience") {
    body.innerHTML = `<p class="muted">Loading audience…</p>`;
    try {
      const au = await api("GET", `/api/accounts/${encodeURIComponent(id)}/audience`);
      body.innerHTML = audienceHtml(au);
    } catch (e) {
      body.innerHTML = `<p class="note bad">${esc(e.message)}</p>`;
    }
    return;
  }
  if (tab === "hq") {
    body.innerHTML = d.hq.length
      ? `<div class="card">${d.hq.map((p) => `<div class="list-row" style="grid-template-columns:150px minmax(0,1fr) auto">
          <span class="t" style="font-size:13px">${esc(whenText(p.at))}</span>
          <div style="min-width:0"><div class="what" style="white-space:normal">${esc(typeLabel(p.type))} · ${esc(p.caption || "(no caption)")}</div></div>
          <span class="row" style="gap:6px">${p.url ? `<a class="btn sm" href="${esc(p.url)}" target="_blank" rel="noopener">View ↗</a>` : ""}<a class="pill p-${esc(p.status)}" style="text-decoration:none" href="#/create?id=${esc(p.id)}">${esc(STATUS_TEXT[p.status] || p.status)}</a></span>
        </div>`).join("")}</div>`
      : `<div class="card"><p class="muted">Nothing planned for this account in Social HQ yet.</p><a class="btn primary" style="align-self:flex-start" href="#/create?account=${encodeURIComponent(a.id)}">+ Create a post</a></div>`;
    return;
  }
  // "What works": average results per post type, from the posts Social HQ measured.
  const measured = (L?.posts || []).filter((p) => p.type);
  let works = "";
  if (measured.length >= 3) {
    const by = {};
    for (const p of measured) {
      const k = p.type;
      by[k] = by[k] || { n: 0, reach: 0, views: 0, inter: 0 };
      by[k].n++;
      by[k].reach += p.reach || 0;
      by[k].views += p.views || 0;
      by[k].inter += p.interactions || 0;
    }
    const useReach = measured.some((p) => p.reach > 0);
    const useViews = !useReach && measured.some((p) => p.views > 0);
    const metric = useReach ? "reach" : useViews ? "views" : "inter";
    const label = useReach ? "accounts reached" : useViews ? "views" : "interactions";
    const list = Object.entries(by).map(([t, v]) => ({ t, n: v.n, avg: v[metric] / v.n, inter: v.inter / v.n })).sort((x, y) => y.avg - x.avg);
    const best = list[0];
    works = `<section class="card tight"><div class="row between"><h3>What works on this account</h3><span class="muted small">Last ${measured.length} posts</span></div>
      ${list.length > 1 ? `<p style="font-size:14px"><b>${esc(best.t)}s</b> do best here: about <b>${esc(num(Math.round(best.avg)))}</b> ${label} each${list[1].avg > 0 ? `, ${esc((best.avg / list[1].avg).toFixed(1))}× ${esc(list[1].t.toLowerCase())}s` : ""}.</p>` : ""}
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">${list.map((x) => `<div class="pst"><span class="v">${esc(num(Math.round(x.avg)))}</span><span class="l">${esc(x.t)} · avg ${esc(label)} (${x.n} post${x.n === 1 ? "" : "s"})</span><span class="l">${esc(num(Math.round(x.inter)))} interactions each</span></div>`).join("")}</div></section>`;
  }
  body.innerHTML = `${works}<div class="row between" style="margin:4px 0 10px"><span class="muted small" id="feed-count"></span><label class="row" style="gap:6px;font-size:13px;font-weight:600">Sort<select id="psort" style="width:auto;min-height:36px"><option value="new">Newest first</option><option value="likes">Most liked</option><option value="comments">Most comments</option>${a.platform === "youtube" ? '<option value="views">Most views</option>' : ""}</select></label></div><div class="pgrid" id="pgrid"></div><p class="muted" id="feed-msg">Loading posts…</p><div class="row" style="justify-content:center"><button class="btn" id="more" type="button" hidden>Load older posts</button></div>`;
  const all = [];
  let next = null;
  const sorters = { new: (x, y) => String(y.at).localeCompare(String(x.at)), likes: (x, y) => (y.likes || 0) - (x.likes || 0), comments: (x, y) => (y.comments || 0) - (x.comments || 0), views: (x, y) => (y.views || 0) - (x.views || 0) };
  function draw() {
    const order = [...all.keys()].sort((i, j) => sorters[$("#psort").value](all[i], all[j]));
    $("#pgrid").innerHTML = order.map((i) => tile(all[i], i)).join("");
    $$("#pgrid .ptile").forEach((b) => (b.onclick = () => openPost(all[+b.dataset.i])));
    $("#feed-count").textContent = `${all.length} post${all.length === 1 ? "" : "s"} loaded`;
  }
  const tile = (p, i) => `<button type="button" class="ptile" data-i="${i}" aria-label="${esc(p.type)} from ${esc(dayName(p.at))}">
      ${p.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="ptxt">${esc((p.caption || p.title || p.type).slice(0, 120))}</span>`}
      ${POST_ICON[p.type] || (p.privacy && p.privacy !== "public") ? `<span class="ptype">${esc([POST_ICON[p.type], p.privacy && p.privacy !== "public" ? p.privacy[0].toUpperCase() + p.privacy.slice(1) : ""].filter(Boolean).join(" · "))}</span>` : ""}
      <span class="pstat">${p.views !== undefined && p.views !== null && a.platform === "youtube" ? `<span>👁 ${esc(num(p.views))}</span>` : ""}${p.likes !== null && p.likes !== undefined ? `<span>♥ ${esc(num(p.likes))}</span>` : ""}${p.comments !== null && p.comments !== undefined ? `<span>💬 ${esc(num(p.comments))}</span>` : ""}</span>
      <span class="pdate">${esc(dayName(p.at))}</span>
    </button>`;
  async function load() {
    const msg = $("#feed-msg"), more = $("#more");
    try {
      const r = await api("GET", `/api/accounts/${encodeURIComponent(id)}/feed${next ? `?after=${encodeURIComponent(next)}` : ""}`);
      const start = all.length;
      all.push(...r.posts);
      next = r.next;
      draw();
      msg.hidden = all.length > 0;
      msg.textContent = all.length ? "" : "No posts on this account yet.";
      if (r.saved && all.length) { msg.hidden = false; msg.textContent = "These are the latest posts Social HQ saved. Full browsing for this platform comes soon."; }
      more.hidden = !next;
      if (!r.posts.length && start > 0) { msg.hidden = false; msg.className = "muted"; msg.textContent = "That's every post the platform shares for this account."; }
    } catch (e) {
      msg.hidden = false;
      msg.className = "note bad";
      msg.textContent = `Could not load posts: ${e.message}`;
    }
  }
  $("#psort").onchange = draw;
  $("#more").onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Loading…";
    await load();
    e.target.disabled = false;
    e.target.textContent = "Load older posts";
  };
  async function openPost(p) {
    const sheet = document.createElement("div");
    sheet.className = "sheet-wrap";
    sheet.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Post details"><div class="row between"><b>${esc(POST_ICON[p.type] || p.type)} · ${esc(whenText(p.at))}</b><button class="btn sm" type="button" data-close>Close ✕</button></div><p class="muted">Loading this post's numbers…</p></div>`;
    document.body.appendChild(sheet);
    document.body.style.overflow = "hidden";
    const close = () => { sheet.remove(); document.body.style.overflow = ""; document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    sheet.onclick = (e) => { if (e.target === sheet || e.target.closest("[data-close]")) close(); };
    if (!d.canBrowse) {
      sheet.querySelector(".sheet").innerHTML = postHtml({ ...p, media: p.thumb ? [{ kind: "image", url: p.thumb, thumb: p.thumb }] : [], stats: [["Views", p.views], ["Likes", p.likes], ["Comments", p.comments], ["Reach", p.reach]].filter(([, v]) => v !== undefined && v !== null).map(([label, value]) => ({ label, value })) });
      return;
    }
    try {
      const full = await api("GET", `/api/accounts/${encodeURIComponent(id)}/feed/${encodeURIComponent(p.id)}`);
      if (document.body.contains(sheet)) {
        sheet.querySelector(".sheet").innerHTML = postHtml(full);
        loadPostComments(sheet, p.id);
      }
    } catch (e) {
      sheet.querySelector(".sheet").innerHTML = postHtml({ ...p, media: p.thumb ? [{ kind: "image", url: p.thumb, thumb: p.thumb }] : [], stats: [], note: `Could not load the numbers: ${e.message}` });
    }
  }
  function postHtml(x) {
    const m = (x.media || [])[0];
    const visual = m ? (m.kind === "video" && m.url ? `<video src="${esc(m.url)}" poster="${esc(m.thumb || "")}" controls playsinline preload="none"></video>` : `<img src="${esc(m.url || m.thumb)}" alt="" referrerpolicy="no-referrer">`) : "";
    const more = (x.media || []).length > 1 ? `<div class="row" style="gap:6px">${x.media.slice(1, 10).map((c) => `<img class="mini" src="${esc(c.thumb || c.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`).join("")}</div>` : "";
    return `<div class="row between"><b>${esc(POST_ICON[x.type] || x.type)} · ${esc(whenText(x.at))}</b><button class="btn sm" type="button" data-close>Close ✕</button></div>
      <div class="sheet-body">
        <div class="sheet-media">${visual}${more}</div>
        <div class="stack" style="gap:14px;min-width:0">
          ${(x.stats || []).length ? `<div class="pst-grid">${x.stats.map((s) => `<div class="pst"><span class="v">${esc(s.text || num(s.value))}</span><span class="l">${esc(s.label)}</span></div>`).join("")}${x.engagementRate !== null && x.engagementRate !== undefined ? `<div class="pst"><span class="v">${esc(pct(x.engagementRate))}</span><span class="l">Engagement rate</span></div>` : ""}</div>` : ""}
          ${x.note ? `<p class="note">${esc(x.note)}</p>` : ""}
          ${x.caption ? `<div class="stack" style="gap:6px"><h3>Caption</h3><p class="cap">${esc(x.caption)}</p></div>` : ""}
          ${x.url ? `<a class="btn sm" style="align-self:flex-start" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.linkLabel || "Open post")} ↗</a>` : ""}
          ${a.platform === "instagram" ? `<div class="stack" style="gap:8px"><h3>Comments</h3><div class="post-cm" data-post="${esc(x.id)}"><p class="muted small">Loading comments…</p></div></div>` : ""}
        </div>
      </div>`;
  }
  async function loadPostComments(sheet, postId) {
    const holder = sheet.querySelector(".post-cm");
    if (!holder) return;
    try {
      const r = await api("GET", `/api/accounts/${encodeURIComponent(id)}/feed/${encodeURIComponent(postId)}/comments`);
      holder.innerHTML = r.comments.filter((c) => !c.mine).map((c) => commentHtml(c, id)).join("") || '<p class="muted small">No comments yet.</p>';
      wireComments(holder, () => loadPostComments(sheet, postId));
    } catch (e) {
      holder.innerHTML = `<p class="note bad">${esc(e.message)}</p>`;
    }
  }
  await load();
}

function bars(rows, { total } = {}) {
  const sum = total || rows.reduce((t, r) => t + r.value, 0) || 1;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return `<div class="stack" style="gap:8px">${rows.map((r) => `<div class="barrow"><span class="bl">${esc(r.label)}</span><span class="bt"><span style="width:${Math.max(2, (r.value / max) * 100)}%"></span></span><span class="bv">${Math.round((r.value / sum) * 100)}%</span></div>`).join("")}</div>`;
}
function audienceHtml(au) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hourText = (h) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
  let online = `<p class="muted">Instagram hasn't shared when your followers are online yet. It needs a few days of data and some followers.</p>`;
  if (au.online?.grid) {
    const g = au.online.grid;
    const avg = Array.from({ length: 24 }, (_, h) => Math.round(g.reduce((t, row) => t + row[h], 0) / 7));
    const peak = Math.max(...avg, 1);
    const best = [];
    g.forEach((row, d) => row.forEach((v, h) => best.push({ d, h, v })));
    best.sort((x, y) => y.v - x.v);
    const top = [];
    for (const b of best) {
      if (top.length >= 3) break;
      if (top.some((t) => t.d === b.d && Math.abs(t.h - b.h) < 2)) continue;
      top.push(b);
    }
    const allMax = Math.max(...best.map((b) => b.v), 1);
    const scale = ["#F1F4FF", "#D6E0FF", "#A9BDFF", "#6F8DF7", "#2848E8"];
    online = `<p style="font-size:14px">Most of your followers are online: <b>${top.map((t) => `${days[t.d]} ${hourText(t.h)}`).join(" · ")}</b>. Social HQ uses this for the perfect time to post.</p>
      <div class="hours">${avg.map((v, h) => `<div class="hc" title="${hourText(h)} · about ${v} followers online"><span style="height:${Math.max(3, (v / peak) * 100)}%"></span><em>${h % 3 === 0 ? (h % 12 || 12) + (h < 12 ? "a" : "p") : ""}</em></div>`).join("")}</div>
      <div class="tbl"><div class="heat" style="min-width:720px"><div class="hr" style="grid-template-columns:48px repeat(24,minmax(0,1fr))"><span></span>${avg.map((_, h) => `<span class="lbl">${h % 3 === 0 ? (h % 12 || 12) + (h < 12 ? "a" : "p") : ""}</span>`).join("")}</div>
      ${g.map((row, d) => `<div class="hr" style="grid-template-columns:48px repeat(24,minmax(0,1fr))"><span style="font-size:12px;font-weight:600;color:var(--ink-2)">${days[d]}</span>${row.map((v, h) => `<span class="cell" title="${days[d]} ${hourText(h)} · about ${v} online" style="background:${scale[Math.min(4, Math.floor((v / allMax) * 4.999))]}"></span>`).join("")}</div>`).join("")}</div></div>
      <p class="muted small">India time · average of the last ${au.online.days} days.</p>`;
  }
  const sec = (title, rows, empty) => `<section class="card"><h2>${title}</h2>${rows.length ? bars(rows) : `<p class="muted">${empty}</p>`}</section>`;
  const why = au.note || "Not shared yet.";
  return `<div class="stack" style="gap:16px">
    <section class="card"><h2>When your followers are online</h2>${online}</section>
    ${au.note ? `<p class="note">${esc(au.note)}</p>` : ""}
    <div class="grid g-2">${sec("Age", au.age, why)}${sec("Men and women", au.gender, why)}${sec("Top cities", au.city, why)}${sec("Top countries", au.country, why)}</div>
    <p class="muted small">Updated ${esc(whenText(au.at))}. Instagram refreshes these about once a day.</p>
  </div>`;
}

// ---------- Analysis (what works, from the account's own posts) ----------
function idxTxt(i) {
  if (i === null || i === undefined) return "—";
  const v = Math.round((i - 1) * 100);
  return `<span class="${v > 5 ? "up" : v < -5 ? "down" : ""}">${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v)}%</span>`;
}
function idxBars(rows, labelKey = "label") {
  const shown = rows.filter((r) => r.n);
  const max = Math.max(...shown.map((r) => r.index || 0), 1);
  return `<div class="stack" style="gap:8px">${rows.map((r) => `<div class="barrow" style="grid-template-columns:minmax(110px,190px) minmax(0,1fr) 110px"><span class="bl">${esc(r[labelKey])}</span><span class="bt">${r.n ? `<span style="width:${Math.max(3, ((r.index || 0) / max) * 100)}%;background:${(r.index || 0) >= 1.15 ? "var(--green)" : (r.index || 0) <= 0.85 ? "#E08A7E" : "var(--blue)"}"></span>` : ""}</span><span class="bv" style="text-align:left">${r.n ? `${idxTxt(r.index)} <span class="muted">· ${r.n}</span>` : '<span class="muted">no posts</span>'}</span></div>`).join("")}</div>`;
}
function analysisHtml(d, accId) {
  const a = d.analysis;
  const ml = a.metricLabel;
  if (!a.posts) return `<section class="card"><p class="muted">${esc(a.note || "No posts yet.")}</p></section>`;
  const tagRow = (t) => `<div class="row between tagrow"><span class="kw">${esc(t.tag)}</span><span class="small muted">${t.uses}× · ${idxTxt(t.index)}</span></div>`;
  const postTile = (p) => `<a class="ptile" href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.caption)}">${p.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="ptxt">${esc(p.caption)}</span>`}<span class="ptype">${esc(p.type || "")}</span><span class="pstat"><span>${esc(num(p.value))} ${esc(ml.split(" ")[0])}</span><span>${idxTxt(p.index).replace(/class="(up|down)"/, 'style="color:#fff"')}</span></span><span class="pdate">${esc(dayName(p.at))}</span></a>`;
  const t = a.types;
  const e = a.engagement;
  const weeksMax = Math.max(...a.weeks.map((w) => w.posts), 1);
  return `<div class="stack" style="gap:16px">
    <section class="card tips"><div class="row between"><h2>What to do next</h2><span class="row" style="gap:8px"><span class="muted small">${a.posts} posts · measured by ${esc(ml)} · updated ${esc(whenText(d.at))}</span><button class="btn sm" type="button" data-reanalyse="${esc(accId)}">Refresh analysis</button></span></div>
      ${a.tips.length ? `<ol class="tiplist">${a.tips.map((x) => `<li><span class="tk tk-${esc(x.kind)}">${esc({ type: "Content", tags: "Hashtags", time: "Timing", caption: "Captions", rhythm: "Rhythm", trend: "Trend", engage: "Engagement" }[x.kind] || "Tip")}</span>${esc(x.text)}</li>`).join("")}</ol>` : `<p class="muted">No clear patterns yet. Keep posting and check back in a week.</p>`}
      ${a.note ? `<p class="note">${esc(a.note)}</p>` : ""}
      <p class="muted small">“Usual post” = the middle result of these ${a.posts} posts (${esc(num(a.median))} ${esc(ml)}). +50% means half as much again. These are patterns in your own posts, not guarantees.</p></section>

    <section class="card"><h2>Content type</h2><div class="tbl"><table><thead><tr><th>Type</th><th>Posts</th><th>Avg. ${esc(ml)}</th><th>vs usual</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Saves</th><th>Avg. watch</th></tr></thead><tbody>
      ${t.map((x) => `<tr><td><b>${esc(x.type)}</b></td><td>${x.n}</td><td>${esc(num(x.avg))}</td><td>${idxTxt(x.index)}</td><td>${esc(num(x.likes))}</td><td>${esc(x.comments ?? "—")}</td><td>${esc(x.shares ?? "—")}</td><td>${esc(x.saves ?? "—")}</td><td>${x.watchSec ? esc(x.watchSec + "s") : "—"}</td></tr>`).join("")}</tbody></table></div></section>

    <section class="card"><div class="row between"><h2>Hashtags</h2><span class="muted small">${a.hashtags.distinct} different hashtags · each post compared with posts of the same type</span></div>
      <div class="grid g-3">
        <div class="stack" style="gap:6px"><h3 style="color:var(--green)">Working (${a.hashtags.working.length})</h3>${a.hashtags.working.slice(0, 15).map(tagRow).join("") || '<p class="muted small">None stand out yet (needs a tag used on 2+ posts).</p>'}</div>
        <div class="stack" style="gap:6px"><h3 style="color:var(--red)">Not working (${a.hashtags.notWorking.length})</h3>${a.hashtags.notWorking.slice(0, 15).map(tagRow).join("") || '<p class="muted small">None pulling posts down.</p>'}</div>
        <div class="stack" style="gap:6px"><h3>Average (${a.hashtags.average.length})</h3>${a.hashtags.average.slice(0, 15).map(tagRow).join("") || '<p class="muted small">—</p>'}</div>
      </div>
      ${a.hashtags.once.length ? `<details><summary class="link small" style="cursor:pointer">Tried only once (${a.hashtags.once.length}): try the top ones again to know for sure</summary><div class="row" style="gap:6px;margin-top:10px">${a.hashtags.once.slice(0, 40).map((x) => `<span class="kw" title="${esc(idxTxt(x.index).replace(/<[^>]+>/g, ""))} vs similar posts">${esc(x.tag)} <span class="muted" style="font-weight:600;margin-left:4px">${idxTxt(x.index).replace(/<[^>]+>/g, "")}</span></span>`).join("")}</div></details>` : ""}
      <div class="grid g-2">
        <div class="stack" style="gap:8px"><h3>How many hashtags per post</h3>${idxBars(a.hashtags.count)}</div>
        <div class="stack" style="gap:8px"><h3>With vs without hashtags</h3>${idxBars([{ label: "With hashtags", ...a.hashtags.withVsWithout.with }, { label: "No hashtags", ...a.hashtags.withVsWithout.without }])}</div>
      </div></section>

    <section class="card"><h2>When you post (India time)</h2><div class="grid g-2"><div class="stack" style="gap:8px"><h3>Time of day</h3>${idxBars(a.dayparts)}</div><div class="stack" style="gap:8px"><h3>Day of week</h3>${idxBars(a.days)}</div></div>
      <p class="muted small">Green = better than your usual post, red = worse. The number after the dot is how many posts went out then.</p></section>

    <section class="card"><h2>Captions</h2><div class="grid g-2">
      <div class="stack" style="gap:8px"><h3>Caption length (hashtags not counted)</h3>${idxBars(a.captions)}<span class="muted small">${a.captions.map((c) => `${esc(c.label.split(" (")[0])}: ${c.comments} comments a post`).join(" · ")}</span></div>
      <div class="stack" style="gap:8px"><h3>Asking people to act</h3>${idxBars([{ label: "Asks (comment, DM, save…)", ...a.cta.with }, { label: "No ask", ...a.cta.without }])}<span class="muted small">Comments a post: ${a.cta.with.n ? `${a.cta.with.comments} with an ask` : "no posts with an ask"} · ${a.cta.without.n ? `${a.cta.without.comments} without` : "every post has an ask"}</span></div>
    </div></section>

    <section class="card"><h2>How people engage</h2>
      <div class="pst-grid">${[["Likes", e.likes], ["Comments", e.comments], ["Shares", e.shares], ["Saves", e.saves]].map(([l, v]) => `<div class="pst"><span class="v">${esc(num(v))}</span><span class="l">${l}, all ${a.posts} posts</span>${e.perThousand ? `<span class="l">${e.perThousand[l.toLowerCase()]} per 1,000 reached</span>` : ""}</div>`).join("")}${e.rate !== null ? `<div class="pst"><span class="v">${e.rate}%</span><span class="l">Engagement rate (interactions ÷ reach)</span></div>` : ""}</div>
      <p class="muted small">Saves and shares count most: they tell Instagram a post is worth showing to more people.</p></section>

    <section class="card"><h2>Posting rhythm</h2>
      <div class="weeks">${a.weeks.map((w) => `<div class="wk" title="Week of ${esc(w.week)}: ${w.posts} posts"><span style="height:${Math.max(4, (w.posts / weeksMax) * 100)}%">${w.posts || ""}</span><em>${esc(new Date(w.week + "T12:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }))}</em></div>`).join("")}</div>
      <div class="pst-grid"><div class="pst"><span class="v">${a.perWeek ?? "—"}</span><span class="l">Posts a week (last 7 weeks)</span></div><div class="pst"><span class="v">${a.longestGapDays ?? "—"}d</span><span class="l">Longest gap (60 days)</span></div><div class="pst"><span class="v">${a.daysSinceLastPost ?? "—"}d</span><span class="l">Since the last post</span></div>${a.trend ? `<div class="pst"><span class="v">${a.trend.change === null ? "—" : (a.trend.change > 0 ? "+" : "") + a.trend.change + "%"}</span><span class="l">Last ${a.trend.k} posts vs the ${a.trend.k} before</span></div>` : ""}</div></section>

    <div class="grid g-2">
      <section class="card"><h2>Best 5 posts</h2><div class="pgrid" style="grid-template-columns:repeat(auto-fill,minmax(110px,1fr))">${a.top.map(postTile).join("")}</div></section>
      <section class="card"><h2>Weakest 5 posts</h2><div class="pgrid" style="grid-template-columns:repeat(auto-fill,minmax(110px,1fr))">${a.bottom.map(postTile).join("") || '<p class="muted small">Not enough posts older than 2 days.</p>'}</div></section>
    </div>
  </div>`;
}
async function mountAnalysis(box, accId, refresh = false) {
  box.innerHTML = `<p class="muted">${refresh ? "Reading every post's numbers again…" : "Working out what works…"}</p>`;
  try {
    const d = await api("GET", `/api/analysis/${encodeURIComponent(accId)}${refresh ? "?refresh=1" : ""}`);
    box.innerHTML = analysisHtml(d, accId);
    const b = box.querySelector("[data-reanalyse]");
    if (b) b.onclick = () => mountAnalysis(box, accId, true);
  } catch (e) {
    box.innerHTML = `<p class="note bad">${esc(e.message)}</p>`;
  }
}

// ---------- Comments (inbox + under each post) ----------
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : dayName(iso);
}
function commentHtml(c, accId, { showPost = false, isNew = false } = {}) {
  const reply = (r) => `<div class="cm-reply ${r.hidden ? "is-hidden" : ""}"><b>${esc(r.username)}</b>${r.mine ? ' <span class="pill p-ok" style="padding:1px 7px">You</span>' : ""} <span class="muted small">${esc(ago(r.at))}</span><div class="cm-text">${esc(r.text)}</div></div>`;
  return `<div class="cm ${c.hidden ? "is-hidden" : ""}" data-cid="${esc(c.id)}" data-acc="${esc(accId)}">
    ${showPost && c.media ? `<a class="cm-post" href="${esc(c.media.url)}" target="_blank" rel="noopener" title="Open the post">${c.media.thumb ? `<img src="${esc(c.media.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span>${esc(c.media.type)}</span>`}</a>` : ""}
    <div class="stack" style="gap:6px;min-width:0;flex:1">
      <div class="row" style="gap:8px"><b>${esc(c.username || "someone")}</b><span class="muted small">${esc(ago(c.at))}${c.likes ? ` · ♥ ${esc(num(c.likes))}` : ""}</span>${isNew ? pill("scheduled", "New") : ""}${c.replied ? pill("ok", "Replied") : ""}${c.hidden ? pill("draft", "Hidden") : ""}</div>
      <div class="cm-text">${esc(c.text)}</div>
      ${showPost && c.media?.caption ? `<span class="muted small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">On: ${esc(c.media.caption)}</span>` : ""}
      ${c.replies.length ? `<div class="stack" style="gap:6px">${c.replies.map(reply).join("")}</div>` : ""}
      <div class="row" style="gap:6px">
        <button class="btn sm" type="button" data-act="reply">Reply</button>
        <button class="btn sm" type="button" data-act="hide" data-hide="${c.hidden ? "0" : "1"}">${c.hidden ? "Unhide" : "Hide"}</button>
        <button class="btn sm danger" type="button" data-act="delete">Delete</button>
      </div>
      <form class="cm-form" hidden><textarea name="message" rows="2" maxlength="2200" placeholder="Write a reply… (it starts with @${esc(c.username)})" style="min-height:70px"></textarea><div class="row" style="gap:6px"><button class="btn sm primary" type="submit">Send reply</button><button class="btn sm" type="button" data-act="cancel">Cancel</button></div></form>
    </div>
  </div>`;
}
function wireComments(root, onChange) {
  root.onclick = async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const box = b.closest(".cm");
    const acc = box.dataset.acc, cid = box.dataset.cid;
    const form = box.querySelector(".cm-form");
    if (b.dataset.act === "reply") {
      form.hidden = false;
      const ta = form.querySelector("textarea");
      const user = box.querySelector("b")?.textContent || "";
      if (!ta.value) ta.value = user ? `@${user} ` : "";
      ta.focus();
      return;
    }
    if (b.dataset.act === "cancel") { form.hidden = true; return; }
    try {
      if (b.dataset.act === "hide") {
        b.disabled = true;
        await api("POST", `/api/comments/${encodeURIComponent(acc)}/${encodeURIComponent(cid)}/hide`, { hide: b.dataset.hide === "1" });
        toast(b.dataset.hide === "1" ? "Comment hidden" : "Comment visible again");
      } else if (b.dataset.act === "delete") {
        if (!confirm("Delete this comment from Instagram? This cannot be undone.")) return;
        await api("DELETE", `/api/comments/${encodeURIComponent(acc)}/${encodeURIComponent(cid)}`);
        toast("Comment deleted");
      }
      onChange && onChange();
    } catch (err) {
      b.disabled = false;
      toast(err.message, true);
    }
  };
  root.onsubmit = async (e) => {
    const form = e.target.closest(".cm-form");
    if (!form) return;
    e.preventDefault();
    const box = form.closest(".cm");
    const message = form.querySelector("textarea").value.trim();
    if (!message) return;
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      await api("POST", `/api/comments/${encodeURIComponent(box.dataset.acc)}/${encodeURIComponent(box.dataset.cid)}/reply`, { message });
      toast("Reply sent");
      onChange && onChange();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = "Send reply";
    }
  };
}

async function screenInbox(q) {
  const d = await accounts();
  const list = d.accounts.filter((a) => a.platform === "instagram");
  const only = q.get("account");
  const filter = q.get("show") || "all";
  const link = (k, v) => { const p = new URLSearchParams(q); v ? p.set(k, v) : p.delete(k); return `#/inbox?${p}`; };
  main(`
    <header class="head"><div><p class="sub">Newest comments on your recent posts</p><h1>Comments</h1></div><div class="row"><div class="seg"><button type="button" class="on">Inbox</button><a href="#/autoreplies">Auto-replies</a></div><button class="btn" id="cm-refresh" type="button">Refresh</button></div></header>
    <div class="row" role="group" aria-label="Show">
      <a class="chip ${filter === "all" ? "on" : ""}" href="${link("show", "")}">All</a>
      <a class="chip ${filter === "todo" ? "on" : ""}" href="${link("show", "todo")}">Not replied yet</a>
      <a class="chip ${filter === "new" ? "on" : ""}" href="${link("show", "new")}">New since last visit</a>
    </div>
    <div class="row" role="group" aria-label="Account"><a class="acc-chip ${!only ? "on" : ""}" style="text-decoration:none;color:inherit;padding-left:12px" href="${link("account", "")}">All accounts</a>${list.map((a) => `<a class="acc-chip ${only === a.id ? "on" : ""}" style="text-decoration:none;color:inherit" href="${link("account", a.id)}">${avatar(a, 26)}${esc(a.handle || a.name)}</a>`).join("")}</div>
    <p class="note">Facebook Page comments come next: Meta needs one more permission for them.</p>
    <section class="card" id="cm-list"><p class="muted">Loading comments…</p></section>`);
  $("#cm-refresh").onclick = () => render();
  const targets = only ? list.filter((a) => a.id === only) : list;
  const results = await Promise.all(targets.map((a) => api("GET", `/api/inbox/${encodeURIComponent(a.id)}`).catch((e) => ({ account: a, comments: [], error: e.message }))));
  const box = $("#cm-list");
  if (!box) return;
  const rows = [];
  const errors = [];
  for (const r of results) {
    if (r.error) errors.push(`${r.account.name}: ${r.error}`);
    for (const c of r.comments) rows.push({ c, acc: r.account, isNew: !r.seenAt || c.at > r.seenAt });
  }
  rows.sort((x, y) => String(y.c.at).localeCompare(String(x.c.at)));
  const shown = rows.filter((x) => (filter === "todo" ? !x.c.replied : filter === "new" ? x.isNew : true));
  box.innerHTML = `${errors.length ? `<p class="note bad">${esc(errors.join(" · "))}</p>` : ""}
    <div class="row between"><h2>${shown.length} comment${shown.length === 1 ? "" : "s"}</h2><span class="muted small">${rows.filter((x) => !x.c.replied).length} not replied · ${rows.filter((x) => x.isNew).length} new</span></div>
    ${shown.map(({ c, acc, isNew }) => `<div class="cm-wrap"><a class="muted small" style="font-weight:700;text-decoration:none" href="#/account?id=${encodeURIComponent(acc.id)}" class="row" style="gap:6px">${avatar(acc, 20)} ${esc(acc.handle || acc.name)}</a>${commentHtml(c, acc.id, { showPost: true, isNew })}</div>`).join("") || `<p class="muted">${filter === "all" ? "No comments on your recent posts yet." : "Nothing here. You're all caught up."}</p>`}`;
  wireComments(box, () => render());
  // Mark as seen a moment after showing, so "New" badges stay visible on this visit.
  setTimeout(() => api("POST", "/api/inbox/seen", { ids: targets.map((a) => a.id) }).catch(() => {}), 1500);
}

// ---------- Auto-replies ----------
async function screenAutoReplies(q) {
  const [d, acc] = await Promise.all([api("GET", "/api/autoreplies"), accounts()]);
  const ig = acc.accounts.filter((a) => a.platform === "instagram");
  const byId = Object.fromEntries(acc.accounts.map((a) => [a.id, a]));
  const editing = q.get("edit") ? d.rules.find((r) => r.id === q.get("edit")) : q.get("new") ? {} : null;
  const ruleCard = (r) => `<div class="card tight rule ${r.on ? "on" : ""}">
    <div class="row between"><div class="row" style="gap:10px"><label class="switch" title="${r.on ? "On" : "Off"}"><input type="checkbox" data-toggle="${esc(r.id)}" ${r.on ? "checked" : ""}><span></span></label><b style="font-size:15px">${esc(r.name)}</b>${r.on ? pill("ok", "On") : pill("draft", "Off")}</div>
      <div class="row" style="gap:6px"><a class="btn sm" href="#/autoreplies?edit=${esc(r.id)}">Edit</a><button class="btn sm danger" type="button" data-delrule="${esc(r.id)}" data-name="${esc(r.name)}">Delete</button></div></div>
    <div class="muted small">${r.accountIds.map((id) => esc(byId[id]?.handle || byId[id]?.name || "removed account")).join(", ")}</div>
    <div class="row" style="gap:6px">${r.everyComment ? '<span class="kw">Every comment</span>' : r.keywords.map((k) => `<span class="kw">${esc(k)}</span>`).join("")}</div>
    ${r.replies.map((t, i) => `<div class="cm-reply"><span class="muted small">Reply${r.replies.length > 1 ? ` ${i + 1}` : ""}</span><div class="cm-text">${esc(t)}</div></div>`).join("")}
    ${r.dm ? `<div class="cm-reply" style="background:#F3EFFF"><span class="muted small">DM</span><div class="cm-text">${esc(r.dm)}</div></div>` : ""}
    <span class="muted small">${r.stats?.replies || 0} replies · ${r.stats?.dms || 0} DMs sent${r.stats?.lastAt ? ` · last ${esc(ago(r.stats.lastAt))}` : ""}${r.on && r.onSince ? ` · answering comments since ${esc(whenText(r.onSince))}` : ""}</span>
  </div>`;
  const e = editing || {};
  const form = editing ? `<section class="card" id="rule-form-card"><h2>${e.id ? "Edit auto-reply" : "New auto-reply"}</h2>
    <form class="stack" id="rule-form">
      <label class="f">Name (just for you)<input type="text" name="rname" value="${esc(e.name || "")}" placeholder="e.g. DEMO requests"></label>
      <div class="stack" style="gap:6px"><b style="font-size:12px;color:var(--ink-2)">On which accounts</b><div class="row">${ig.map((a) => `<label class="check" style="border:1px solid var(--line);border-radius:10px;padding:0 10px"><input type="checkbox" name="acc" value="${esc(a.id)}" ${(e.accountIds || []).includes(a.id) ? "checked" : ""}>${esc(a.handle || a.name)}</label>`).join("")}</div></div>
      <label class="f">Reply when a comment has any of these words (comma between them)<input type="text" name="keywords" value="${esc((e.keywords || []).join(", "))}" placeholder="demo, price, details, kitna"></label>
      <label class="check"><input type="checkbox" name="everyComment" ${e.everyComment ? "checked" : ""}> Reply to every comment (ignore the words)</label>
      <label class="f">Reply 1<textarea name="r0" rows="3" maxlength="900" placeholder="Hi {username}! Sent you the details in DM 🙌">${esc(e.replies?.[0] || "")}</textarea></label>
      <label class="f">Reply 2 (optional, picked at random so replies don't look copy-pasted)<textarea name="r1" rows="2" maxlength="900">${esc(e.replies?.[1] || "")}</textarea></label>
      <label class="f">Reply 3 (optional)<textarea name="r2" rows="2" maxlength="900">${esc(e.replies?.[2] || "")}</textarea></label>
      <label class="f">Also send a DM (optional)<textarea name="dm" rows="3" maxlength="900" placeholder="Thanks for asking! Here are the details…">${esc(e.dm || "")}</textarea></label>
      <p class="muted small">Write <b>{username}</b> to mention the person. A DM can only go out within 7 days of the comment, and Meta may hold DMs until the app is approved. The activity list below will show if one fails.</p>
      <label class="check"><input type="checkbox" name="on" ${e.on ? "checked" : ""}> Switch on now</label>
      ${e.on ? "" : '<label class="check"><input type="checkbox" name="lookBack24h"> Also answer matching comments from the last 24 hours</label>'}
      <div class="row"><button class="btn primary" type="submit">Save</button><a class="btn" href="#/autoreplies">Cancel</a></div>
    </form></section>` : "";
  const log = d.log.slice(0, 40).map((l) => `<div class="list-row" style="grid-template-columns:110px minmax(0,1fr)"><span class="muted small">${esc(ago(l.at))}</span><div style="min-width:0">${l.username ? `<b>${esc(l.account)}</b> · <b>${esc(l.username)}</b>: <span class="muted">${esc(l.comment || "")}</span>` : `<b>${esc(l.account)}</b>`}${l.reply ? `<div class="small">↳ Replied: ${esc(l.reply)}</div>` : ""}${l.dm ? `<div class="small">✉ DM sent</div>` : ""}${l.error ? `<div class="small" style="color:var(--red)">${esc(l.error)}</div>` : ""}</div></div>`).join("");
  main(`
    <header class="head"><div><p class="sub">When someone comments a keyword, Social HQ answers for you within about 3 minutes</p><h1>Comments</h1></div><div class="row"><div class="seg"><a href="#/inbox">Inbox</a><button type="button" class="on">Auto-replies</button></div><a class="btn primary" href="#/autoreplies?new=1">+ New auto-reply</a></div></header>
    ${form}
    <section class="stack" style="gap:12px">${d.rules.map(ruleCard).join("") || `<div class="card"><p class="muted">No auto-replies yet.</p><a class="btn primary" style="align-self:flex-start" href="#/autoreplies?new=1">+ New auto-reply</a></div>`}</section>
    <section class="card"><h2>Try it</h2><p class="muted small">Type a comment someone might write. Social HQ shows which rule would answer and what it would say. Nothing is sent.</p>
      <form class="row" id="try-form"><input type="text" name="text" placeholder="e.g. Price kya hai? DEMO please" style="flex:1 1 260px" required><button class="btn" type="submit">Check</button></form><div id="try-out"></div></section>
    <section class="card"><div class="row between"><h2>Activity</h2><span class="row" style="gap:8px"><span class="muted small">${d.lastRun ? `Last check ${esc(ago(d.lastRun.at))}` : "Not checked yet"}</span><button class="btn sm" type="button" id="run-now">Check now</button></span></div>${log || '<p class="muted">Nothing yet. Replies show here as they go out.</p>'}</section>`);
  if (editing) $("#rule-form-card").scrollIntoView?.({ behavior: "smooth", block: "start" });
  $$("[data-toggle]").forEach((t) => (t.onchange = async () => {
    try {
      await api("PUT", `/api/autoreplies/${t.dataset.toggle}`, { on: t.checked });
      toast(t.checked ? "Auto-reply on" : "Auto-reply off");
      render();
    } catch (err) { toast(err.message, true); t.checked = !t.checked; }
  }));
  $$("[data-delrule]").forEach((b) => (b.onclick = async () => {
    if (!confirm(`Delete the auto-reply “${b.dataset.name}”?`)) return;
    await api("DELETE", `/api/autoreplies/${b.dataset.delrule}`);
    toast("Deleted");
    render();
  }));
  $("#try-form").onsubmit = async (ev) => {
    ev.preventDefault();
    const r = await api("POST", "/api/autoreplies/test", { text: new FormData(ev.target).get("text") });
    $("#try-out").innerHTML = r.match
      ? `<div class="note good" style="margin-top:10px">Rule <b>${esc(r.rule)}</b>${r.on ? "" : " (switched off right now)"} would answer${r.keyword ? ` because of “${esc(r.keyword)}”` : ""}.${r.reply ? `<br>Reply: ${esc(r.reply)}` : ""}${r.dm ? `<br>DM: ${esc(r.dm)}` : ""}</div>`
      : `<p class="note" style="margin-top:10px">No rule matches this comment, so no reply would go out.</p>`;
  };
  $("#run-now").onclick = async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = "Checking…";
    try {
      const r = await api("POST", "/api/autoreplies/run");
      toast(r.replied ? `Sent ${r.replied} repl${r.replied === 1 ? "y" : "ies"}` : "Checked: nothing new to answer");
      render();
    } catch (err) { toast(err.message, true); ev.target.disabled = false; ev.target.textContent = "Check now"; }
  };
  if (editing) {
    $("#rule-form").onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const el = (n) => f.elements.namedItem(n);
      const body = {
        name: el("rname").value,
        accountIds: $$('input[name="acc"]:checked', f).map((x) => x.value),
        keywords: el("keywords").value,
        everyComment: el("everyComment").checked,
        replies: [el("r0").value, el("r1").value, el("r2").value],
        dm: el("dm").value,
        on: el("on").checked,
        lookBack24h: !!el("lookBack24h")?.checked,
      };
      try {
        await api(e.id ? "PUT" : "POST", e.id ? `/api/autoreplies/${e.id}` : "/api/autoreplies", body);
        toast(body.on ? "Saved and switched on" : "Saved (switched off)");
        location.hash = "#/autoreplies";
      } catch (err) { toast(err.message, true); }
    };
  }
}

// ---------- Competitors ----------
async function screenCompetitors(q) {
  main(`<header class="head"><div><p class="sub">Public numbers of any business Instagram, next to yours</p><h1>Competitors</h1></div></header><p class="muted">Loading…</p>`);
  const d = await api("GET", `/api/competitors${q.get("fresh") ? "?fresh=1" : ""}`);
  const sortKey = q.get("sort") || "followers";
  const rows = d.rows.filter((r) => !r.error).sort((a, b) => (b[sortKey] ?? -1) - (a[sortKey] ?? -1));
  const bad = d.rows.filter((r) => r.error);
  const th = (k, label) => `<th><a href="#/competitors?sort=${k}" style="color:inherit;text-decoration:${sortKey === k ? "underline" : "none"}">${label}</a></th>`;
  main(`
    <header class="head"><div><p class="sub">Public numbers of any business Instagram, next to yours</p><h1>Competitors</h1></div><a class="btn" href="#/competitors?fresh=1">Refresh numbers</a></header>
    <section class="card"><h2>Track an account</h2>
      <form class="row" id="comp-form"><input type="text" name="username" placeholder="Instagram username, e.g. some_forklift_brand" required style="max-width:340px" autocomplete="off"><button class="btn primary" type="submit">Start tracking</button></form>
      <p class="muted small">Works for public business and creator accounts. Numbers refresh every 6 hours and a growth history builds up day by day.</p></section>
    ${bad.length ? `<p class="note bad">${bad.map((r) => `@${esc(r.username)}: ${esc(r.error)}`).join("<br>")}</p>` : ""}
    <section class="card"><div class="row between"><h2>Side by side</h2><span class="muted small">${d.tracked} tracked · your accounts are marked “You”</span></div>
      <div class="tbl"><table><thead><tr><th>Account</th>${th("followers", "Followers")}${th("change28", "28-day change")}${th("postsPerWeek", "Posts / week")}${th("avgLikes", "Avg. likes")}${th("avgComments", "Avg. comments")}${th("engagement", "Engagement")}${th("maxLikes", "Best post (likes)")}${th("reelsShare", "Reels")}<th>Top hashtag</th><th>Last post</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="${r.you ? "you-row" : ""}">
        <td><a class="acc-cell" style="text-decoration:none;color:inherit" href="#/competitors?u=${encodeURIComponent(r.username)}">${r.avatar ? `<img class="av" src="${esc(r.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : badge("instagram", true)}<div><div class="n">${esc(r.name)} ${r.you ? pill("ok", "You") : ""}</div><div class="h">@${esc(r.username)}</div></div></a></td>
        <td><b>${esc(num(r.followers))}</b></td>
        <td class="${r.change28 > 0 ? "up" : r.change28 < 0 ? "down" : ""}">${r.change28 === null ? '<span class="muted small">builds up</span>' : esc(signed(r.change28))}</td>
        <td>${esc(String(r.postsPerWeek))}</td>
        <td>${esc(num(r.avgLikes))}</td>
        <td>${esc(r.avgComments === null ? "—" : String(r.avgComments))}</td>
        <td>${esc(pct(r.engagement))}</td>
        <td>${esc(num(r.maxLikes))}</td>
        <td>${r.reelsShare === null ? "—" : esc(r.reelsShare + "%")}</td>
        <td>${r.topTag ? `<span class="kw">${esc(r.topTag)}</span>` : '<span class="muted small">none</span>'}</td>
        <td class="muted small">${r.lastPostAt ? esc(ago(r.lastPostAt)) : "—"}</td>
        <td>${r.you ? "" : `<button class="btn sm danger" type="button" data-untrack="${esc(r.username)}">Stop</button>`}</td>
      </tr>`).join("")}</tbody></table></div>
      <p class="muted small">Engagement = average likes + comments per post ÷ followers. Click an account to see its best posts.</p></section>
    <section id="comp-detail"></section>`);
  $("#comp-form").onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      const r = await api("POST", "/api/competitors", { username: new FormData(e.target).get("username") });
      toast(`Now tracking @${r.username}`);
      location.hash = `#/competitors?u=${encodeURIComponent(r.username)}`;
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = "Start tracking";
    }
  };
  $$("[data-untrack]").forEach((b) => (b.onclick = async () => {
    if (!confirm(`Stop tracking @${b.dataset.untrack}?`)) return;
    await api("DELETE", `/api/competitors/${encodeURIComponent(b.dataset.untrack)}`);
    toast("Stopped tracking");
    location.hash = "#/competitors";
  }));
  const u = q.get("u");
  if (!u) return;
  const box = $("#comp-detail");
  box.innerHTML = `<p class="muted">Loading @${esc(u)}…</p>`;
  try {
    const c = await api("GET", `/api/competitors/${encodeURIComponent(u)}`);
    const top = [...c.media].filter((m) => m.likes !== null).sort((a, b) => b.likes + b.comments - (a.likes + a.comments)).slice(0, 12);
    box.innerHTML = `<section class="card">
      <div class="prof-top">${c.avatar ? `<img class="prof-av" src="${esc(c.avatar)}" alt="" referrerpolicy="no-referrer">` : ""}
        <div class="stack" style="gap:8px;flex:1 1 260px;min-width:0"><div class="row"><h2 style="font-size:22px">${esc(c.name)}</h2><a class="btn sm" href="https://www.instagram.com/${esc(c.username)}/" target="_blank" rel="noopener">Open on Instagram ↗</a></div>
          <div class="prof-counts"><div><b>${esc(num(c.posts))}</b><span>Posts</span></div><div><b>${esc(num(c.followers))}</b><span>Followers</span></div><div><b>${esc(String(c.postsPerWeek))}</b><span>Posts a week</span></div><div><b>${esc(num(c.avgLikes))}</b><span>Avg. likes</span></div><div><b>${esc(pct(c.engagement))}</b><span>Engagement</span></div></div>
          ${c.bio ? `<p class="prof-bio">${esc(c.bio)}</p>` : ""}</div></div>
      ${c.insights.length ? `<div class="stack" style="gap:6px"><h3>What they're doing</h3><ul class="tiplist" style="padding-left:18px">${c.insights.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      <div class="pst-grid">
        <div class="pst"><span class="v">${esc(String(c.postsPerWeek))}</span><span class="l">Posts a week</span></div>
        <div class="pst"><span class="v">${esc(num(c.avgLikes))}</span><span class="l">Avg. likes (last 12)</span></div>
        <div class="pst"><span class="v">${esc(c.avgComments === null ? "—" : String(c.avgComments))}</span><span class="l">Avg. comments</span></div>
        <div class="pst"><span class="v">${esc(pct(c.engagement))}</span><span class="l">Engagement</span></div>
        <div class="pst"><span class="v">${esc(String(c.hashtagsPerPost))}</span><span class="l">Hashtags a post</span></div>
        <div class="pst"><span class="v">${esc(String(c.captionLength))}</span><span class="l">Letters in a caption</span></div>
        <div class="pst"><span class="v">${c.lastPostAt ? esc(ago(c.lastPostAt)) : "—"}</span><span class="l">Last post</span></div>
        <div class="pst"><span class="v">${c.change28 === null ? "—" : esc(signed(c.change28))}</span><span class="l">Followers, 28 days</span></div>
      </div>
      <div class="grid g-2">
        <div class="stack" style="gap:8px"><h3>Their content types</h3><div class="tbl"><table style="min-width:0"><thead><tr><th>Type</th><th>Posts</th><th>Avg. likes + comments</th><th>vs their usual</th></tr></thead><tbody>${c.analysis.types.map((x) => `<tr><td><b>${esc(x.type)}</b></td><td>${x.n}</td><td>${esc(num(x.avg))}</td><td>${idxTxt(x.index)}</td></tr>`).join("")}</tbody></table></div></div>
        <div class="stack" style="gap:8px"><h3>Hashtags they use most</h3><div class="row" style="gap:6px">${c.mostUsed.map((t) => `<span class="kw" style="${t.yours ? "background:var(--green-soft);color:var(--green)" : ""}" title="${t.yours ? "You use this one too" : "You don't use this one"}">${esc(t.tag)} · ${t.uses}</span>`).join("") || '<span class="muted small">They don\'t use hashtags.</span>'}</div><span class="muted small">Green = you use it too.</span>
          ${c.analysis.hashtags.working.length ? `<h3 style="margin-top:6px">Their best hashtags</h3><div class="row" style="gap:6px">${c.analysis.hashtags.working.slice(0, 10).map((t) => `<span class="kw">${esc(t.tag)} ${idxTxt(t.index).replace(/<[^>]+>/g, "")}</span>`).join("")}</div>` : ""}
          ${c.toTry.length ? `<h3 style="margin-top:6px">Worth testing on your posts</h3><div class="row" style="gap:6px">${c.toTry.map((t) => `<span class="kw" style="background:var(--orange-soft);color:var(--orange)">${esc(t.tag)}</span>`).join("")}</div>` : ""}</div>
      </div>
      <div class="grid g-2">
        <div class="stack" style="gap:8px"><h3>When they post, and what works (India time)</h3>${idxBars(c.analysis.dayparts)}</div>
        <div class="stack" style="gap:8px"><h3>Days they post</h3>${idxBars(c.analysis.days)}</div>
      </div>
      <div class="stack" style="gap:8px"><h3>Their posting rhythm (last 8 weeks)</h3><div class="weeks">${c.analysis.weeks.map((w) => { const mx = Math.max(...c.analysis.weeks.map((x) => x.posts), 1); return `<div class="wk"><span style="height:${Math.max(4, (w.posts / mx) * 100)}%">${w.posts || ""}</span><em>${esc(new Date(w.week + "T12:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }))}</em></div>`; }).join("")}</div></div>
      <h3>Their best recent posts</h3>
      <div class="pgrid">${top.map((m) => `<a class="ptile" href="${esc(m.url)}" target="_blank" rel="noopener" title="${esc(m.caption)}">${m.thumb ? `<img src="${esc(m.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="ptxt">${esc(m.caption.slice(0, 120))}</span>`}<span class="ptype">${esc(POST_ICON[m.type] || m.type)}</span><span class="pstat"><span>♥ ${esc(num(m.likes))}</span><span>💬 ${esc(num(m.comments))}</span></span><span class="pdate">${esc(dayName(m.at))}</span></a>`).join("") || '<p class="muted">No posts yet.</p>'}</div>
      ${c.hist.length > 1 ? `<h3>Followers over time</h3>${growth(c.hist)}` : '<p class="muted small">The follower chart starts after two days of tracking.</p>'}
    </section>`;
    box.scrollIntoView?.({ behavior: "smooth", block: "start" });
  } catch (e) {
    box.innerHTML = `<p class="note bad">${esc(e.message)}</p>`;
  }
}

// ---------- Insights ----------
async function screenInsights(q) {
  const list = await api("GET", "/api/insights");
  if (!list.accounts.length) {
    main(`<header class="head"><h1>Insights</h1></header><section class="card"><p class="muted">Connect accounts first. Insights are collected every 6 hours.</p><a class="btn primary" href="#/accounts" style="align-self:flex-start">Go to Accounts</a></section>`);
    return;
  }
  const id = q.get("id") || list.accounts[0].id;
  const d = await api("GET", `/api/insights/${encodeURIComponent(id)}`);
  const L = d.latest;
  const kpis = L ? [[L.followersLabel || "Followers", num(L.followers), L.followers === null ? "Not shared by this platform" : "Now"], ...L.kpis.map((k) => [k.label, num(k.value), k.period])] : [];
  const hist = (d.hist || []).filter((h) => typeof h.followers === "number");
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const scale = ["#F1F4FF", "#D6E0FF", "#A9BDFF", "#6F8DF7", "#2848E8"];
  const words = ["Poor", "Fair", "Good", "Very good", "Best"];
  const band = (v) => Math.min(4, Math.floor(v / 20.01));
  const hText = (h) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
  const topKey = Object.fromEntries(d.top.map((t, i) => [`${t.d}-${t.h}`, i + 1]));
  const heat = `<div class="tbl"><div class="heat"><div class="hr"><span></span>${d.hours.map((h) => `<span class="lbl">${h % 3 === 0 ? (h % 12 || 12) + (h < 12 ? "a" : "p") : ""}</span>`).join("")}</div>
    ${d.model.scores.map((row, di) => `<div class="hr"><span style="font-size:12px;font-weight:600;color:var(--ink-2)">${days[di]}</span>${row.map((v, hi) => {
      const rank = topKey[`${di}-${d.hours[hi]}`];
      return `<span class="cell" title="${days[di]} ${hText(d.hours[hi])}: ${words[band(v)]} (${v} out of 100)${rank ? ` · number ${rank} best hour of the week` : ""}" style="background:${rank ? "#B4500C" : scale[band(v)]}">${rank || ""}</span>`;
    }).join("")}</div>`).join("")}</div></div>
    <div class="row legend">${scale.map((c, i) => `<span><i style="background:${c}"></i>${words[i]}</span>`).join("")}<span><i style="background:#B4500C"></i>Top 3 hours</span></div>`;
  const bestEachDay = d.model.scores.map((row, di) => { const m = Math.max(...row); return { d: days[di], h: d.hours[row.indexOf(m)], v: m }; });
  const hourText = (h) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
  const posts = (L?.posts || []).slice().sort((a, b) => (b.interactions || 0) + (b.views || 0) * 0.05 - ((a.interactions || 0) + (a.views || 0) * 0.05)).slice(0, 5);
  const cmp = list.accounts.slice().sort((a, b) => (b.growth28 ?? -1e9) - (a.growth28 ?? -1e9));
  main(`
    <header class="head"><div><p class="sub">${L ? `Updated ${esc(whenText(L.at))}` : "Not collected yet"} · numbers refresh every 6 hours</p><h1>Insights</h1></div>
      <div class="row"><a class="btn" href="#/account?id=${encodeURIComponent(id)}">Open account · all posts</a><button class="btn" id="refresh" type="button">Refresh now</button></div></header>
    <div class="row" role="group" aria-label="Pick an account">${list.accounts.map((a) => `<a class="acc-chip ${a.id === id ? "on" : ""}" style="text-decoration:none;color:inherit" href="#/insights?id=${encodeURIComponent(a.id)}">${avatar(a, 26)}${esc(a.platform === "instagram" ? a.handle || a.name : a.name)}</a>`).join("")}</div>
    ${L?.limited ? `<p class="note">${esc(L.limited)}</p>` : ""}
    ${L ? `<section class="grid g-kpi">${kpis.map(([l, v, s]) => `<div class="kpi"><span class="l">${esc(l)}</span><span class="v">${esc(v)}</span><span class="s">${esc(s)}</span></div>`).join("")}</section>` : `<p class="note">No numbers yet for this account. Press "Refresh now" and come back in a minute.</p>`}
    ${["instagram", "facebook", "youtube"].includes(d.account.platform) ? `<section id="ana-box"></section>` : ""}
    <div class="grid g-2">
      <section class="card"><div class="row between"><h2>${esc(L?.followersLabel || "Followers")}</h2><span class="muted small">${hist.length > 1 ? `${num(hist[0].followers)} → ${num(hist[hist.length - 1].followers)}` : "Builds up day by day"}</span></div>${growth(hist)}</section>
      <section class="card"><h2>Top posts</h2>${posts.length ? posts.map((p) => `<div class="row between" style="border-top:1px solid var(--line-2);padding-top:10px;flex-wrap:nowrap"><div class="stack" style="gap:3px;min-width:0"><a href="${esc(p.url || "#")}" target="_blank" rel="noopener" style="font-size:14px;font-weight:600;text-decoration:none;color:inherit">${esc(p.title || "Post")}</a><span class="muted small">${esc(p.type || "")} · ${p.at ? esc(dayName(p.at)) : ""}</span></div><div class="stack" style="gap:3px;align-items:flex-end;flex:0 0 auto"><b>${num(p.views || p.reach || 0)} ${p.views ? "views" : "reached"}</b><span class="muted small">${num(p.interactions)} interactions</span></div></div>`).join("") : `<p class="muted">No post data for this account yet.</p>`}</section>
    </div>
    <section class="card"><div class="row between" style="align-items:flex-start"><div class="stack" style="gap:6px;max-width:760px"><h2>Best time to post on ${esc(d.account.name)}</h2>
        <p style="font-size:14px;line-height:1.55">Each row is a day and each square is one hour (India time). The <b>darker the blue, the better</b> that hour is for posting on this account. The <b style="color:#B4500C">orange squares 1, 2, 3</b> are the three best hours of the whole week. Point at any square to see its score.</p>
        <p class="muted small">${d.model.learnedFrom ? `Worked out from ${d.model.learnedFrom} of your own posts (they count ${d.model.trust}%), plus a general starting guess for Indian audiences (${100 - d.model.trust}%)${d.model.usesOnline ? " and the hours your followers are online" : ""}. It gets more accurate with every post.` : `For now this is a general starting guess (${esc(d.startingWindow || "")}). It learns from your own posts as you publish.`}</p></div>
      <div class="stack" style="gap:6px"><b style="font-size:13px">Top 3 hours this week</b>${d.top.map((t, i) => `<span class="perfect" style="padding-left:5px"><span style="width:22px;height:22px;border-radius:50%;background:#B4500C;color:#fff;display:inline-flex;align-items:center;justify-content:center">${i + 1}</span>${days[t.d]} · ${hourText(t.h)}</span>`).join("")}</div></div>
      ${heat}
      <div class="stack" style="gap:6px"><b style="font-size:13px">Best hour on each day</b><div class="row" style="gap:6px">${bestEachDay.map((b) => `<span class="chip" style="cursor:default">${b.d} · ${hourText(b.h)}</span>`).join("")}</div></div></section>
    <section class="card"><h2>Compare all accounts · fastest growing first</h2><div class="tbl"><table><thead><tr><th>Account</th><th>Followers</th><th>Reach, 28 days</th><th>Engagement</th><th>Posts, 28 days</th><th>Growth, 28 days</th></tr></thead><tbody>
      ${cmp.map((a) => `<tr><td><div class="acc-cell">${avatar(a, 30)}<span class="n">${esc(a.name)}</span></div></td><td>${num(a.followers)}</td><td>${num(a.reach28)}</td><td>${pct(a.engagementRate)}</td><td>${a.posts28}</td><td class="${a.growth28 > 0 ? "up" : a.growth28 < 0 ? "down" : ""}">${signed(a.growth28)}</td></tr>`).join("")}
    </tbody></table></div><p class="muted small">Growth needs a few days of history; it fills in automatically.</p></section>`);
  $("#refresh").onclick = async () => {
    await api("POST", `/api/insights/refresh?account=${encodeURIComponent(id)}`);
    toast("Collecting fresh numbers. Reload in a minute.");
  };
  if ($("#ana-box")) mountAnalysis($("#ana-box"), id);
}
function growth(hist) {
  if (hist.length < 2) return `<p class="muted">The chart starts after two days of data.</p>`;
  const vals = hist.map((h) => h.followers);
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const pts = vals.map((v, i) => `${Math.round(i * (600 / (vals.length - 1)))},${Math.round(180 - ((v - min) / span) * 150)}`);
  return `<svg role="img" aria-label="Follower growth" width="100%" height="200" viewBox="0 0 600 200" preserveAspectRatio="none">
    <line x1="0" y1="30" x2="600" y2="30" stroke="#EEF0F3" vector-effect="non-scaling-stroke"/><line x1="0" y1="105" x2="600" y2="105" stroke="#EEF0F3" vector-effect="non-scaling-stroke"/><line x1="0" y1="180" x2="600" y2="180" stroke="#EEF0F3" vector-effect="non-scaling-stroke"/>
    <polygon points="0,200 ${pts.join(" ")} 600,200" fill="#EAF0FF"/><polyline points="${pts.join(" ")}" fill="none" stroke="#2848E8" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>
    <div class="row between muted small"><span>${esc(dayName(hist[0].d + "T12:00:00Z"))}</span><span>${esc(dayName(hist[hist.length - 1].d + "T12:00:00Z"))}</span></div>`;
}

// ---------- Settings ----------
const GUIDE = {
  alerts: `<p class="muted">When a post fails, Social HQ tries once more 10 minutes later. If it still fails, or an account's login is about to end, you get told — on every channel you set up here. Alerts also show on the Overview screen.</p>
    <ol class="muted"><li><b>WhatsApp (free):</b> save <b>+34 694 25 79 72</b> in your phone as "CallMeBot" and send it this WhatsApp message: <code>I allow callmebot to send me messages</code>. It replies with a key. Put your number and that key below.</li>
    <li><b>Phone notification (free):</b> install the <b>ntfy</b> app, tap <b>+</b>, and subscribe to a private name only you know (for example <code>socialhq-pratham-7391</code>). Type the same name below.</li>
    <li><b>Email:</b> uses the Resend key in "Reminder emails" further down; leave the address empty to use the reminder address.</li></ol>
    <p class="row" style="gap:8px"><button class="btn sm" type="button" id="test-alert">Send a test alert</button><span class="muted small" id="test-alert-out"></span></p>`,
  instagram: `<ol class="muted"><li>Open <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">Meta for Developers → My Apps</a>, create an app with the use cases <b>Manage messaging & content on Instagram</b> and <b>Manage everything on your Page</b>, and connect it to your business portfolio.</li><li>Copy the <b>App ID</b> and <b>App secret</b> (App settings → Basic) here. Facebook Pages uses the same two, so you only type them once.</li><li>Under <b>Instagram → API setup with Unified login</b>, create a configuration, add the redirect address below, and paste the <b>Configuration ID</b> here.</li><li>Under <b>App roles → Roles</b>, add each Instagram account as an <b>Instagram tester</b>, then accept the invite in each account (Instagram app → Settings → Website permissions → Apps and websites → Tester invites).</li></ol>`,
  facebook: `<ol class="muted"><li>Leave App ID and secret empty if you filled them in for Instagram above.</li><li>Under <b>Facebook Login for Business → Configurations</b>, create one with a <b>User access token</b> and the Page permissions, and paste its <b>Configuration ID</b> here.</li><li>Under <b>Facebook Login for Business → Settings</b>, add the redirect address shown below.</li></ol>`,
  linkedin: `<ol class="muted"><li>Open <a href="https://www.linkedin.com/developers/apps" target="_blank" rel="noopener">LinkedIn Developers</a>, create an app linked to the LIFTLINE page.</li><li>Under <b>Products</b>, add <b>Sign In with LinkedIn using OpenID Connect</b> and <b>Share on LinkedIn</b>.</li><li>Under <b>Auth</b>, copy the Client ID and secret here and add the redirect address below.</li><li>For company pages, LinkedIn must approve the Community Management API (separate app). Tick "Company pages" only after that.</li></ol>`,
  youtube: `<ol class="muted"><li>Open <a href="https://console.cloud.google.com" target="_blank" rel="noopener">Google Cloud Console</a> with info.liftline@gmail.com, create a project.</li><li>Enable <b>YouTube Data API v3</b> and <b>YouTube Analytics API</b>.</li><li>Set up the OAuth consent screen (External) and press <b>Publish app</b> so logins don't end after 7 days.</li><li>Create an OAuth client (Web application), add the redirect address below, copy the Client ID and secret here.</li></ol>`,
  pinterest: `<ol class="muted"><li>Open <a href="https://developers.pinterest.com/apps/" target="_blank" rel="noopener">Pinterest Developers</a> with the infoliftline account and create an app.</li><li>Add the redirect address below, copy the App ID and secret here.</li><li>Keep "Sandbox" on until Pinterest gives Standard access, then turn it off.</li></ol>`,
  reminders: `<p class="muted">Optional. Make a free <a href="https://resend.com" target="_blank" rel="noopener">Resend</a> account, create an API key, and paste it here with your email. Without it, reminders still show on the Overview screen.</p>`,
  general: `<p class="muted">Leave as it is unless Claude tells you to change it.</p>`,
};
const FIELD_LABEL = { appId: "App ID", appSecret: "App secret", clientId: "Client ID", clientSecret: "Client secret", orgAccess: "Company pages approved by LinkedIn", version: "LinkedIn API version (YYYYMM)", sandbox: "Sandbox (pins visible only to you)", resendKey: "Resend API key", to: "Send reminders to (email)", from: "From (optional)", graphVersion: "Meta Graph API version", configId: "Configuration ID", whatsappPhone: "WhatsApp number for alerts (with country code, e.g. +918800835120)", callmebotKey: "CallMeBot key (from the WhatsApp reply)", ntfyTopic: "Phone notification channel (ntfy app)", email: "Email alerts to (uses the Resend key above)", loginDays: "Warn this many days before a login ends" };

function claudeCard(sec) {
  return `<section class="card" id="claude"><h2>Claude</h2>
    <p class="muted">Let Claude schedule posts, read your plan and check insights for you, just by asking in chat.</p>
    <ol class="muted"><li>In Claude, open <b>Settings → Connectors → Add custom connector</b>.</li><li>Name it <b>Social HQ</b> and paste this address:</li></ol>
    <div class="row"><code>${esc(sec.mcpUrl)}</code><button class="btn sm" type="button" data-copytext="${esc(sec.mcpUrl)}">Copy</button></div>
    <ol class="muted" start="3"><li>Press <b>Connect</b>. Social HQ asks for your password${sec.twoStep ? " and 6-digit code" : ""}, then Claude is linked.</li></ol>
    <label class="check"><input type="checkbox" id="claude-ok" ${sec.claudeNeedsOk ? "checked" : ""}> Posts Claude schedules wait for my OK on the Overview screen</label>
    <h3 style="margin-top:12px">Connected</h3>
    ${sec.connections.length ? `<div class="stack" style="gap:6px">${sec.connections.map((c) => `<div class="row between" style="gap:8px"><span><b>${esc(c.name)}</b> <span class="muted small">· linked ${esc(whenText(c.createdAt))} · last used ${esc(whenText(c.lastUsedAt))}</span></span><button class="btn sm" type="button" data-revoke="${esc(c.id)}">Cut off</button></div>`).join("")}</div>` : '<p class="muted">Not connected yet.</p>'}
  </section>`;
}

function securityCard(sec) {
  return `<section class="card" id="security"><h2>Security</h2>
    <div class="row between" style="gap:10px"><span><b>2-step login</b><br><span class="muted small">${sec.twoStep ? `On · ${sec.recoveryLeft} recovery codes left` : "Off · a 6-digit code from your phone on top of your password"}</span></span>
      ${sec.twoStep ? '<span class="row" style="gap:6px"><button class="btn sm" type="button" id="new-recovery">New recovery codes</button><button class="btn sm" type="button" id="stop-2step">Turn off</button></span>' : '<button class="btn sm primary" type="button" id="start-2step">Turn on 2-step login</button>'}</div>
    <div id="twostep-box"></div>
    <div class="row between" style="gap:10px;border-top:1px solid var(--line-2);padding-top:12px"><span><b>Log out everywhere</b><br><span class="muted small">Ends Social HQ on every other phone and browser. You stay logged in here.</span></span><button class="btn sm" type="button" id="logout-all">Log out everywhere</button></div>
  </section>`;
}

function askOwner(twoStep, why) {
  const password = prompt(`${why}\n\nType your Social HQ password:`);
  if (!password) return null;
  let code = "";
  if (twoStep) {
    code = prompt("Type the 6-digit code from your authenticator app:") || "";
    if (!code) return null;
  }
  return { password, code };
}

function showRecovery(codes) {
  $("#twostep-box").innerHTML = `<div class="note warn" style="margin:10px 0"><b>Save these recovery codes now.</b> Each one works once if you lose your phone. They won't be shown again.<pre style="font-size:15px;margin:8px 0 0;white-space:pre-wrap">${codes.map(esc).join("\n")}</pre><button class="btn sm" type="button" data-copytext="${esc(codes.join("\n"))}">Copy codes</button></div>`;
  $$("#twostep-box [data-copytext]").forEach((b) => (b.onclick = async () => { await navigator.clipboard.writeText(b.dataset.copytext); toast("Copied"); }));
}

function wireSecurity(sec) {
  const ok = $("#claude-ok");
  if (ok) ok.onchange = async () => {
    try {
      await api("PUT", "/api/settings", { claude: { requireApproval: ok.checked } });
      toast(ok.checked ? "Claude's posts will wait for your OK" : "Claude's posts go out on time by themselves");
    } catch (err) {
      toast(err.message, true);
    }
  };
  $$("[data-revoke]").forEach((b) => (b.onclick = async () => {
    if (!confirmBox("Cut off this Claude connection? Claude will need to connect again.")) return;
    try {
      await api("DELETE", `/api/claude/connections/${encodeURIComponent(b.dataset.revoke)}`);
      toast("Claude cut off");
      render();
    } catch (err) {
      toast(err.message, true);
    }
  }));
  const start = $("#start-2step");
  if (start) start.onclick = async () => {
    try {
      const r = await api("POST", "/api/security/two-step/start");
      $("#twostep-box").innerHTML = `<div class="card tight" style="margin:10px 0"><b>1. Scan this with your authenticator app</b><span class="muted small">Google Authenticator, Microsoft Authenticator or 1Password: tap +, then "Scan a QR code".</span>
        <div style="width:180px;max-width:100%;background:#fff;padding:6px;border:1px solid var(--line-2);border-radius:10px">${r.qr}</div>
        <span class="muted small">Can't scan? Choose "Enter a setup key" and type: <code>${esc(r.secret)}</code></span>
        <form class="row" id="twostep-form" style="gap:8px;margin-top:6px"><label class="f" style="flex:1 1 160px">2. Type the 6-digit code it shows<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="123 456"></label><button class="btn primary sm" type="submit">Turn on</button></form></div>`;
      $("#twostep-form").onsubmit = async (e) => {
        e.preventDefault();
        try {
          const done = await api("POST", "/api/security/two-step/finish", Object.fromEntries(new FormData(e.target)));
          toast("2-step login is on");
          showRecovery(done.recovery);
          start.remove();
        } catch (err) {
          toast(err.message, true);
        }
      };
    } catch (err) {
      toast(err.message, true);
    }
  };
  const stop = $("#stop-2step");
  if (stop) stop.onclick = async () => {
    const who = askOwner(true, "Turning off 2-step login makes Social HQ easier to break into.");
    if (!who) return;
    try {
      await api("POST", "/api/security/two-step/stop", who);
      toast("2-step login is off");
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };
  const rec = $("#new-recovery");
  if (rec) rec.onclick = async () => {
    const who = askOwner(true, "New recovery codes replace the old ones.");
    if (!who) return;
    try {
      showRecovery((await api("POST", "/api/security/recovery-codes", who)).recovery);
    } catch (err) {
      toast(err.message, true);
    }
  };
  const all = $("#logout-all");
  if (all) all.onclick = async () => {
    if (!confirmBox("Log out Social HQ on every other phone and browser?")) return;
    try {
      await api("POST", "/api/security/logout-everywhere");
      toast("Logged out everywhere else");
    } catch (err) {
      toast(err.message, true);
    }
  };
}

function confirmBox(text) {
  return window.confirm(text);
}

async function screenSettings(q) {
  const s = await api("GET", "/api/settings");
  const missing = q.get("missing");
  const sections = ["alerts", "instagram", "facebook", "linkedin", "youtube", "pinterest", "reminders", "general"];
  const sec = await api("GET", "/api/security");
  main(`
    <header class="head"><div><p class="sub">Platform keys, reminders and your password</p><h1>Settings</h1></div></header>
    ${missing ? `<p class="note warn">Add the ${esc(PLATFORM[missing]?.name || missing)} keys below first, then press Connect on the Accounts screen.</p>` : ""}
    <section class="card tight"><h3>Your Social HQ address</h3><code>${esc(s.siteUrl)}</code></section>
    ${claudeCard(sec)}
    ${securityCard(sec)}
    ${sections.map((sec) => {
      const def = s[sec];
      const fields = Object.keys(def).filter((k) => k !== "label");
      return `<section class="card" id="sec-${sec}" ${missing === sec ? 'style="border-color:var(--orange-mid)"' : ""}><h2>${esc(def.label)}</h2>${GUIDE[sec] || ""}
        ${s.redirects[sec] ? `<div class="row"><span class="muted small">Redirect address:</span><code>${esc(s.redirects[sec])}</code><button class="btn sm" type="button" data-copytext="${esc(s.redirects[sec])}">Copy</button></div>` : ""}
        <form class="grid g-3" data-sec="${sec}" style="gap:10px">${fields.map((f) => {
          if (f.endsWith("Set")) {
            const name = f.slice(0, -3);
            return `<label class="f">${esc(FIELD_LABEL[name] || name)}<input type="password" name="${name}" autocomplete="off" placeholder="${def[f] ? "Saved — type to replace" : "Not set"}"></label>`;
          }
          if (typeof def[f] === "boolean") return `<label class="check"><input type="checkbox" name="${f}" ${def[f] ? "checked" : ""}> ${esc(FIELD_LABEL[f] || f)}</label>`;
          return `<label class="f">${esc(FIELD_LABEL[f] || f)}<input type="text" name="${f}" value="${esc(def[f])}" autocomplete="off"></label>`;
        }).join("")}<div class="row" style="grid-column:1/-1"><button class="btn primary sm" type="submit">Save</button></div></form></section>`;
    }).join("")}
    <section class="card" id="activity"><h2>Activity</h2><p class="muted">Logins, security changes, connections and everything Claude did. Newest first.</p>
      <div class="stack" style="gap:0">${sec.events.length ? sec.events.map((e) => `<div class="row" style="gap:10px;padding:8px 0;border-top:1px solid var(--line-2);align-items:flex-start"><span class="muted small" style="flex:0 0 132px">${esc(whenText(e.at))}</span><span style="flex:1 1 220px;min-width:0"><b style="font-weight:600">${esc(e.text)}</b><br><span class="muted small">${esc([e.device, e.where, e.ip].filter(Boolean).join(" · "))}</span></span></div>`).join("") : '<p class="muted">Nothing yet.</p>'}</div></section>
    <section class="card"><h2>Change password</h2><form class="grid g-3" id="pw-form" style="gap:10px"><label class="f">Current password<input type="password" name="current" required autocomplete="current-password"></label><label class="f">New password (8+ characters)<input type="password" name="next" required minlength="8" autocomplete="new-password"></label>${sec.twoStep ? '<label class="f">6-digit code<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required></label>' : ""}<div class="row" style="grid-column:1/-1"><button class="btn sm primary" type="submit">Change password</button></div></form></section>`);
  wireSecurity(sec);
  const ta = $("#test-alert");
  if (ta) ta.onclick = async () => {
    const out = $("#test-alert-out");
    out.textContent = "Sending…";
    try {
      const r = await api("POST", "/api/alerts/test");
      out.textContent = r.sent?.length ? `Sent by ${r.sent.join(", ")}.${r.errors?.length ? " Problem: " + r.errors.join("; ") : ""}` : r.errors?.length ? r.errors.join("; ") : "No channel set up yet. Fill one in, press Save, then try again.";
    } catch (e) {
      out.textContent = e.message;
    }
  };
  if (missing && $(`#sec-${missing}`)) $(`#sec-${missing}`).scrollIntoView?.();
  $$("[data-copytext]").forEach((b) => (b.onclick = async () => { await navigator.clipboard.writeText(b.dataset.copytext); toast("Copied"); }));
  $$("form[data-sec]").forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault();
    const sec = f.dataset.sec;
    const values = {};
    for (const el of f.elements) {
      if (!el.name) continue;
      if (el.type === "checkbox") values[el.name] = el.checked;
      else if (el.type === "password") { if (el.value.trim()) values[el.name] = el.value.trim(); }
      else values[el.name] = el.value;
    }
    try {
      await api("PUT", "/api/settings", { [sec]: values });
      state.accounts = null;
      toast("Saved");
      render();
    } catch (err) {
      toast(err.message, true);
    }
  }));
  $("#pw-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("POST", "/api/auth/password", Object.fromEntries(new FormData(e.target)));
      toast("Password changed");
      e.target.reset();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

render();
