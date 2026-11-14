/* Pace — reading speed trainer. Vanilla JS, hash-routed. */
(() => {
"use strict";

const CATS = ["health", "technology", "biology", "finance", "productivity", "history", "geopolitics", "biography"];
const KINDS = { news: "News", blog: "Blogs", essay: "Essays", book: "Books", knowledge: "Knowledge" };
const LENGTHS = { any: "Any length", short: "< 900 words", medium: "900–1600", long: "1600+" };
const MODES = {
  test: { name: "Speed test", desc: "Read naturally. Timer runs, then a quiz." },
  pacer: { name: "Pacer drill", desc: "A guide sweeps line by line at your target pace." },
  rsvp: { name: "Flash (RSVP)", desc: "Words flash in one spot. Kills regression." },
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const round10 = (x) => Math.round(x / 10) * 10;
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtDate = (ts) => new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const pct = (r) => (r.total ? Math.round((100 * r.score) / r.total) : null);
const view = $("#view");

/* ---------------------------------------------------------------- storage */
const store = {
  get(k, d) { try { const v = localStorage.getItem("pace." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("pace." + k, JSON.stringify(v)); } catch {} },
};
const settings = Object.assign(
  { theme: "light", font: "literata", size: 19, measure: 660, leading: 1.7, showTimer: false, chunk: 1 },
  store.get("settings", {})
);
const FONTS = { literata: '"Literata", Georgia, serif', sourceserif: '"Source Serif 4", Georgia, serif', inter: '"Inter", system-ui, sans-serif' };

function applySettings() {
  const r = document.documentElement;
  r.dataset.theme = settings.theme;
  r.style.setProperty("--read-font", FONTS[settings.font]);
  r.style.setProperty("--read-size", settings.size + "px");
  r.style.setProperty("--read-measure", settings.measure + "px");
  r.style.setProperty("--read-leading", settings.leading);
  store.set("settings", settings);
  $$("[data-setting]").forEach((el) => {
    const k = el.dataset.setting;
    if (el.classList.contains("seg")) $$("button", el).forEach((b) => b.classList.toggle("on", b.dataset.v === settings[k]));
    else if (el.type === "checkbox") el.checked = !!settings[k];
    else el.value = settings[k];
    const out = $(`[data-out="${k}"]`);
    if (out) out.textContent = settings[k];
  });
}
$$("[data-setting]").forEach((el) => {
  const k = el.dataset.setting;
  if (el.classList.contains("seg")) el.addEventListener("click", (e) => { if (e.target.dataset.v) { settings[k] = e.target.dataset.v; applySettings(); } });
  else el.addEventListener("input", () => { settings[k] = el.type === "checkbox" ? el.checked : +el.value; applySettings(); window.dispatchEvent(new Event("pace:layout")); });
});
$("#settingsBtn").addEventListener("click", (e) => { e.stopPropagation(); $("#settingsPanel").hidden = !$("#settingsPanel").hidden; });
document.addEventListener("click", (e) => { if (!e.target.closest("#settingsPanel")) $("#settingsPanel").hidden = true; });
applySettings();

/* ---------------------------------------------------------------- api */
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return res.json();
}
let PASSAGES = null, QUIZ_PROVIDER = null;
async function loadPassages(force) {
  if (!PASSAGES || force) { const d = await api("/api/passages"); PASSAGES = d.passages; QUIZ_PROVIDER = d.quiz_provider; }
  return PASSAGES;
}
async function loadResults() { return (await api("/api/results")).results; }

function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/* ---------------------------------------------------------------- training model */
function model(results) {
  const scored = results.filter((r) => r.total);
  const tests = scored.filter((r) => r.mode === "test");
  const lastN = (arr, n) => arr.slice(-n);
  const avg = (arr, f) => (arr.length ? arr.reduce((s, x) => s + f(x), 0) / arr.length : null);
  const baseline = avg(lastN(tests, 5), (r) => r.wpm);
  const comp = avg(lastN(scored, 5), (r) => r.score / r.total);
  const eff = avg(lastN(scored, 5), (r) => r.effective_wpm);
  const prevBaseline = tests.length > 5 ? avg(tests.slice(-10, -5), (r) => r.wpm) : null;
  const prevEff = scored.length > 5 ? avg(scored.slice(-10, -5), (r) => r.effective_wpm) : null;
  // comfortable pace = fastest recent pace that still kept >= 80% comprehension
  const good = lastN(scored, 10).filter((r) => r.score / r.total >= 0.8).map((r) => r.wpm).sort((a, b) => a - b);
  const comfortable = good.length ? good[Math.floor(good.length * 0.6)] : baseline;
  const base = Math.max(baseline || 0, comfortable || 0) || 250;
  const last = scored[scored.length - 1];
  const lastComp = last ? last.score / last.total : 1;
  const factor = lastComp >= 0.8 ? 1.1 : lastComp >= 0.6 ? 1.0 : 0.92;
  return {
    baseline, comp, eff, prevBaseline, prevEff, sessions: results.length,
    target: round10(base * factor),
    sprint: round10(base * 1.45),
    base: round10(base),
    lastComp, hasData: scored.length > 0,
  };
}

/* ---------------------------------------------------------------- filters */
const filters = Object.assign({ cats: [], kinds: [], length: "any", unread: false, q: "", sort: "new" }, store.get("filters", {}));
function applyFilters(list, f = filters) {
  return list.filter((p) => {
    if (f.cats.length && !p.categories.some((c) => f.cats.includes(c))) return false;
    if (f.kinds.length && !f.kinds.includes(p.kind)) return false;
    if (f.length === "short" && p.words >= 900) return false;
    if (f.length === "medium" && (p.words < 900 || p.words > 1600)) return false;
    if (f.length === "long" && p.words <= 1600) return false;
    if (f.unread && p.reads) return false;
    if (f.q) { const q = f.q.toLowerCase(); if (!(p.title + " " + p.source + " " + (p.author || "")).toLowerCase().includes(q)) return false; }
    return true;
  });
}
function pickRandom(list, { maxWords, minWords } = {}) {
  let pool = list.filter((p) => (QUIZ_PROVIDER || p.has_quiz) && (!maxWords || p.words <= maxWords) && (!minWords || p.words >= minWords));
  const unread = pool.filter((p) => !p.reads);
  if (unread.length) pool = unread;
  if (!pool.length) pool = list;
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ---------------------------------------------------------------- router */
let cleanup = null;
async function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  window.scrollTo(0, 0);
  const [_, page, id] = location.hash.replace(/^#/, "").split("/");
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  $$("nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === (page || "home") || (page === "read" && a.dataset.nav === "library")));
  try {
    if (!page) await renderHome();
    else if (page === "library") await renderLibrary();
    else if (page === "read") await renderRead(id.split("?")[0], params);
    else if (page === "history") await renderHistory();
    else if (page === "add") await renderSources();
    else view.innerHTML = `<div class="empty">Not found.</div>`;
  } catch (e) {
    console.error(e);
    const down = e instanceof TypeError; // fetch() rejects with TypeError when the server is unreachable
    view.innerHTML = down
      ? `<div class="card empty"><b>The Pace server isn't running.</b><br><span class="small">It runs as the LaunchAgent <code>com.haricharank.pace</code>. Restart it with<br><code>launchctl kickstart -k gui/$(id -u)/com.haricharank.pace</code><br>and check <code>~/Library/Logs/pace.log</code> if it won't start.</span><br><br><button class="btn" onclick="location.reload()">Retry</button></div>`
      : `<div class="card empty">Something went wrong: ${esc(e.message)}<br><br><a class="btn" href="#/">Home</a></div>`;
  }
}
window.addEventListener("hashchange", route);

/* ---------------------------------------------------------------- home */
async function renderHome() {
  const [passages, results] = await Promise.all([loadPassages(), loadResults()]);
  const m = model(results);
  const scored = results.filter((r) => r.total);
  const delta = (cur, prev, unit = "") => {
    if (cur == null || prev == null) return "";
    const d = cur - prev; const cls = d >= 0 ? "up" : "down";
    return `<div class="delta ${cls}">${d >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(d))}${unit} vs previous 5</div>`;
  };
  const stat = (label, value, unit, extra = "") =>
    `<div class="stat"><div class="label">${label}</div><div class="value">${value ?? "—"}${value != null && unit ? `<small>${unit}</small>` : ""}</div>${extra}</div>`;

  const shortPick = pickRandom(applyFilters(passages), { maxWords: 1100 });
  const sprintPick = pickRandom(applyFilters(passages), { maxWords: 1300 });
  const testPick = pickRandom(applyFilters(passages), { minWords: 700, maxWords: 1700 });

  view.innerHTML = `
    <div class="hero">
      <div class="card hero-main">
        <div class="eyebrow">Your reading</div>
        <h1>${m.hasData ? "Read faster, keep the meaning." : "Let's find your baseline."}</h1>
        <p class="muted" style="margin:0;max-width:52ch">${m.hasData
          ? "Effective speed = words per minute × comprehension. That is the number to grow; raw speed without understanding doesn't count."
          : "Take one speed test on something you'd enjoy reading anyway. Read the way you normally do, then answer five questions without looking back."}</p>
        <div class="stats">
          ${stat("Reading speed", m.baseline && Math.round(m.baseline), "wpm", delta(m.baseline, m.prevBaseline))}
          ${stat("Comprehension", m.comp != null ? Math.round(m.comp * 100) : null, "%")}
          ${stat("Effective speed", m.eff && Math.round(m.eff), "wpm", delta(m.eff, m.prevEff))}
          ${stat("Sessions", m.sessions || 0, "")}
        </div>
      </div>
      <div class="card next-card">
        <div class="eyebrow" style="color:var(--accent);font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase">Today's session</div>
        ${m.hasData ? `
          <div class="target">${m.target}<small> wpm target</small></div>
          <div class="muted small">${m.lastComp >= 0.8 ? "Last comprehension was strong, so the target is 10% higher." : m.lastComp >= 0.6 ? "Holding pace until comprehension is consistently at 80% or above." : "Comprehension dipped, so the target eases off a little."}</div>
          <div class="grid" style="gap:8px;margin-top:4px">
            ${shortPick ? `<a class="btn" href="#/read/${shortPick.id}?mode=pacer&wpm=${m.target}">1 · Pacer warm-up at ${m.target}</a>` : ""}
            ${sprintPick ? `<a class="btn" href="#/read/${sprintPick.id}?mode=rsvp&wpm=${m.sprint}">2 · Overspeed sprint at ${m.sprint}</a>` : ""}
            ${testPick ? `<a class="btn primary" href="#/read/${testPick.id}?mode=test">3 · Free-reading test</a>` : ""}
          </div>
          <div class="faint small">Overspeed drills stretch your eyes past your comfort zone; the free test then checks whether your normal pace moved.</div>
        ` : `
          <div class="target">~250<small> wpm typical</small></div>
          <div class="muted small">Most adults read 200–300 wpm with good comprehension. Skilled readers sustain 400+.</div>
          ${testPick ? `<a class="btn primary big" href="#/read/${testPick.id}?mode=test">Take a speed test</a>` : ""}
          <a class="btn ghost" href="#/library">Or choose from the library →</a>
        `}
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h2>Progress</h2><span class="faint small">${scored.length} scored sessions</span></div>
      ${scored.length >= 1 ? `
        <div class="card">
          <div class="row" style="margin-bottom:10px"><h3>Speed</h3><div class="spacer"></div>
            <div class="legend"><span><i style="background:var(--s1)"></i>Reading speed</span><span><i style="background:var(--s2)"></i>Effective speed</span></div></div>
          <div class="chart-wrap" id="speedChart"></div>
          <div class="row" style="margin:22px 0 10px"><h3>Comprehension</h3></div>
          <div class="chart-wrap" id="compChart"></div>
        </div>
        <div class="two-col section" style="margin-top:16px">
          <div class="card"><h3 style="margin-bottom:12px">Effective speed by topic</h3><div class="cat-bars" id="catBars"></div></div>
          <div class="card"><h3 style="margin-bottom:12px">By mode</h3><div class="cat-bars" id="modeBars"></div></div>
        </div>` : `<div class="card empty">Your charts appear after your first quiz.</div>`}
    </div>`;

  if (scored.length) {
    lineChart($("#speedChart"), scored, [
      { key: "wpm", label: "Reading speed", color: "var(--s1)" },
      { key: "effective_wpm", label: "Effective speed", color: "var(--s2)" },
    ]);
    barChart($("#compChart"), scored);
    groupBars($("#catBars"), scored, (r) => r.categories || [], (k) => k);
    groupBars($("#modeBars"), scored, (r) => [r.mode], (k) => MODES[k]?.name || k);
  }
}

function groupBars(el, rows, keysOf, labelOf) {
  const g = {};
  rows.forEach((r) => keysOf(r).forEach((k) => { (g[k] ||= []).push(r.effective_wpm); }));
  const items = Object.entries(g).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length, v.length]).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...items.map((i) => i[1]), 1);
  el.innerHTML = items.map(([k, v, n]) => `
    <div class="cat-row"><span>${esc(labelOf(k))} <span class="faint small">· ${n}</span></span>
    <div class="bar"><div style="width:${(100 * v) / max}%"></div></div><span class="num">${Math.round(v)}</span></div>`).join("") || `<div class="faint">No data yet.</div>`;
}

/* ---------------------------------------------------------------- charts (inline SVG) */
function chartFrame(el, n, height) {
  const W = Math.max(el.clientWidth, 300), H = height, pad = { l: 40, r: 90, t: 10, b: 24 };
  const x = (i) => pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1));
  return { W, H, pad, x };
}
function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); return Math.ceil(v / p) * p; }

