/* SPX 低点/高点标注器。
 *
 * 只干一件事：让人在图上框出一段时间，把这段里的极值点（低点模式取最低 Low，
 * 高点模式取最高 High）记成一个标注，存到 data/marks.json。优化/回测是另一步，
 * 这里一行都不掺。
 *
 * 数据来自 spx.js（列存：d/o/h/l/c 四个等长数组），由 scripts/build_marker_data.py 生成。
 * 读写标注走 scripts/mark_server.py 的 /api/marks。
 */
"use strict";
(function () {

const D = window.SPX;                       // 行情，只读
const N = D.n;
const $ = s => document.querySelector(s);
const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ── 状态 ─────────────────────────────────────────────────────────────────
let i0 = 0, i1 = N;            // 可视区间，左闭右开的 K 线索引
let logY = true;               // 对数价格轴（1927→2026 跨 400 倍，线性轴看不了）
let kind = "low";              // 当前标注类型：low / high
let defStrength = "strong";    // 框选后新标注的默认强度
let marks = [];                // [{id,kind,date,strength,px,note,source}]
let curId = null;              // 列表里选中的那条
let dirty = false;             // 有未保存改动
let readOnly = false;          // 静态站（GitHub Pages）没有 /api/marks，只能看不能存
const undoStack = [];          // 每步操作前的 marks 快照，Ctrl+Z 回退

const base = $("#base"), over = $("#over");
const bctx = base.getContext("2d"), octx = over.getContext("2d");
const wrap = $("#chart");
let W = 0, H = 0, DPR = 1;
const PAD = { l: 8, r: 62, t: 12, b: 24 };

// 日期 → 索引，框选/定位都要用
const IDX = new Map();
for (let i = 0; i < N; i++) IDX.set(D.d[i], i);

// ── 坐标换算 ─────────────────────────────────────────────────────────────
const plotW = () => W - PAD.l - PAD.r;
const plotH = () => H - PAD.t - PAD.b;
const xOf = i => PAD.l + (i - i0 + 0.5) * plotW() / (i1 - i0);
const iOf = x => i0 + (x - PAD.l) * (i1 - i0) / plotW() - 0.5;

let yLo = 0, yHi = 1;                        // 当前价格轴范围
const tf = v => logY ? Math.log(Math.max(v, 1e-6)) : v;
function yOf(v) {
  const a = tf(yLo), b = tf(yHi);
  return PAD.t + plotH() * (1 - (tf(v) - a) / (b - a));
}

function fitY() {
  let lo = Infinity, hi = -Infinity;
  for (let i = Math.max(0, i0); i < Math.min(N, i1); i++) {
    if (D.l[i] < lo) lo = D.l[i];
    if (D.h[i] > hi) hi = D.h[i];
  }
  if (!isFinite(lo)) { lo = 1; hi = 2; }
  // 上下各留 4% 余量；对数轴按比例留，否则低位会被压扁
  if (logY) {
    const k = Math.pow(hi / lo, 0.04);
    yLo = lo / k; yHi = hi * k;
  } else {
    const m = (hi - lo) * 0.04 || 1;
    yLo = lo - m; yHi = hi + m;
  }
}

// ── 绘制 ─────────────────────────────────────────────────────────────────
function resize() {
  const r = wrap.getBoundingClientRect();
  DPR = window.devicePixelRatio || 1;
  W = r.width; H = r.height;
  for (const c of [base, over]) {
    c.width = Math.round(W * DPR); c.height = Math.round(H * DPR);
    c.getContext("2d").setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  render();
}

function niceTicks(lo, hi, want) {
  // 线性轴用 1/2/5×10^k；对数轴跨度大时直接按 10 的幂 + 2/5 分档
  const out = [];
  if (logY && hi / lo > 8) {
    for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++)
      for (const m of [1, 2, 5]) {
        const v = m * Math.pow(10, e);
        if (v >= lo && v <= hi) out.push(v);
      }
    return out;
  }
  const raw = (hi - lo) / want, p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].find(m => m * p >= raw) * p;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

const fmtPx = v => v >= 1000 ? v.toFixed(0) : v >= 100 ? v.toFixed(1) : v.toFixed(2);

function render() {
  fitY();
  const g = bctx;
  g.clearRect(0, 0, W, H);
  const C = {
    line: cssv("--line"), line2: cssv("--line2"), ink2: cssv("--ink2"),
    ink3: cssv("--ink3"), up: cssv("--up"), down: cssv("--down"),
    low: cssv("--low"), high: cssv("--high"), brand: cssv("--brand"),
  };
  const n = i1 - i0, bw = plotW() / n;

  // 横网格 + 价格刻度
  g.font = "11px ui-monospace,Menlo,Consolas,monospace";
  g.textBaseline = "middle";
  for (const v of niceTicks(yLo, yHi, 7)) {
    const y = yOf(v);
    g.strokeStyle = C.line2; g.beginPath();
    g.moveTo(PAD.l, y + .5); g.lineTo(W - PAD.r, y + .5); g.stroke();
    g.fillStyle = C.ink3; g.textAlign = "left";
    g.fillText(fmtPx(v), W - PAD.r + 6, y);
  }
  // 竖网格 + 日期刻度
  g.textAlign = "center"; g.textBaseline = "top";
  const step = Math.max(1, Math.round(n / 8));
  for (let i = Math.ceil(i0 / step) * step; i < i1; i += step) {
    if (i < 0 || i >= N) continue;
    const x = xOf(i);
    g.strokeStyle = C.line2; g.beginPath();
    g.moveTo(x + .5, PAD.t); g.lineTo(x + .5, H - PAD.b); g.stroke();
    g.fillStyle = C.ink3;
    g.fillText(n > 400 ? D.d[i].slice(0, 7) : D.d[i].slice(2), x, H - PAD.b + 5);
  }

  // 行情本体：K 线太窄就退化成收盘折线，不然几万根画不动也看不清
  const a = Math.max(0, Math.floor(i0)), b = Math.min(N, Math.ceil(i1));
  if (bw >= 3.2) {
    const w = Math.max(1, Math.floor(bw * 0.68));
    for (let i = a; i < b; i++) {
      const x = Math.round(xOf(i)), up = D.c[i] >= D.o[i];
      g.strokeStyle = g.fillStyle = up ? C.up : C.down;
      g.beginPath(); g.moveTo(x + .5, yOf(D.h[i])); g.lineTo(x + .5, yOf(D.l[i])); g.stroke();
      const y1 = yOf(Math.max(D.o[i], D.c[i])), y2 = yOf(Math.min(D.o[i], D.c[i]));
      g.fillRect(x - (w >> 1), y1, w, Math.max(1, y2 - y1));
    }
  } else {
    g.strokeStyle = C.brand; g.lineWidth = 1.2; g.beginPath();
    // 每个像素列只取一根，几万个点也不卡
    const sp = Math.max(1, Math.floor((b - a) / Math.max(1, plotW() * 2)));
    for (let i = a, k = 0; i < b; i += sp, k++) {
      const x = xOf(i), y = yOf(D.c[i]);
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke(); g.lineWidth = 1;
  }

  // 标注
  for (const m of marks) {
    const i = IDX.get(m.date);
    if (i === undefined || i < i0 - 2 || i > i1 + 2) continue;
    drawMark(g, m, xOf(i), yOf(m.px), m.id === curId, C);
  }
  drawOverlay();
}

function drawMark(g, m, x, y, cur, C) {
  const low = m.kind === "low";
  const strong = m.strength === "strong";
  const col = low ? C.low : C.high;
  const s = strong ? 7 : 5;
  const dy = low ? 10 : -10;               // 低点标在下方，高点标在上方，不挡 K 线
  const ty = y + dy;
  g.beginPath();                            // 低点画上三角（指向低点），高点画下三角
  g.moveTo(x, ty - dy * 0.42);
  g.lineTo(x - s, ty + dy * 0.55);
  g.lineTo(x + s, ty + dy * 0.55);
  g.closePath();
  g.fillStyle = col; g.strokeStyle = col; g.lineWidth = strong ? 1.5 : 1.2;
  strong ? g.fill() : g.stroke();           // 强=实心，弱=空心
  if (cur) {                                // 选中的加一圈光晕 + 竖虚线
    g.setLineDash([3, 3]); g.strokeStyle = C.brand; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x + .5, PAD.t); g.lineTo(x + .5, H - PAD.b); g.stroke();
    g.setLineDash([]);
    g.beginPath(); g.arc(x, ty, s + 5, 0, 7); g.stroke();
  }
  g.lineWidth = 1;
}

// 上层画布：只画十字线和框选矩形，鼠标一动不用重绘几万根 K 线
let mouse = null, dragSel = null;
function drawOverlay() {
  octx.clearRect(0, 0, W, H);
  if (dragSel) {
    const x1 = Math.min(dragSel.x0, dragSel.x1), x2 = Math.max(dragSel.x0, dragSel.x1);
    octx.fillStyle = cssv("--sel");
    octx.fillRect(x1, PAD.t, x2 - x1, plotH());
    octx.strokeStyle = cssv("--brand");
    octx.strokeRect(x1 + .5, PAD.t + .5, x2 - x1, plotH() - 1);
  }
  if (mouse) {
    octx.setLineDash([2, 3]); octx.strokeStyle = cssv("--ink3");
    octx.beginPath();
    octx.moveTo(mouse.x + .5, PAD.t); octx.lineTo(mouse.x + .5, H - PAD.b);
    octx.moveTo(PAD.l, mouse.y + .5); octx.lineTo(W - PAD.r, mouse.y + .5);
    octx.stroke(); octx.setLineDash([]);
  }
}

// ── 视图操作 ─────────────────────────────────────────────────────────────
const MINBARS = 12;
function setView(a, b) {
  let n = Math.max(MINBARS, Math.min(N, Math.round(b - a)));
  a = Math.round(a);
  if (a < 0) a = 0;
  if (a + n > N) a = N - n;
  i0 = a; i1 = a + n;
  render();
}
function winBars(w) {
  return { "1y": 252, "3y": 756, "5y": 1260, "10y": 2520, "all": N }[w] || N;
}

wrap.addEventListener("wheel", e => {
  e.preventDefault();
  const anchor = iOf(e.offsetX);                       // 光标下那根 K 线固定不动
  const k = e.deltaY > 0 ? 1.18 : 1 / 1.18;
  const n = Math.max(MINBARS, Math.min(N, (i1 - i0) * k));
  const frac = (anchor - i0) / (i1 - i0);
  setView(anchor - frac * n, anchor - frac * n + n);
}, { passive: false });

let pan = null;
wrap.addEventListener("mousedown", e => {
  if (e.button === 2 || e.shiftKey) {                  // 右键 / Shift+左键 = 平移
    pan = { x: e.offsetX, i0, i1 };
  } else if (e.button === 0) {                         // 左键 = 框选
    dragSel = { x0: e.offsetX, x1: e.offsetX };
  }
});
wrap.addEventListener("mousemove", e => {
  mouse = { x: e.offsetX, y: e.offsetY };
  if (pan) {
    const d = (e.offsetX - pan.x) * (pan.i1 - pan.i0) / plotW();
    setView(pan.i0 - d, pan.i1 - d);
  } else if (dragSel) {
    dragSel.x1 = e.offsetX;
  }
  readout(e.offsetX);
  drawOverlay();
});
window.addEventListener("mouseup", e => {
  if (pan) { pan = null; return; }
  if (!dragSel) return;
  const sel = dragSel; dragSel = null;
  drawOverlay();
  if (Math.abs(sel.x1 - sel.x0) < 4) { pickNearby(sel.x0); return; }  // 当成点击
  addFromRange(iOf(Math.min(sel.x0, sel.x1)), iOf(Math.max(sel.x0, sel.x1)));
});
wrap.addEventListener("mouseleave", () => { mouse = null; drawOverlay(); $("#readout").textContent = ""; });
wrap.addEventListener("contextmenu", e => e.preventDefault());
wrap.addEventListener("dblclick", () => setView(0, N));

function readout(x) {
  const i = Math.round(iOf(x));
  if (i < 0 || i >= N) return;
  $("#readout").textContent =
    `${D.d[i]}  开${fmtPx(D.o[i])} 高${fmtPx(D.h[i])} 低${fmtPx(D.l[i])} 收${fmtPx(D.c[i])}`;
}

// 点一下：选中附近 12px 内的标注，方便改强弱/删
function pickNearby(x) {
  let best = null, bd = 12;
  for (const m of marks) {
    const i = IDX.get(m.date);
    if (i === undefined) continue;
    const d = Math.abs(xOf(i) - x);
    if (d < bd) { bd = d; best = m; }
  }
  curId = best ? best.id : null;
  renderList(); render();
}

// ── 标注增删改 ───────────────────────────────────────────────────────────
function snapshot() {
  undoStack.push(JSON.stringify(marks));
  if (undoStack.length > 100) undoStack.shift();
}
let flashTimer = null;
function flash(msg) {
  const s = $("#status");
  s.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => setDirty(dirty), 2200);
}
function setDirty(v) {
  dirty = v;
  const s = $("#status");
  s.classList.toggle("dirty", v);
  s.textContent = readOnly
    ? `只读模式 · 共 ${marks.length} 个（改动不会存盘）`
    : (v ? `有 ${marks.length} 个标注未保存` : `已保存 · 共 ${marks.length} 个`);
}

/** 框选的核心：在 [a,b] 这段交易日里取极值。
 *  只看横向时间范围，不看竖向价格范围——框歪一点也能选对，比精确框好用。 */
function addFromRange(a, b) {
  const lo = Math.max(0, Math.ceil(a)), hi = Math.min(N - 1, Math.floor(b));
  if (hi < lo) return;
  let bi = lo;
  for (let i = lo; i <= hi; i++) {
    if (kind === "low" ? D.l[i] < D.l[bi] : D.h[i] > D.h[bi]) bi = i;
  }
  const date = D.d[bi], px = kind === "low" ? D.l[bi] : D.h[bi];
  const id = kind + "-" + date;
  const hit = marks.find(m => m.id === id);
  curId = id;
  if (hit) {
    // 这一天已经标过了。不动它的强弱——框歪一点就把标好的点改了，太容易出事。
    // 要改强弱，去右边列表点那个「强/弱」标签。
    flash(`${date} 已标注过（${hit.strength === "strong" ? "强" : "弱"}），未改动`);
    renderList(); render();
    return;
  }
  snapshot();
  marks.push({ id, kind, date, strength: defStrength, px, note: "", source: "ui" });
  marks.sort((p, q) => p.date < q.date ? -1 : p.date > q.date ? 1 : 0);
  setDirty(true); renderList(); render();
}

function removeMark(id) {
  snapshot();
  marks = marks.filter(m => m.id !== id);
  if (curId === id) curId = null;
  setDirty(true); renderList(); render();
}
function toggleStrength(id) {
  const m = marks.find(x => x.id === id);
  if (!m) return;
  snapshot();
  m.strength = m.strength === "strong" ? "weak" : "strong";
  setDirty(true); renderList(); render();
}
function undo() {
  if (!undoStack.length) return;
  marks = JSON.parse(undoStack.pop());
  if (!marks.some(m => m.id === curId)) curId = null;
  setDirty(true); renderList(); render();
}

// ── 列表 ─────────────────────────────────────────────────────────────────
function renderList() {
  const f = $("#filter").value;
  const show = marks.filter(m => f === "all" || m.kind === f);
  const nl = marks.filter(m => m.kind === "low"), nh = marks.filter(m => m.kind === "high");
  $("#count").textContent =
    `低 ${nl.length}（强 ${nl.filter(m => m.strength === "strong").length}） · ` +
    `高 ${nh.length}（强 ${nh.filter(m => m.strength === "strong").length}）`;

  const box = $("#list");
  box.innerHTML = "";
  for (const m of show) {
    const row = document.createElement("div");
    row.className = "row" + (m.id === curId ? " cur" : "");
    row.innerHTML =
      `<span class="dot" style="background:${m.kind === "low" ? "var(--low)" : "var(--high)"}"></span>` +
      `<span class="d">${m.date}</span>` +
      `<span class="tag ${m.strength === "strong" ? "strong" : ""}" data-act="st">` +
      `${m.strength === "strong" ? "强" : "弱"}</span>` +
      `<span class="p">${fmtPx(m.px)}</span>` +
      `<span class="del" data-act="del">✕</span>`;
    row.title = m.note || "";
    row.onclick = ev => {
      const act = ev.target.dataset.act;
      if (act === "del") return removeMark(m.id);
      if (act === "st") return toggleStrength(m.id);
      curId = m.id;
      const i = IDX.get(m.date);
      if (i !== undefined) {                    // 把这个点居中，窗口宽度保持不变
        const n = i1 - i0;
        setView(i - n / 2, i + n / 2);
      }
      renderList(); render();
    };
    box.append(row);
  }
  const cur = marks.find(m => m.id === curId);
  $("#sel-info").textContent = cur
    ? `${cur.kind === "low" ? "低点" : "高点"} ${cur.date} @ ${fmtPx(cur.px)}`
    : "未选中";
  $("#note").value = cur ? (cur.note || "") : "";
}

// ── 读写盘 ───────────────────────────────────────────────────────────────
async function load() {
  // 先试本地服务的接口——那是唯一可写的真源（data/marks.json）。
  // 试不通说明这是 GitHub Pages 上的静态版，退到构建时打进去的 marks.js，转只读。
  let j = null;
  try {
    const r = await fetch("/api/marks", { cache: "no-store" });
    if (r.ok) j = await r.json();
  } catch (e) { /* 静态站必然走到这里，不是错误 */ }

  if (!j) {
    readOnly = true;
    j = window.MARKS || { marks: [] };
    document.body.classList.add("ro");
    $("#save").textContent = "下载 marks.json";
  }
  const total = (j.marks || []).length;
  marks = (j.marks || []).filter(m => IDX.has(m.date));
  marks.sort((p, q) => p.date < q.date ? -1 : 1);
  setDirty(false);
  if (total !== marks.length) {
    // 标注的日期在行情表里找不到——多半是数据换源了，宁可吵一下也别悄悄丢点
    flash(`警告：有 ${total - marks.length} 个标注的日期不在行情数据里，已忽略`);
  }
  renderList(); render();
}

/** 只读模式下没法写盘，改成把当前标注下载成 marks.json，自己放回 data/ 即可。 */
function download() {
  const blob = new Blob([JSON.stringify(
    { version: 1, symbol: "SPX", exported: new Date().toISOString().slice(0, 19),
      n: marks.length, marks }, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "marks.json";
  a.click();
  URL.revokeObjectURL(a.href);
  flash("已下载 marks.json，放回 data/ 目录即可");
}
async function save() {
  try {
    const r = await fetch("/api/marks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: "SPX", marks }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "未知错误");
    setDirty(false);
    $("#status").textContent = `已保存 ${j.n} 个 · ${j.updated.replace("T", " ")}`;
  } catch (e) {
    $("#status").textContent = "保存失败：" + e.message;
  }
}

// ── 顶栏与快捷键 ─────────────────────────────────────────────────────────
function pair(aSel, bSel, set) {
  const a = $(aSel), b = $(bSel);
  a.onclick = () => { set(0); a.classList.add("on"); b.classList.remove("on"); };
  b.onclick = () => { set(1); b.classList.add("on"); a.classList.remove("on"); };
}
pair("#m-low", "#m-high", i => { kind = i ? "high" : "low"; });
pair("#s-strong", "#s-weak", i => { defStrength = i ? "weak" : "strong"; });

document.querySelectorAll("[data-win]").forEach(b => {
  b.onclick = () => { const n = winBars(b.dataset.win); setView(N - n, N); };
});
$("#logbtn").classList.add("on");
$("#logbtn").onclick = e => { logY = !logY; e.target.classList.toggle("on", logY); render(); };
$("#theme").onclick = () => {
  const d = document.documentElement;
  d.dataset.theme = d.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("marker_theme", d.dataset.theme);
  render();
};
$("#save").onclick = () => readOnly ? download() : save();
$("#filter").onchange = renderList;
$("#note").onkeydown = e => {
  if (e.key !== "Enter") return;
  const m = marks.find(x => x.id === curId);
  if (!m) return;
  snapshot(); m.note = e.target.value; setDirty(true); renderList();
};

window.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT") return;
  if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); return undo(); }
  if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); return save(); }
  if (e.key === "Delete" || e.key === "Backspace") { if (curId) removeMark(curId); }
  if (e.key === "l" || e.key === "L") $("#m-low").click();
  if (e.key === "h" || e.key === "H") $("#m-high").click();
  if (e.key === "1") $("#s-strong").click();
  if (e.key === "2") $("#s-weak").click();
});
window.addEventListener("beforeunload", e => {
  if (dirty && !readOnly) { e.preventDefault(); e.returnValue = ""; }
});
window.addEventListener("resize", resize);

// ── 启动 ─────────────────────────────────────────────────────────────────
document.documentElement.dataset.theme = localStorage.getItem("marker_theme") || "dark";
setView(N - winBars("10y"), N);
resize();
load();

})();
