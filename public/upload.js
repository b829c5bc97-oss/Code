// The private upload page. The secret key lives in the address after #k= (never sent to logs).
const $ = (s) => document.querySelector(s);
const key = new URLSearchParams(location.hash.slice(1)).get("k") || "";
const base = `/api/door/${encodeURIComponent(key)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const rows = [];

function bad(msg) {
  $("#bad").textContent = msg;
  $("#bad").hidden = false;
}
function draw() {
  $("#list").innerHTML = rows.map((r) => `<div class="file-row"><div class="thumb">${r.kind === "video" ? "VIDEO" : r.kind === "image" ? "PHOTO" : "LINK"}</div>
    <div class="stack" style="gap:4px;flex:1 1 auto;min-width:0"><span style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.name)}</span>
    <span class="muted small">${r.size ? `${(r.size / 1048576).toFixed(1)} MB · ` : ""}${esc(r.state)}</span>
    ${r.progress < 1 && !r.error ? `<div class="progress"><span style="width:${Math.round(r.progress * 100)}%"></span></div>` : ""}</div>
    <span class="pill ${r.error ? "p-failed" : r.progress >= 1 ? "p-done" : "p-scheduled"}">${r.error ? "Failed" : r.progress >= 1 ? "In the Inbox" : "Sending"}</span></div>`).join("");
}
async function api(method, path, body, raw) {
  const r = await fetch(base + path, raw ? { method, body, headers: { "content-type": "application/octet-stream" } } : { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
async function send(file) {
  const row = { name: file.name, size: file.size, kind: file.type.startsWith("video/") ? "video" : "image", progress: 0, state: "Starting…" };
  rows.unshift(row);
  draw();
  try {
    const init = await api("POST", "/start", { name: file.name, size: file.size, mime: file.type });
    for (let i = 0; i < init.chunks; i++) {
      const part = file.slice(i * init.chunkSize, (i + 1) * init.chunkSize);
      let ok = false;
      for (let t = 0; t < 3 && !ok; t++) {
        try {
          await api("PUT", `/part/${init.id}/${i}`, part, true);
          ok = true;
        } catch (e) {
          if (t === 2) throw e;
        }
      }
      row.progress = (i + 1) / init.chunks;
      row.state = `${Math.round(row.progress * 100)}%`;
      draw();
    }
    await api("POST", `/finish/${init.id}`, { caption: $("#cap").value });
    row.progress = 1;
    row.state = "Ready to schedule in Social HQ";
  } catch (e) {
    row.error = true;
    row.state = e.message;
  }
  draw();
}
async function sendAll(files) {
  for (const f of files) {
    if (!/^(image|video)\//.test(f.type)) {
      rows.unshift({ name: f.name, progress: 0, error: true, state: "Only photos and videos" });
      draw();
      continue;
    }
    await send(f);
  }
}

(async () => {
  if (!key) return bad("This page needs the full private link from Social HQ → Settings → Upload door.");
  try {
    await api("GET", "");
  } catch (e) {
    bad(e.message);
    $("#drop").hidden = true;
    return;
  }
  $("#file").onchange = () => sendAll([...$("#file").files]);
  const drop = $("#drop");
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); sendAll([...e.dataTransfer.files]); };
  $("#link-form").onsubmit = async (e) => {
    e.preventDefault();
    const url = $("#link").value.trim();
    const row = { name: url, progress: 0, state: "Downloading…" };
    rows.unshift(row);
    draw();
    try {
      const r = await api("POST", "/link", { url, caption: $("#cap").value });
      Object.assign(row, { name: r.file.name, size: r.file.size, kind: r.file.kind, progress: 1, state: r.warn || "Ready to schedule in Social HQ" });
      $("#link").value = "";
    } catch (err) {
      Object.assign(row, { error: true, state: err.message });
    }
    draw();
  };
})();