function lineChart(el, rows, series) {
  const n = rows.length; const { W, H, pad, x } = chartFrame(el, n, 220);
  const maxV = niceMax(Math.max(...rows.flatMap((r) => series.map((s) => r[s.key] || 0)), 100));
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / maxV);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxV * f));
  let svg = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Reading speed over sessions">`;
  ticks.forEach((t) => { svg += `<line class="gridline" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis-label" x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`; });
  const step = Math.max(1, Math.ceil(n / 8));
  rows.forEach((r, i) => { if (i % step === 0 || i === n - 1) svg += `<text class="axis-label" x="${x(i)}" y="${H - 6}" text-anchor="middle">${fmtDate(r.ts)}</text>`; });
  const ends = series.map((s) => y(rows[n - 1][s.key] || 0));
  if (ends.length === 2 && Math.abs(ends[0] - ends[1]) < 14) { const mid = (ends[0] + ends[1]) / 2; const up = ends[0] <= ends[1] ? 0 : 1; ends[up] = mid - 7; ends[1 - up] = mid + 7; }
  series.forEach((s, si) => {
    const pts = rows.map((r, i) => [x(i), y(r[s.key] || 0)]);
    svg += `<path d="M${pts.map((p) => p.join(",")).join("L")}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    pts.forEach(([px, py]) => { svg += `<circle cx="${px}" cy="${py}" r="${n > 30 ? 2.5 : 4}" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`; });
    const last = pts[pts.length - 1];
    svg += `<text x="${last[0] + 10}" y="${ends[si] + 4}" font-size="12" fill="var(--ink-2)" font-family="var(--ui)">${Math.round(rows[n - 1][s.key])} ${s.key === "wpm" ? "wpm" : "eff."}</text>`;
  });
  svg += `<line id="xhair" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--ink-3)" stroke-dasharray="3 3" visibility="hidden"/>`;
  svg += `<rect x="${pad.l - 10}" y="0" width="${W - pad.l - pad.r + 20}" height="${H}" fill="transparent" id="hit"/></svg>`;
  el.innerHTML = svg + `<div class="chart-tip" hidden></div>`;
  hover(el, rows, x, (r) => `
    <div class="t">${esc(r.title || "Deleted passage")}</div>
    <div class="faint small">${fmtDate(r.ts)} · ${MODES[r.mode]?.name || r.mode}</div>
    <div><i style="display:inline-block;width:10px;height:3px;background:var(--s1);vertical-align:middle;margin-right:6px"></i>${Math.round(r.wpm)} wpm</div>
    <div><i style="display:inline-block;width:10px;height:3px;background:var(--s2);vertical-align:middle;margin-right:6px"></i>${Math.round(r.effective_wpm)} effective</div>
    <div class="faint small">${r.score}/${r.total} correct</div>`);
}

function barChart(el, rows) {
  const n = rows.length; const { W, H, pad, x } = chartFrame(el, n, 110);
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / 100);
  const bw = Math.max(4, Math.min(22, ((W - pad.l - pad.r) / Math.max(n, 1)) * 0.6));
  let svg = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Comprehension per session">`;
  [0, 50, 100].forEach((t) => { svg += `<line class="gridline" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis-label" x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${t}%</text>`; });
  svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(80)}" y2="${y(80)}" stroke="var(--ink-3)" stroke-dasharray="2 4"/><text class="axis-label" x="${W - pad.r + bw / 2 + 8}" y="${y(80) + 4}">80% goal</text>`;
  rows.forEach((r, i) => {
    const v = pct(r); const top = y(v), h = Math.max(y(0) - top, 2);
    svg += `<path d="M${x(i) - bw / 2},${y(0)} V${top + 4} q0,-4 4,-4 H${x(i) + bw / 2 - 4} q4,0 4,4 V${y(0)} Z" fill="var(--s3)" opacity="${v >= 80 ? 1 : 0.55}"/>`;
  });
  svg += `<line id="xhair" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--ink-3)" stroke-dasharray="3 3" visibility="hidden"/>`;
  svg += `<rect x="${pad.l - 10}" y="0" width="${W - pad.l - pad.r + 20}" height="${H}" fill="transparent" id="hit"/></svg>`;
  el.innerHTML = svg + `<div class="chart-tip" hidden></div>`;
  hover(el, rows, x, (r) => `<div class="t">${esc(r.title || "")}</div><div>${pct(r)}% comprehension (${r.score}/${r.total})</div><div class="faint small">${fmtDate(r.ts)} · ${Math.round(r.wpm)} wpm</div>`);
}

function hover(el, rows, x, html) {
  const svg = $("svg", el), tip = $(".chart-tip", el), xh = $("#xhair", el);
  const onMove = (e) => {
    const rect = svg.getBoundingClientRect(); const scale = svg.viewBox.baseVal.width / rect.width;
    const mx = (e.clientX - rect.left) * scale;
    let best = 0, bd = Infinity; rows.forEach((_, i) => { const d = Math.abs(x(i) - mx); if (d < bd) { bd = d; best = i; } });
    xh.setAttribute("x1", x(best)); xh.setAttribute("x2", x(best)); xh.setAttribute("visibility", "visible");
    tip.innerHTML = html(rows[best]); tip.hidden = false;
    const px = x(best) / scale; const left = px + 14 + tip.offsetWidth > rect.width ? px - tip.offsetWidth - 14 : px + 14;
    tip.style.left = left + "px"; tip.style.top = "6px";
  };
  $("#hit", el).addEventListener("mousemove", onMove);
  $("#hit", el).addEventListener("mouseleave", () => { tip.hidden = true; xh.setAttribute("visibility", "hidden"); });
}

/* ---------------------------------------------------------------- library */
async function renderLibrary() {
  const passages = await loadPassages();
  const results = await loadResults();
  const m = model(results);
  const pace = m.baseline || 250;
  const chips = (key, values, labels) => values.map((v) => `<button class="chip ${filters[key].includes(v) ? "on" : ""}" data-f="${key}" data-v="${v}">${labels ? labels[v] : v}</button>`).join("");
  view.innerHTML = `
    <div class="row"><h1>Library</h1><div class="spacer"></div>
      <input type="text" class="search" id="q" placeholder="Search titles, sources…" value="${esc(filters.q)}">
      <button class="btn primary" id="surprise">Surprise me</button></div>
    <div class="filters">
      <div class="row"><span class="flabel">Topic</span>${chips("cats", CATS)}</div>
      <div class="row"><span class="flabel">Type</span>${chips("kinds", Object.keys(KINDS), KINDS)}</div>
      <div class="row"><span class="flabel">Length</span>
        <div class="seg" id="len">${Object.entries(LENGTHS).map(([k, v]) => `<button data-v="${k}" class="${filters.length === k ? "on" : ""}">${v}</button>`).join("")}</div>
        <label class="row small muted" style="gap:6px;margin-left:12px"><input type="checkbox" class="switch" id="unread" ${filters.unread ? "checked" : ""}> Unread only</label>
        <div class="spacer"></div>
        <select id="sort" style="width:auto"><option value="new">Newest</option><option value="short">Shortest</option><option value="long">Longest</option><option value="easy">Easiest</option></select>
      </div>
    </div>
    <div class="faint small" id="count" style="margin-bottom:10px"></div>
    <div class="lib-grid" id="grid"></div>`;
  $("#sort").value = filters.sort;

  const draw = () => {
    store.set("filters", filters);
    let list = applyFilters(passages);
    const when = (p) => Date.parse(p.published) || p.fetched_at * 1000;
    const sorters = { new: (a, b) => when(b) - when(a), short: (a, b) => a.words - b.words, long: (a, b) => b.words - a.words, easy: (a, b) => (b.flesch || 0) - (a.flesch || 0) };
    list = list.slice().sort(sorters[filters.sort] || sorters.new);
    $("#count").textContent = `${list.length} passages · times estimated at ${Math.round(pace)} wpm`;
    $("#grid").innerHTML = list.map((p) => card(p, pace)).join("") || `<div class="card empty">Nothing matches. Loosen the filters.</div>`;
  };
  view.addEventListener("click", (e) => {
    const c = e.target.closest("[data-f]");
    if (c) { const arr = filters[c.dataset.f]; const i = arr.indexOf(c.dataset.v); i >= 0 ? arr.splice(i, 1) : arr.push(c.dataset.v); c.classList.toggle("on"); draw(); }
    const l = e.target.closest("#len button");
    if (l) { filters.length = l.dataset.v; $$("#len button").forEach((b) => b.classList.toggle("on", b === l)); draw(); }
    const pc = e.target.closest(".pcard");
    if (pc) location.hash = `#/read/${pc.dataset.id}`;
  });
  $("#q").addEventListener("input", (e) => { filters.q = e.target.value; draw(); });
  $("#unread").addEventListener("change", (e) => { filters.unread = e.target.checked; draw(); });
  $("#sort").addEventListener("change", (e) => { filters.sort = e.target.value; draw(); });
  $("#surprise").addEventListener("click", () => { const p = pickRandom(applyFilters(passages)); if (p) location.hash = `#/read/${p.id}`; });
  draw();
}

function card(p, pace) {
  const mins = Math.max(1, Math.round(p.words / pace));
  const ease = p.flesch == null ? "" : p.flesch >= 65 ? "Easy" : p.flesch >= 50 ? "Moderate" : "Dense";
  return `<div class="card pcard" data-id="${p.id}">
    <div class="src">${esc(p.source)}${p.published ? " · " + esc(String(p.published).slice(0, 16)) : ""}</div>
    <h3>${esc(p.title)}</h3>
    <div class="meta">
      <span class="tag kind">${KINDS[p.kind] ? KINDS[p.kind].replace(/s$/, "") : esc(p.kind)}</span>
      ${p.categories.map((c) => `<span class="tag">${esc(c)}</span>`).join("")}
      <span class="spacer"></span>
      ${p.reads ? `<span class="read-badge">✓ read</span>` : ""}
      <span>${p.words.toLocaleString()} w · ~${mins} min${ease ? " · " + ease : ""}${p.has_quiz ? "" : QUIZ_PROVIDER ? "" : " · no quiz"}</span>
    </div></div>`;
}

/* ---------------------------------------------------------------- reader */
function proseHTML(text, wrapWords) {
  let idx = 0;
  const wrap = (s) => (wrapWords ? s.split(/(\s+)/).map((t) => (/\S/.test(t) ? `<span class="w" data-i="${idx++}">${esc(t)}</span>` : t)).join("") : esc(s));
  return text.split(/\n\n+/).map((para) => (para.startsWith("## ") ? `<h3>${wrap(para.slice(3))}</h3>` : `<p>${wrap(para)}</p>`)).join("");
}

async function renderRead(id, params) {
  const [p, results] = await Promise.all([api(`/api/passages/${id}`), loadResults()]);
  await loadPassages();
  const m = model(results);
  let mode = params.get("mode") || "test";
  let wpm = +params.get("wpm") || (mode === "rsvp" ? m.sprint : m.target);
  const quizPromise = api(`/api/passages/${id}/quiz`).catch((e) => ({ error: e.message }));

  const intro = () => {
    view.innerHTML = `<div class="reader-shell"><div class="card intro">
      <div class="src">${esc(p.source)}${p.author ? " · " + esc(p.author) : ""}</div>
      <h1>${esc(p.title)}</h1>
      <div class="row small muted">
        <span class="tag kind">${esc(KINDS[p.kind] || p.kind)}</span>${p.categories.map((c) => `<span class="tag">${esc(c)}</span>`).join("")}
        <span>${p.words.toLocaleString()} words</span>${p.flesch != null ? `<span>· readability ${Math.round(p.flesch)}</span>` : ""}
        ${p.url ? `<a class="faint" href="${esc(p.url)}" target="_blank" rel="noopener">source ↗</a>` : ""}
      </div>
      <div class="mode-grid">${Object.entries(MODES).map(([k, v]) => `<button class="mode ${k === mode ? "on" : ""}" data-mode="${k}"><b>${v.name}</b><span>${v.desc}</span></button>`).join("")}</div>
      <div class="wpm-row" id="wpmRow" ${mode === "test" ? "hidden" : ""}>
        <span class="muted small">Pace</span><input type="range" min="100" max="1000" step="10" id="wpm" value="${wpm}"><span class="wpm-val"><span id="wpmv">${wpm}</span> <span class="faint small">wpm</span></span>
      </div>
      <div class="row" id="chunkRow" ${mode === "rsvp" ? "" : "hidden"} style="margin:-8px 0 18px"><span class="muted small">Words per flash</span>
        <div class="seg" id="chunk">${[1, 2, 3].map((c) => `<button data-v="${c}" class="${settings.chunk === c ? "on" : ""}">${c}</button>`).join("")}</div></div>
      <div class="row"><button class="btn primary big" id="begin">Begin</button><span class="faint small"><kbd>Enter</kbd> to start${mode === "test" ? " · <kbd>Enter</kbd> again when you finish" : " · <kbd>Space</kbd> pause · <kbd>↑</kbd><kbd>↓</kbd> speed"}</span>
        <div class="spacer"></div><button class="btn ghost small" id="hide" title="Hide this passage from the library">Hide passage</button></div>
      <p class="faint small" id="quizNote" style="margin:16px 0 0"></p>
    </div></div>`;
    quizPromise.then((q) => { const n = $("#quizNote"); if (n) n.textContent = q.error ? `Quiz: ${q.error}` : `${q.questions.length}-question quiz afterwards · don't scroll back during it.`; });
    $$(".mode").forEach((b) => b.addEventListener("click", () => {
      mode = b.dataset.mode; if (mode === "rsvp" && wpm < m.sprint && !params.get("wpm")) wpm = m.sprint;
      history.replaceState(null, "", `#/read/${id}?mode=${mode}${mode !== "test" ? "&wpm=" + wpm : ""}`); intro();
    }));
    $("#wpm").addEventListener("input", (e) => { wpm = +e.target.value; $("#wpmv").textContent = wpm; });
    $$("#chunk button").forEach((b) => b.addEventListener("click", () => { settings.chunk = +b.dataset.v; applySettings(); $$("#chunk button").forEach((x) => x.classList.toggle("on", x === b)); }));
    $("#begin").addEventListener("click", start);
    $("#hide").addEventListener("click", async () => { await api(`/api/passages/${id}/hide`, { method: "POST" }); PASSAGES = null; toast("Hidden from library"); location.hash = "#/library"; });
  };
  const onKey = (e) => { if (e.key === "Enter" && $("#begin")) { e.preventDefault(); start(); } };
  document.addEventListener("keydown", onKey);
  cleanup = () => document.removeEventListener("keydown", onKey);

  const start = () => {
    document.removeEventListener("keydown", onKey);
    const finish = (seconds, extra = {}) => runQuiz(p, quizPromise, { mode, seconds, target: mode === "test" ? null : wpm, ...extra });
    if (mode === "test") readTest(p, finish);
    else if (mode === "pacer") readPacer(p, wpm, finish);
    else readRSVP(p, wpm, finish);
  };
  intro();
}

/* active-time stopwatch that pauses when the tab is hidden */
function stopwatch() {
  let acc = 0, since = performance.now(), running = true;
  const vis = () => { if (document.hidden && running) { acc += performance.now() - since; running = false; } else if (!document.hidden && !running && !paused) { since = performance.now(); running = true; } };
  let paused = false;
  document.addEventListener("visibilitychange", vis);
  return {
    get: () => (acc + (running ? performance.now() - since : 0)) / 1000,
    pause() { if (running) { acc += performance.now() - since; running = false; } paused = true; },
    resume() { paused = false; if (!running && !document.hidden) { since = performance.now(); running = true; } },
    stop() { this.pause(); document.removeEventListener("visibilitychange", vis); return acc / 1000; },
  };
}

function readingChrome(p, label) {
  view.innerHTML = `<div class="reader-shell">
    <div class="reading-bar"><span>${label}</span><div class="progress"><div id="prog"></div></div>
      <span class="timer" id="timer" ${settings.showTimer ? "" : "hidden"}>0:00</span>
      <button class="btn ghost small" id="abort">Quit</button></div>
    <article class="prose" id="prose"><h1>${esc(p.title)}</h1>${proseHTML(p.text, label !== "Speed test")}</article>
  </div>`;
  $("#abort").addEventListener("click", () => { location.hash = "#/library"; });
}

function readTest(p, finish) {
  readingChrome(p, "Speed test");
  view.insertAdjacentHTML("beforeend", `<div class="done-dock"><button class="btn primary big" id="done">I'm done · <kbd style="background:transparent;color:inherit;border-color:currentColor">Enter</kbd></button></div>`);
  const sw = stopwatch();
  const tick = setInterval(() => {
    $("#timer").textContent = fmtTime(sw.get());
    const h = document.documentElement; const f = h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight);
    $("#prog").style.width = Math.min(100, f * 100) + "%";
  }, 250);
  const end = () => { const s = sw.stop(); stopAll(); finish(s); };
  const onKey = (e) => { if (e.key === "Enter") { e.preventDefault(); end(); } };
  const stopAll = () => { clearInterval(tick); document.removeEventListener("keydown", onKey); cleanup = null; };
  document.addEventListener("keydown", onKey);
  $("#done").addEventListener("click", end);
  cleanup = () => { sw.stop(); stopAll(); };
}

function readPacer(p, wpm, finish) {
  readingChrome(p, "Pacer drill");
  const prose = $("#prose"); prose.classList.add("dim");
  const band = document.createElement("div"); band.className = "pacer-band"; prose.appendChild(band);
  const words = $$(".w", prose);
  let lines = [];
  const layout = () => {
    lines = []; let cur = null;
    words.forEach((w) => {
      const top = w.offsetTop;
      if (!cur || Math.abs(top - cur.top) > 4) { cur = { top, h: w.offsetHeight, words: [] }; lines.push(cur); }
      cur.words.push(w);
    });
  };
  layout();
  let li = 0, timer = null, paused = false;
  const sw = stopwatch();
  const bar = $(".reading-bar");
  bar.insertAdjacentHTML("afterbegin", `<span class="timer"><span id="pw">${wpm}</span> wpm</span>`);
  const show = () => {
    const L = lines[li]; if (!L) return;
    band.style.top = L.top - 3 + "px"; band.style.height = L.h + 6 + "px";
    $$(".w.lit", prose).forEach((w) => w.classList.remove("lit"));
    L.words.forEach((w) => w.classList.add("lit"));
    const r = L.words[0].getBoundingClientRect(); const want = window.innerHeight * 0.38;
    if (Math.abs(r.top - want) > 40) window.scrollBy({ top: r.top - want, behavior: "smooth" });
    $("#prog").style.width = (100 * li) / lines.length + "%";
  };
  const step = () => {
    if (paused) return;
    show();
    const L = lines[li]; if (!L) return done();
    timer = setTimeout(() => { li++; if (li >= lines.length) done(); else step(); }, (L.words.length / wpm) * 60000);
  };
  const done = () => { clearTimeout(timer); const s = sw.stop(); stopAll(); finish(s, { pacedWpm: wpm }); };
  const onKey = (e) => {
    if (e.key === " ") { e.preventDefault(); paused = !paused; if (paused) { clearTimeout(timer); sw.pause(); } else { sw.resume(); step(); } }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); wpm = Math.max(80, Math.min(1200, wpm + (e.key === "ArrowUp" ? 20 : -20))); $("#pw").textContent = wpm; }
    if (e.key === "Enter") { e.preventDefault(); done(); }
  };
  const relayout = () => { layout(); show(); };
  window.addEventListener("pace:layout", relayout); window.addEventListener("resize", relayout);
  const stopAll = () => { clearTimeout(timer); document.removeEventListener("keydown", onKey); window.removeEventListener("pace:layout", relayout); window.removeEventListener("resize", relayout); cleanup = null; };
  document.addEventListener("keydown", onKey);
  cleanup = () => { sw.stop(); stopAll(); };
  setTimeout(step, 600);
}

function orpIndex(w) { const n = w.replace(/[^\w]/g, "").length; return n <= 1 ? 0 : n <= 5 ? 1 : n <= 9 ? 2 : n <= 13 ? 3 : 4; }

function readRSVP(p, wpm, finish) {
  const paras = p.text.split(/\n\n+/).map((x) => x.replace(/^## /, ""));
  const tokens = [];
  paras.forEach((para) => { const ws = para.split(/\s+/).filter(Boolean); ws.forEach((w, i) => tokens.push({ w, end: i === ws.length - 1 })); });
  const chunks = []; const n = settings.chunk || 1;
  for (let i = 0; i < tokens.length;) {
    const c = [tokens[i++]];
    while (c.length < n && i < tokens.length && !/[.!?;:]$/.test(c[c.length - 1].w) && !c[c.length - 1].end) c.push(tokens[i++]);
    chunks.push({ text: c.map((t) => t.w).join(" "), words: c.length, last: c[c.length - 1] });
  }
  view.innerHTML = `<div class="reader-shell">
    <div class="reading-bar"><span>Flash · <span id="pw">${wpm}</span> wpm</span><div class="progress"><div id="prog"></div></div>
      <span class="timer" id="timer" ${settings.showTimer ? "" : "hidden"}>0:00</span><button class="btn ghost small" id="abort">Quit</button></div>
    <div class="rsvp-stage">
      <div class="rsvp-box"><div class="rsvp-word" id="word"></div></div>
      <div class="rsvp-context" id="ctx"></div>
      <div class="rsvp-controls"><kbd>Space</kbd> pause <kbd>←</kbd><kbd>→</kbd> sentence <kbd>↑</kbd><kbd>↓</kbd> speed <kbd>Enter</kbd> finish</div>
    </div></div>`;
  $("#abort").addEventListener("click", () => { location.hash = "#/library"; });
  const wordEl = $("#word");
  let i = 0, timer = null, paused = false;
  const sw = stopwatch();
  const render = (c) => {
    const first = c.text.split(" ")[0]; const k = orpIndex(first);
    const rest = c.text.slice(first.length);
    wordEl.innerHTML = `<span id="pre">${esc(first.slice(0, k))}</span><span class="orp" id="orp">${esc(first[k] || "")}</span>${esc(first.slice(k + 1) + rest)}`;
    const shift = $("#pre").offsetWidth + $("#orp").offsetWidth / 2;
    wordEl.style.transform = `translateX(${-shift}px)`;
  };
  const delay = (c) => {
    let f = 1;
    if (/[.!?]["”’)]?$/.test(c.last.w)) f += 1.1; else if (/[,;:—–]$/.test(c.last.w)) f += 0.45;
    if (c.last.end) f += 0.8;
    if (c.text.length > 12 * c.words) f += 0.25;
    return ((c.words * 60000) / wpm) * f / 1.25; // normalise so the average pace stays near the set wpm
  };
  const sentenceAround = (idx) => {
    let s = idx, e = idx;
    while (s > 0 && !/[.!?]["”’)]?$/.test(chunks[s - 1].text)) s--;
    while (e < chunks.length - 1 && !/[.!?]["”’)]?$/.test(chunks[e].text)) e++;
    return chunks.slice(s, e + 1).map((c) => c.text).join(" ");
  };
  const tick = setInterval(() => { $("#timer").textContent = fmtTime(sw.get()); }, 250);
  const step = () => {
    if (paused) return;
    if (i >= chunks.length) return done();
    render(chunks[i]); $("#prog").style.width = (100 * i) / chunks.length + "%"; $("#ctx").textContent = "";
    timer = setTimeout(() => { i++; step(); }, delay(chunks[i]));
  };
  const jump = (dir) => {
    clearTimeout(timer);
    if (dir < 0) { i = Math.max(0, i - 1); while (i > 0 && !/[.!?]["”’)]?$/.test(chunks[i - 1].text)) i--; }
    else { while (i < chunks.length - 1 && !/[.!?]["”’)]?$/.test(chunks[i].text)) i++; i++; }
    if (paused) { render(chunks[Math.min(i, chunks.length - 1)]); $("#ctx").textContent = sentenceAround(i); } else step();
  };
  const done = () => { clearTimeout(timer); const s = sw.stop(); stopAll(); finish(s, { pacedWpm: wpm }); };
  const onKey = (e) => {
    if (e.key === " ") { e.preventDefault(); paused = !paused; if (paused) { clearTimeout(timer); sw.pause(); $("#ctx").textContent = sentenceAround(i); } else { sw.resume(); step(); } }
    else if (e.key === "ArrowLeft") { e.preventDefault(); jump(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); jump(1); }
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); wpm = Math.max(100, Math.min(1500, wpm + (e.key === "ArrowUp" ? 25 : -25))); $("#pw").textContent = wpm; }
    else if (e.key === "Enter") { e.preventDefault(); done(); }
  };
  const stopAll = () => { clearTimeout(timer); clearInterval(tick); document.removeEventListener("keydown", onKey); cleanup = null; };
  document.addEventListener("keydown", onKey);
  cleanup = () => { sw.stop(); stopAll(); };
  wordEl.innerHTML = `<span class="faint">Get ready…</span>`; wordEl.style.transform = "translateX(-50%)";
  setTimeout(step, 1200);
}

/* ---------------------------------------------------------------- quiz + results */
async function runQuiz(p, quizPromise, run) {
  window.scrollTo(0, 0);
  view.innerHTML = `<div class="quiz"><div class="card empty">Loading quiz…</div></div>`;
  const quiz = await quizPromise;
  if (quiz.error) {
    view.innerHTML = `<div class="quiz"><div class="card" style="padding:28px">
      <h2>No quiz available</h2><p class="muted">${esc(quiz.error)}</p>
      <p>Speed only: <b>${Math.round((p.words / run.seconds) * 60)} wpm</b> in ${fmtTime(run.seconds)}.</p>
      <div class="row"><button class="btn primary" id="save">Save speed only</button><a class="btn" href="#/library">Library</a></div></div></div>`;
    $("#save").addEventListener("click", async () => { await api("/api/results", { method: "POST", body: { passage_id: p.id, mode: run.mode, words: p.words, seconds: run.seconds, target_wpm: run.target } }); PASSAGES = null; location.hash = "#/history"; });
    return;
  }
  const qs = quiz.questions; const picks = [];
  let qi = 0;
  const answered = (i) => picks[i] !== undefined;
  const draw = () => {
    if (qi === qs.length) return drawSubmit();
    const q = qs[qi];
    view.innerHTML = `<div class="quiz">
      <div class="quiz-head"><div class="dots">${qs.map((_, i) => `<i data-q="${i}" title="Question ${i + 1}" class="${i === qi ? "cur" : answered(i) ? "done" : ""}"></i>`).join("")}</div>
        <span>Question ${qi + 1} of ${qs.length}</span><div class="spacer"></div><span class="faint">from memory, no peeking</span></div>
      <div class="qtype">${esc((q.type || "").replace("_", " "))}</div>
      <div class="question">${esc(q.q)}</div>
      <div class="options">${q.options.map((o, i) => `<button class="opt ${picks[qi] === i ? "picked" : ""}" data-i="${i}"><span class="k">${"ABCD"[i]}</span><span>${esc(o)}</span></button>`).join("")}</div>
      <div class="row" style="margin-top:18px">
        <button class="btn ghost small" id="prev" ${qi === 0 ? "disabled" : ""}>← Back</button>
        <span class="faint small"><kbd>1</kbd>–<kbd>4</kbd> answer · <kbd>←</kbd><kbd>→</kbd> move</span>
        <div class="spacer"></div>
        <button class="btn ghost small" id="idk">${picks[qi] === -1 ? "Skipped ✓" : "Not sure, skip"}</button>
        ${canGo(qi + 1) ? `<button class="btn small" id="fwd">Next →</button>` : ""}
      </div>
    </div>`;
    $$(".opt").forEach((b) => b.addEventListener("click", () => pick(+b.dataset.i)));
    $("#idk").addEventListener("click", () => pick(-1));
    $("#prev").addEventListener("click", () => go(qi - 1));
    $("#fwd")?.addEventListener("click", () => go(qi + 1));
    $$(".dots i").forEach((d) => { if (canGo(+d.dataset.q)) { d.style.cursor = "pointer"; d.addEventListener("click", () => go(+d.dataset.q)); } });
  };
  const drawSubmit = () => {
    view.innerHTML = `<div class="quiz">
      <div class="quiz-head"><div class="dots">${qs.map((_, i) => `<i data-q="${i}" class="done" style="cursor:pointer"></i>`).join("")}</div>
        <span>All ${qs.length} answered</span></div>
      <div class="question">Ready to submit?</div>
      <div class="options">${qs.map((q, i) => `<button class="opt" data-q="${i}"><span class="k">${i + 1}</span><span><span class="faint small">${esc(q.q)}</span><br>${picks[i] === -1 ? "<i>Skipped</i>" : esc(q.options[picks[i]])}</span></button>`).join("")}</div>
      <div class="row" style="margin-top:18px">
        <button class="btn ghost small" id="prev">← Back</button><span class="faint small">Click an answer to change it</span>
        <div class="spacer"></div><button class="btn primary" id="submit">Submit answers · <kbd style="background:transparent;color:inherit;border-color:currentColor">Enter</kbd></button></div>
    </div>`;
    $$("[data-q]").forEach((el) => el.addEventListener("click", () => go(+el.dataset.q)));
    $("#prev").addEventListener("click", () => go(qs.length - 1));
    $("#submit").addEventListener("click", finishQuiz);
  };
  const allDone = () => qs.every((_, k) => answered(k));
  // Revisit any answered question, move to the first unanswered one, or (once all are answered) the submit screen.
  const canGo = (i) => i !== qi && ((i >= 0 && i < qs.length && (answered(i) || i === qs.findIndex((_, k) => !answered(k)))) || (i === qs.length && allDone()));
  const go = (i) => { if (!locked && canGo(i)) { qi = i; draw(); } };
  let locked = false;
  const pick = (i) => {
    if (locked) return; locked = true;
    $$(".opt").forEach((b) => b.classList.toggle("picked", +b.dataset.i === i));
    picks[qi] = i;
    setTimeout(() => {
      locked = false;
      const next = qs.findIndex((_, k) => k > qi && !answered(k));
      const open = qs.findIndex((_, k) => !answered(k));
      if (next >= 0) qi = next;
      else if (open >= 0) qi = open; // an earlier question is still unanswered
      else qi = qs.length;           // all answered: review + submit screen
      draw();
    }, 260);
  };
  const onKey = (e) => {
    if (qi === qs.length && e.key === "Enter") { e.preventDefault(); finishQuiz(); return; }
    if (e.key === "ArrowLeft" || e.key === "Backspace") { e.preventDefault(); go(qi - 1); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); go(qi + 1); return; }
    const k = e.key.toLowerCase(); const map = { 1: 0, 2: 1, 3: 2, 4: 3, a: 0, b: 1, c: 2, d: 3 };
    if (k in map) pick(map[k]);
  };
  document.addEventListener("keydown", onKey);
  cleanup = () => document.removeEventListener("keydown", onKey);
  let submitted = false;
  const finishQuiz = async () => {
    if (submitted) return; submitted = true;
    document.removeEventListener("keydown", onKey); cleanup = null;
    const score = qs.reduce((s, q, i) => s + (picks[i] === q.answer ? 1 : 0), 0);
    const before = model(await loadResults());
    const saved = await api("/api/results", { method: "POST", body: {
      passage_id: p.id, mode: run.mode, words: p.words, seconds: run.seconds, target_wpm: run.target, score, total: qs.length, answers: picks } });
    PASSAGES = null;
    showResult(p, run, qs, picks, score, saved, before);
  };
  draw();
}

function showResult(p, run, qs, picks, score, saved, before) {
  const comp = score / qs.length;
  const verdict = comp >= 0.8
    ? (run.mode === "test" ? "Strong retention. Your next target goes up 10%." : "You kept the meaning at this pace, so it's ready to become your normal speed.")
    : comp >= 0.6 ? "Decent. Hold this pace until you're scoring 80% or better."
    : run.mode === "rsvp" ? "Low retention is normal in overspeed sprints. They train the eyes; your free-reading tests show whether it carries over."
    : "Too fast to retain much. Ease off and focus on the main thread of the argument.";
  const vs = before.baseline ? Math.round(saved.wpm - before.baseline) : null;
  view.innerHTML = `<div class="quiz" style="max-width:760px">
    <div class="faint small">${esc(MODES[run.mode].name)} · ${esc(p.title)}</div>
    <div class="result-hero">
      <div class="card"><div class="big">${Math.round(saved.wpm)}</div><div class="lbl">words per minute${vs != null && run.mode === "test" ? ` · <span class="${vs >= 0 ? "delta up" : "delta down"}">${vs >= 0 ? "+" : ""}${vs} vs avg</span>` : ""}</div></div>
      <div class="card"><div class="big">${Math.round(comp * 100)}<span style="font-size:22px">%</span></div><div class="lbl">comprehension · ${score}/${qs.length}</div></div>
      <div class="card"><div class="big" style="color:var(--accent)">${Math.round(saved.effective_wpm)}</div><div class="lbl">effective wpm</div></div>
    </div>
    ${saved.wpm > 1200 && run.mode === "test" ? `<p class="card" style="border-color:var(--bad);color:var(--bad)">${Math.round(saved.wpm)} wpm is faster than skimming. If you hit “done” by accident, discard this session so it doesn't skew your stats.</p>` : ""}
    <p class="verdict">${verdict}</p>
    <p class="faint small">${p.words.toLocaleString()} words in ${fmtTime(run.seconds)}${run.target ? ` · paced at ${run.pacedWpm || run.target} wpm` : ""}</p>
    <div class="row" style="margin:16px 0 8px">
      <button class="btn primary" id="next">Next passage</button>
      ${run.mode !== "test" ? `<a class="btn" href="#/read/${p.id}?mode=${run.mode}&wpm=${round10((run.pacedWpm || run.target) * (comp >= 0.8 ? 1.1 : 0.95))}">Retry at ${round10((run.pacedWpm || run.target) * (comp >= 0.8 ? 1.1 : 0.95))} wpm</a>` : ""}
      <a class="btn ghost" href="#/">Progress</a>
      <div class="spacer"></div>
      <button class="btn ghost small" id="discard">Discard this session</button>
    </div>
    <h2 style="margin-top:28px">Review</h2>
    <div class="review">${qs.map((q, i) => `
      <div class="card item"><div class="q">${i + 1}. ${esc(q.q)}</div>
        ${picks[i] !== q.answer && picks[i] >= 0 ? `<div class="a wrong">${esc(q.options[picks[i]])}</div>` : ""}
        ${picks[i] === -1 ? `<div class="a wrong" style="text-decoration:none">Skipped</div>` : ""}
        <div class="a right">${picks[i] === q.answer ? "✓ " : ""}${esc(q.options[q.answer])}</div>
        ${q.explain ? `<div class="why">${esc(q.explain)}</div>` : ""}</div>`).join("")}</div>
  </div>`;
  $("#discard").addEventListener("click", async () => { await api(`/api/results/${saved.id}`, { method: "DELETE" }); PASSAGES = null; toast("Session discarded"); location.hash = "#/"; });
  $("#next").addEventListener("click", async () => {
    const list = applyFilters(await loadPassages(true)).filter((x) => x.id !== p.id);
    const n = pickRandom(list); if (n) location.hash = `#/read/${n.id}?mode=${run.mode}${run.target ? "&wpm=" + run.target : ""}`;
  });
}

/* ---------------------------------------------------------------- history */
async function renderHistory() {
  const results = (await loadResults()).reverse();
  view.innerHTML = `<h1>History</h1><p class="muted">Every session you've saved.</p>
    ${results.length ? `<div class="card" style="padding:6px 8px;overflow-x:auto"><table>
      <thead><tr><th>Date</th><th>Passage</th><th>Mode</th><th class="num">Words</th><th class="num">Time</th><th class="num">WPM</th><th class="num">Score</th><th class="num">Effective</th><th></th></tr></thead>
      <tbody>${results.map((r) => `<tr>
        <td class="faint">${fmtDate(r.ts)}</td>
        <td><a href="#/read/${r.passage_id}" style="text-decoration:none">${esc(r.title || "(removed)")}</a></td>
        <td>${esc(MODES[r.mode]?.name || r.mode)}${r.target_wpm ? ` <span class="faint small">@${Math.round(r.target_wpm)}</span>` : ""}</td>
        <td class="num">${r.words}</td><td class="num">${fmtTime(r.seconds)}</td><td class="num">${Math.round(r.wpm)}</td>
        <td class="num">${r.total ? `${r.score}/${r.total}` : "—"}</td><td class="num">${r.effective_wpm ? Math.round(r.effective_wpm) : "—"}</td>
        <td><button class="btn ghost small" data-del="${r.id}" title="Delete">✕</button></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="card empty">No sessions yet. <a href="#/library">Pick something to read</a>.</div>`}`;
  $$("[data-del]").forEach((b) => b.addEventListener("click", async () => { await api(`/api/results/${b.dataset.del}`, { method: "DELETE" }); renderHistory(); }));
}

/* ---------------------------------------------------------------- sources */
const SUGGESTED = [
  { name: "Aeon · Essays", url: "https://aeon.co/feed.rss", kind: "essay", categories: ["history", "biology"] },
  { name: "Psyche", url: "https://psyche.co/feed", kind: "essay", categories: ["health", "productivity"] },
  { name: "Knowable Magazine", url: "https://knowablemagazine.org/rss", kind: "news", categories: ["biology", "health"] },
  { name: "Nautilus", url: "https://nautil.us/feed/", kind: "essay", categories: ["biology", "technology"] },
  { name: "Construction Physics", url: "https://www.construction-physics.com/feed", kind: "essay", categories: ["history", "technology"] },
  { name: "The Marginalian", url: "https://www.themarginalian.org/feed/", kind: "essay", categories: ["biography", "productivity"] },
  { name: "Of Dollars And Data", url: "https://ofdollarsanddata.com/feed/", kind: "blog", categories: ["finance"] },
  { name: "Ness Labs", url: "https://nesslabs.com/feed", kind: "blog", categories: ["productivity", "health"] },
  { name: "Derek Sivers", url: "https://sive.rs/en.atom", kind: "blog", categories: ["productivity"] },
  { name: "Atlas Obscura", url: "https://www.atlasobscura.com/feeds/latest", kind: "blog", categories: ["history"] },
  { name: "Astral Codex Ten", url: "https://www.astralcodexten.com/feed", kind: "essay", categories: ["health", "technology"] },
  { name: "Bits about Money", url: "https://www.bitsaboutmoney.com/archive/rss/", kind: "essay", categories: ["finance"] },
];

async function renderSources() {
  const s = await api("/api/sources");
  const catPick = (name) => `<div class="cat-pick" data-cats="${name}">${CATS.map((c) => `<button type="button" class="chip" data-c="${c}">${c}</button>`).join("")}</div>`;
  const kindSel = (name) => `<select name="${name}">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v.replace(/s$/, "")}</option>`).join("")}</select>`;
  const have = new Set(s.feeds.map((f) => f.url));
  view.innerHTML = `
    <div class="row"><h1>Sources</h1><div class="spacer"></div>
      <button class="btn primary" id="refresh">Fetch new articles</button></div>
    <p class="muted">Your corpus: ${s.feeds.length} feeds, ${s.pages} saved pages, ${s.wikipedia} knowledge bytes, ${s.books} book excerpts. Everything lives in <code>sources.json</code>, so you can edit it directly too.</p>
    <div class="card" style="margin:16px 0;${s.quiz_provider ? "" : "border-color:var(--accent)"}">
      <b>Quiz generation:</b> ${s.quiz_provider
        ? `on (${esc(s.quiz_provider)}). New passages get a quiz automatically.`
        : `off. The starter library has precomputed quizzes. To quiz new content, add <code>ANTHROPIC_API_KEY=…</code> or <code>OPENAI_API_KEY=…</code> to <code>speedreader/.env</code> and restart the server.`}
    </div>
    <div id="refreshLog" class="log" hidden></div>

    <div class="two-col section">
      <form class="card" id="fUrl"><h3 style="margin-bottom:12px">Add an article by URL</h3>
        <label class="field"><span>URL</span><input type="url" name="url" required placeholder="https://…"></label>
        <label class="field"><span>Type</span>${kindSel("kind")}</label>
        <div class="field"><span>Topics</span>${catPick("url")}</div>
        <label class="row small muted" style="gap:6px;margin-bottom:12px"><input type="checkbox" class="switch" name="googlebot"> Paywalled site (NYT, WSJ…): fetch as a search crawler</label>
        <button class="btn primary">Add article</button></form>
      <form class="card" id="fText"><h3 style="margin-bottom:12px">Paste text</h3>
        <p class="faint small" style="margin-top:-6px">Good for X/Twitter long-form posts, newsletters, book passages.</p>
        <label class="field"><span>Title</span><input type="text" name="title" required></label>
        <label class="field"><span>Text</span><textarea name="text" required></textarea></label>
        <div class="row" style="align-items:flex-start"><label class="field" style="flex:1"><span>Type</span>${kindSel("kind")}</label></div>
        <div class="field"><span>Topics</span>${catPick("text")}</div>
        <button class="btn primary">Add text</button></form>
    </div>

    <div class="section"><div class="section-head"><h2>Feeds</h2><span class="faint small">Fetch new articles pulls the latest few from each enabled feed.</span></div>
      <div class="card" style="padding:6px 8px"><table><thead><tr><th>On</th><th>Feed</th><th>Type</th><th>Topics</th><th class="num">In library</th></tr></thead>
      <tbody>${s.feeds.map((f) => `<tr><td><input type="checkbox" class="switch" data-feed="${f.id}" ${f.enabled === false ? "" : "checked"}></td>
        <td>${esc(f.name)}${f.ua === "googlebot" ? ` <span class="tag">paywall</span>` : ""}<div class="faint small">${esc(f.url)}</div></td>
        <td>${esc(f.kind)}</td><td>${f.categories.map((c) => `<span class="tag">${esc(c)}</span>`).join(" ")}</td><td class="num">${f.count}</td></tr>`).join("")}</tbody></table></div>
    </div>

    <div class="two-col section">
      <form class="card" id="fFeed"><h3 style="margin-bottom:12px">Add an RSS / Atom feed</h3>
        <label class="field"><span>Name</span><input type="text" name="name" required></label>
        <label class="field"><span>Feed URL</span><input type="url" name="url" required></label>
        <div class="row"><label class="field" style="flex:1"><span>Type</span>${kindSel("kind")}</label><label class="field" style="width:120px"><span>Per refresh</span><input type="number" name="max_items" value="3" min="1" max="10"></label></div>
        <div class="field"><span>Topics</span>${catPick("feed")}</div>
        <label class="row small muted" style="gap:6px;margin-bottom:12px"><input type="checkbox" class="switch" name="googlebot"> Paywalled</label>
        <button class="btn primary">Add feed</button></form>
      <div class="card"><h3 style="margin-bottom:12px">Suggested sources</h3>
        ${SUGGESTED.map((x, i) => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)"><div><b>${esc(x.name)}</b> <span class="faint small">${x.categories.join(", ")}</span></div><div class="spacer"></div>
          ${have.has(x.url) ? `<span class="faint small">added</span>` : `<button class="btn small" data-sug="${i}">Add</button>`}</div>`).join("")}
      </div>
    </div>`;

  $$(".cat-pick").forEach((cp) => cp.addEventListener("click", (e) => { const c = e.target.closest("[data-c]"); if (c) c.classList.toggle("on"); }));
  const cats = (form) => $$(".cat-pick .chip.on", form).map((c) => c.dataset.c);
  const submit = (formId, path, build) => $(formId).addEventListener("submit", async (e) => {
    e.preventDefault(); const f = e.target; const btn = $("button.primary", f); btn.disabled = true;
    try { const r = await api(path, { method: "POST", body: build(new FormData(f), f) }); PASSAGES = null; toast(r.title ? `Added “${r.title}” (${r.words} words)` : "Added"); f.reset(); $$(".chip.on", f).forEach((c) => c.classList.remove("on")); if (formId === "#fFeed") renderSources(); }
    catch (err) { toast(err.message); } finally { btn.disabled = false; }
  });
  submit("#fUrl", "/api/add/url", (d, f) => ({ url: d.get("url"), kind: d.get("kind"), categories: cats(f), googlebot: !!d.get("googlebot") }));
  submit("#fText", "/api/add/text", (d, f) => ({ title: d.get("title"), text: d.get("text"), kind: d.get("kind"), categories: cats(f) }));
  submit("#fFeed", "/api/add/feed", (d, f) => ({ name: d.get("name"), url: d.get("url"), kind: d.get("kind"), categories: cats(f), max_items: +d.get("max_items"), googlebot: !!d.get("googlebot") }));
  $$("[data-feed]").forEach((cb) => cb.addEventListener("change", () => api(`/api/sources/feeds/${cb.dataset.feed}`, { method: "POST", body: { enabled: cb.checked } })));
  $$("[data-sug]").forEach((b) => b.addEventListener("click", async () => {
    const x = SUGGESTED[+b.dataset.sug];
    try { await api("/api/add/feed", { method: "POST", body: { ...x, max_items: 3 } }); toast(`Added ${x.name}. Fetch new articles to pull it in.`); renderSources(); } catch (e) { toast(e.message); }
  }));
  const poll = async () => {
    const st = await api("/api/refresh"); const log = $("#refreshLog"); if (!log) return;
    if (st.running || st.log.length) { log.hidden = false; log.textContent = st.log.join("\n") || "Starting…"; log.scrollTop = log.scrollHeight; }
    const btn = $("#refresh"); btn.disabled = st.running; btn.textContent = st.running ? "Fetching…" : "Fetch new articles";
    if (st.running) setTimeout(poll, 1200); else if (st.stats) { PASSAGES = null; }
  };
  $("#refresh").addEventListener("click", async () => { await api("/api/refresh", { method: "POST" }); poll(); });
  poll();
}

route();
})();
