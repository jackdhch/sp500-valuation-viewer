/* 估值面板：自选清单的估值走势与历史分位。
 *
 * 数据来自 valuation_data.js（window.VAL_DATA），由 scripts/build_valuation.py 生成。
 * 画图用 plot.js 里的 Plot（从 template.html 复制来的同一个引擎）。
 *
 * 关于百分位的两套口径 —— 这是复刻那个参考平台时最容易出错的地方：
 *   「百分位（当前区间）」是**区间相对量**，切到 1Y / 5Y / 全部 会得到不同的数，
 *   而估值卡上的「PE 分位 · 近十年」是固定十年窗口。参考平台自己就因为混用这两套
 *   而出现同一天同一只股票两个分位数（NVDA 3.7% vs 0.1%）。
 *   本页所有百分位数字后面都带窗口标注，不留含糊。
 */
(function () {
"use strict";

/* 数据分两层加载：
 *   valuation_index.js  —— 卡片墙要的摘要，十几 KB，页面一打开就有
 *   v/<TICKER>.js       —— 单只标的的日频序列，点进详情页时才去取
 * 以前是一个 4 MB 的 valuation_data.js 同步加载，跨境访问 GitHub Pages 要等很久，
 * 在那之前整页是空白的。 */
var D = window.VAL_INDEX;
if (!D) return;

var PARTS = {};                       // ticker -> 已加载的日频序列
window.__valPart = function (t, part) { PARTS[t] = part; };

var $ = function (s) { return document.querySelector(s); };
var wrap = document.getElementById("view-val");
window.VPlot.root = wrap;   // 暗色变量在 #view-val 上，画图引擎要从这里读颜色

var METRICS = [
  { key: "pe",     label: "PE TTM",      kpi: "PE (TTM)",      unit: "×" },
  { key: "fwd_pe", label: "Forward PE",  kpi: "PE (Forward)",  unit: "×" },
  { key: "pb",     label: "PB",          kpi: "PB",            unit: "×" },
  /* 相对估值：个股市盈率 ÷ 大盘市盈率。
     单看个股的市盈率分位，涨跌里混着「大盘整体变贵/变便宜」这一层；
     除掉基准之后剩下的才是「相对于大盘，这只股票自己贵了还是便宜了」。
     比值 1.5 就是「比大盘贵 50%」。 */
  { key: "rel_spx", label: "相对标普500", kpi: "PE ÷ 标普500", unit: "", base: "VOO" },
  { key: "rel_ndx", label: "相对纳指100", kpi: "PE ÷ 纳指100", unit: "", base: "QQQ" }
];
// 卡片墙与热力图只用得上这三个原始指标（相对估值要两条序列对齐，只在详情页算）
var BASE_METRICS = METRICS.slice(0, 3);

/* 黄金这类标的没有盈利和净资产，市盈率市净率不适用，它在 meta 里自带一套指标定义。
   凡是自带 metrics 的，就用它那套，不要套股票的模板。 */
function metricsFor(t) {
  var m = D.meta[t] || {};
  return (m.metrics && m.metrics.length) ? m.metrics : METRICS;
}
function isMacro(t) { return !!((D.meta[t] || {}).metrics); }
var RANGES = [
  { key: "all", label: "全部", years: null },
  { key: "20y", label: "20Y", years: 20 },
  { key: "10y", label: "10Y", years: 10 },
  { key: "5y",  label: "5Y",  years: 5 },
  { key: "3y",  label: "3Y",  years: 3 },
  { key: "1y",  label: "1Y",  years: 1 }
];

/* 市值/规模在数据里是 "5.09T" / "996.13M" 这种字符串（stockanalysis 原样），排序要先还原成数字 */
var UNIT = { T: 1e12, B: 1e9, M: 1e6, K: 1e3 };
function mcapNum(s) {
  if (!s) return null;
  var m = String(s).replace(/[$,\s]/g, "").match(/^([\d.]+)([TBMK])?$/i);
  if (!m) return null;
  return parseFloat(m[1]) * (m[2] ? UNIT[m[2].toUpperCase()] : 1);
}

var SORTS = [
  { key: "default", label: "默认", desc: false },
  { key: "mcap",    label: "市值", desc: true },
  { key: "pct",     label: "估值分位", desc: false },
  { key: "pe",      label: "PE", desc: false }
];

var cur = { ticker: null, metric: "pe", range: "5y", i0: null, i1: null };
// 详情页上的两个叠加开关
var showPrice = false;    // 右轴叠加股价，看「涨是因为赚钱了还是因为变贵了」
var showAnchors = false;  // 图上标出财季末（每股收益锚点换挡的位置）
var sortBy = "default", sortDesc = true;
var trendPlot = null, pctPlot = null;
var pctSeries = null;      // 当前区间的滚动分位序列，随区间变化重算

/* ---------------- 工具 ---------------- */

function fmt(v, digits) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return Number(v).toFixed(digits === undefined ? 2 : digits);
}

function statusOf(pct, neg) {
  if (neg) return { txt: "盈利为负", cls: "na" };
  if (pct === null || pct === undefined) return { txt: "样本不足", cls: "na" };
  if (pct < 20) return { txt: "低估", cls: "cheap" };
  if (pct < 80) return { txt: "合理", cls: "fair" };
  return { txt: "高估", cls: "rich" };
}

/* 有序数组二分插入，用来增量维护 expanding 窗口，避免每点都重排 */
function bisectLeft(a, v) {
  var lo = 0, hi = a.length;
  while (lo < hi) { var m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
  return lo;
}
function bisectRight(a, v) {
  var lo = 0, hi = a.length;
  while (lo < hi) { var m = (lo + hi) >> 1; if (a[m] <= v) lo = m + 1; else hi = m; }
  return lo;
}

/* 区间内的滚动分位：第 i 个点只跟区间起点到它自己的历史比，不用未来数据。
 * 末点的值因此就等于「当前值在整个区间里的分位」，也就是 KPI 卡上那个数。
 * 负值（盈利为负导致的负市盈率）不参与排名，该点留空。 */
function rollingPct(vals, i0, i1, minObs) {
  minObs = minObs || 30;
  var out = new Array(i1 - i0 + 1), sorted = [];
  for (var i = i0; i <= i1; i++) {
    var v = vals[i];
    if (v === null || v === undefined || v <= 0) { out[i - i0] = null; continue; }
    sorted.splice(bisectLeft(sorted, v), 0, v);
    if (sorted.length < minObs) { out[i - i0] = null; continue; }
    var lo = bisectLeft(sorted, v), hi = bisectRight(sorted, v);
    out[i - i0] = Math.round(1000 * ((lo + hi) / 2) / sorted.length) / 10;
  }
  return out;
}

function lastValid(a) {
  for (var i = a.length - 1; i >= 0; i--) if (a[i] !== null && a[i] !== undefined) return a[i];
  return null;
}
function firstValid(a) {
  for (var i = 0; i < a.length; i++) if (a[i] !== null && a[i] !== undefined) return a[i];
  return null;
}

/* ---------------- 估值卡网格 ---------------- */

/* 只有当前值、没有历史的标的（AIS、DRAM 这类）单独一张灰卡：
   把「为什么没有历史」写在卡上，而不是给一个看起来正常、实际站不住的分位数。 */
function snapshotCard(ticker) {
  var m = D.meta[ticker];
  var el = document.createElement("div");
  el.className = "vc nohist";
  var isEtf = m.kind && m.kind !== "stock";
  // ETF 关心持仓数与成立日；刚 IPO 的个股关心市值，第三格没东西就留空
  var third = isEtf ? ["持仓数", m.holdings || "—"] : ["市值", m.mcap || "—"];
  var second = isEtf ? ["成立", m.inception || "—"] : ["PEG", (m.peg && m.peg !== "n/a") ? m.peg : "—"];
  el.innerHTML =
    '<div class="top"><span class="nm"></span><span class="badge na">仅当前值</span></div>' +
    '<div class="tk"></div>' +
    '<div class="big"><span class="lab">PE · TTM</span><span class="num"></span></div>' +
    '<div class="tri">' +
      '<div><div class="k">PB</div><div class="v b"></div></div>' +
      '<div><div class="k k2"></div><div class="v v2" style="font-size:13px"></div></div>' +
      '<div><div class="k k3"></div><div class="v v3" style="font-size:13px"></div></div>' +
    '</div>' +
    '<div class="why"></div>';
  el.querySelector(".nm").textContent = m.name || ticker;
  el.querySelector(".tk").textContent = ticker + (isEtf ? " · ETF" : " · 美股");
  var pe = m.cur_pe;
  el.querySelector(".num").textContent = (pe && pe !== "n/a") ? pe : "—";
  el.querySelector(".b").textContent = (m.cur_pb && m.cur_pb !== "n/a") ? m.cur_pb : "—";
  el.querySelector(".k2").textContent = second[0];
  el.querySelector(".v2").textContent = second[1];
  el.querySelector(".k3").textContent = third[0];
  el.querySelector(".v3").textContent = third[1];
  el.querySelector(".why").textContent = "无历史分位：" + (m.note || "");
  return el;
}

function card(ticker) {
  var m = D.meta[ticker];
  var c = m.cur || {};
  var mts = metricsFor(ticker);
  var main = mts[0], m2 = mts[1], m3 = mts[2];
  var pe = c[main.key], fwd = c[m2 ? m2.key : ""], pb = c[m3 ? m3.key : ""];
  var p10 = (m.pct10y && m.pct10y[main.key]) || {};
  var st = statusOf(p10.pct, p10.neg);
  var chg = m.pe_chg_1y;
  // 上市不足十年的标的，标签要写真实年限，不能照抄「近十年」
  var winTxt = (p10.years && p10.years < 9.5) ? ("近" + p10.years + "年") : "近十年";

  var el = document.createElement("div");
  el.className = "vc";
  el.innerHTML =
    '<div class="top"><span class="nm"></span><span class="badge ' + st.cls + '"></span></div>' +
    '<div class="tk"></div>' +
    '<div class="big"><span class="lab">' + main.label + '</span><span class="num"></span></div>' +
    '<div class="tri">' +
      '<div><div class="k">' + (m2 ? m2.label : "") + '</div><div class="v f"></div></div>' +
      '<div><div class="k">' + (m3 ? m3.label : "") + '</div><div class="v b"></div></div>' +
      '<div><div class="k">' + (isMacro(ticker) ? "" : "PEG") + '</div><div class="v g"></div></div>' +
    '</div>' +
    '<div class="kv"><span>1Y ' + main.label + ' 变化</span><b class="c"></b></div>' +
    '<div class="kv"><span>' + main.label + ' 分位 · ' + winTxt + '</span><b class="p"></b></div>' +
    '<div class="gradbar" style="margin-top:8px"><div class="knob"></div></div>' +
    (isMacro(ticker) ? "" : '<div class="kv"><span>市值 USD</span><b class="mc"></b></div>');

  el.querySelector(".nm").textContent = m.name || ticker;
  el.querySelector(".badge").textContent = st.txt;
  el.querySelector(".tk").textContent = ticker +
    (m.kind === "macro" ? " · 商品"
     : (m.kind && m.kind !== "stock") ? " · ETF / 指数" : " · 美股");
  el.querySelector(".num").textContent = fmt(pe);
  el.querySelector(".f").textContent = fmt(fwd);
  el.querySelector(".b").textContent = fmt(pb);
  var pegTxt = (m.peg && m.peg !== "n/a" && m.peg !== "N/A") ? m.peg : "—";
  el.querySelector(".g").textContent = isMacro(ticker) ? "" : pegTxt;
  var chgEl = el.querySelector(".c");
  chgEl.textContent = (chg === null || chg === undefined) ? "—" : (chg > 0 ? "+" : "") + chg + "%";
  chgEl.className = "c " + (chg === null ? "" : chg < 0 ? "good" : "bad");
  el.querySelector(".p").textContent =
    p10.pct === null || p10.pct === undefined ? "样本不足" : p10.pct + "%";
  el.querySelector(".knob").style.left = (p10.pct === null || p10.pct === undefined ? 0 : p10.pct) + "%";
  if (p10.pct === null || p10.pct === undefined) el.querySelector(".knob").style.display = "none";
  var mcEl = el.querySelector(".mc");
  if (mcEl) mcEl.textContent = (m.mcap && m.mcap !== "n/a") ? m.mcap : "—";

  if (m.note) {
    var nt = document.createElement("div");
    nt.className = "why";
    nt.textContent = m.note;
    el.appendChild(nt);
  }
  el.addEventListener("click", function () { openDetail(ticker); });
  return el;
}

/* 取某个标的用来排序的数值。拿不到就返回 null，这类一律排到最后，
   免得「没有数据」被排成「最便宜」。 */
function sortValue(t, key) {
  var m = D.meta[t] || {};
  if (key === "mcap") return mcapNum(m.mcap);
  if (!m.has_series) return null;            // 只有当前值的 ETF 参与不了后两种排序
  var p10 = (m.pct10y && m.pct10y.pe) || {};
  if (key === "pct") return (p10.neg ? null : p10.pct);
  if (key === "pe") {
    var v = (m.cur || {}).pe;
    return (v === null || v === undefined || v < 0) ? null : v;  // 负市盈率不参与排序
  }
  return null;
}

function sortedTickers() {
  var all = Object.keys(D.meta).filter(function (t) { return !isHidden(t); });
  if (sortBy === "default") {
    // 默认：ETF / 指数排在前面，个股按代码
    var order = { index_etf: 0, weighted_etf: 1, snapshot_etf: 2, stock: 3 };
    return all.sort(function (a, b) {
      var ka = order[(D.meta[a] || {}).kind] || 3, kb = order[(D.meta[b] || {}).kind] || 3;
      return ka !== kb ? ka - kb : (a < b ? -1 : 1);
    });
  }
  return all.sort(function (a, b) {
    var va = sortValue(a, sortBy), vb = sortValue(b, sortBy);
    if (va === null && vb === null) return a < b ? -1 : 1;
    if (va === null) return 1;               // 无数据的永远垫底，不受升降序影响
    if (vb === null) return -1;
    if (va === vb) return a < b ? -1 : 1;
    return sortDesc ? vb - va : va - vb;
  });
}

function renderSortBar() {
  var box = $("#valSort");
  box.innerHTML = "";
  var lab = document.createElement("span");
  lab.className = "vnote";
  lab.style.cssText = "align-self:center;margin-right:2px";
  lab.textContent = "排序";
  box.appendChild(lab);
  SORTS.forEach(function (it) {
    var b = document.createElement("button");
    var on = it.key === sortBy;
    // 再点一次当前选中的，切换升降序
    b.textContent = it.label + (on && it.key !== "default" ? (sortDesc ? " ↓" : " ↑") : "");
    if (on) b.className = "on";
    b.title = it.key === "default" ? "ETF 在前，个股按代码"
            : it.key === "mcap" ? "个股按市值，ETF 按基金规模"
            : it.key === "pct" ? "固定十年窗口的 PE 分位；样本不足与盈利为负的排在最后"
            : "当前 PE (TTM)；负市盈率排在最后";
    b.addEventListener("click", function () {
      if (sortBy === it.key && it.key !== "default") sortDesc = !sortDesc;
      else { sortBy = it.key; sortDesc = it.desc; }
      renderGrid();
    });
    box.appendChild(b);
  });
}

function renderGrid() {
  renderMacroBar();
  renderViewBar();
  $("#valCards").hidden = view !== "cards";
  $("#valHeat").hidden = view !== "heat";
  $("#valCompare").hidden = view !== "cmp";
  $("#valPortfolio").hidden = view !== "pf";
  $("#valSort").hidden = view !== "cards";
  if (!$("#pickPanel").hidden) renderPickPanel();
  if (view === "heat") { renderHeat(); finishGrid(); return; }
  if (view === "cmp") { renderCompare(); finishGrid(); return; }
  if (view === "pf") { renderPortfolio(); finishGrid(); return; }

  var box = $("#valCards");
  box.innerHTML = "";
  sortedTickers().forEach(function (t) {
    box.appendChild(D.meta[t].has_series ? card(t) : snapshotCard(t));
  });
  renderSortBar();
  finishGrid();
}

function finishGrid() {
  $("#valBuilt").textContent = "数据生成于 " + D.built;
  $("#valGridFoot").innerHTML =
    "分位口径：估值卡上的「PE 分位」是<b>固定十年窗口</b>；点进详情页后的「百分位（当前区间）」" +
    "是<b>区间相对量</b>，会随 1Y/5Y/全部 的切换而变，两者本来就不是同一个数。<br>" +
    "日频市盈率的分子是真实当日收盘价，分母是季度财报锚点插值出来的每股收益（与本站其余页面同口径）。" +
    "每股收益、每股净资产来自 macrotrends（约 20 年季度锚点），前瞻市盈率来自 stockanalysis（约 5 年）。";
}

/* ---------------- 视图切换：卡片 / 热力图 / 对比 ---------------- */

var VIEWS = [{ key: "cards", label: "卡片" },
             { key: "heat", label: "热力图" },
             { key: "cmp", label: "对比" },
             { key: "pf", label: "组合" }];
var view = "cards";
var heatMetric = "pe";

/* 分位 → 颜色。跟页面底部那条五段渐变用同一套色，视觉上对得上。 */
function pctColor(p) {
  if (p === null || p === undefined) return { bg: "var(--panel2)", fg: "var(--ink3)" };
  var stops = [[0, [47, 211, 155]], [20, [143, 206, 74]], [50, [227, 179, 65]],
               [80, [240, 136, 62]], [100, [248, 81, 73]]];
  var i = 1;
  while (i < stops.length - 1 && p > stops[i][0]) i++;
  var a = stops[i - 1], b = stops[i];
  var t = (p - a[0]) / Math.max(1e-6, b[0] - a[0]);
  var c = [0, 1, 2].map(function (k) { return Math.round(a[1][k] + (b[1][k] - a[1][k]) * t); });
  // 底色压淡一点，文字才看得清
  return { bg: "rgba(" + c.join(",") + ",.26)", fg: "rgb(" + c.join(",") + ")" };
}

/* ---------------- 清单管理 ----------------
 * 数据是预先生成好的，所以这里管的是「摆不摆出来」，不是「有没有数据」。
 * 想加一只页面上没有的标的，得先在本地把它的估值锚点抓下来——提示里写了怎么做。
 */
var hiddenSet = (function () {
  try { return JSON.parse(localStorage.getItem("sv_val_hidden") || "[]"); }
  catch (e) { return []; }
})();

function saveHidden() {
  try { localStorage.setItem("sv_val_hidden", JSON.stringify(hiddenSet)); } catch (e) { /* 隐私模式 */ }
}

function isHidden(t) { return hiddenSet.indexOf(t) >= 0; }

function renderPickPanel() {
  var box = $("#pickList");
  box.innerHTML = "";
  Object.keys(D.meta).sort().forEach(function (t) {
    var b = document.createElement("button");
    b.textContent = t;
    if (!isHidden(t)) b.className = "on";
    b.title = D.meta[t].name || t;
    b.addEventListener("click", function () {
      var i = hiddenSet.indexOf(t);
      if (i >= 0) hiddenSet.splice(i, 1); else hiddenSet.push(t);
      saveHidden();
      renderGrid();
    });
    box.appendChild(b);
  });
  $("#pickHint").innerHTML =
    "当前显示 " + (Object.keys(D.meta).length - hiddenSet.length) + " / " +
    Object.keys(D.meta).length + " 个。" +
    "要加一只这里没有的标的，得先在本地抓它的估值锚点：" +
    "<code>python3 scripts/fetch_valuation.py TICKER</code> 再 " +
    "<code>python3 scripts/build_valuation.py</code>，然后 <code>bash scripts/deploy.sh</code>。";
}

/* ---------------- 大盘概览条 ----------------
 * 标普500、纳指100、黄金——一进页面先看这三个，再往下看个股。
 * 点一下进各自的详情页。
 */
var MACRO_BAR = [
  { t: "VOO", label: "标普500", metric: "pe", fmt: function (v) { return v.toFixed(2) + "×"; } },
  { t: "QQQ", label: "纳斯达克100", metric: "pe", fmt: function (v) { return v.toFixed(2) + "×"; } },
  { t: "GOLD", label: "黄金（实际金价）", metric: "real",
    fmt: function (v) { return "$" + Math.round(v).toLocaleString("en-US"); } }
];

function renderMacroBar() {
  var box = $("#macroBar");
  box.innerHTML = "";
  MACRO_BAR.forEach(function (cfg) {
    var m = D.meta[cfg.t];
    if (!m) return;
    var cur2 = (m.cur || {})[cfg.metric];
    var info = ((m.pct10y || {})[cfg.metric]) || {};
    var st = statusOf(info.neg ? null : info.pct, info.neg);
    var c = pctColor(info.pct);
    var chg = m.pe_chg_1y;
    var el = document.createElement("div");
    el.className = "mb";
    el.innerHTML =
      '<div class="l"><div class="nm"></div><div class="big"></div><div class="sub"></div></div>' +
      '<div class="r"><div class="pct"></div><div class="badge"></div></div>';
    el.querySelector(".nm").textContent = cfg.label;
    el.querySelector(".big").textContent = (cur2 === null || cur2 === undefined) ? "—" : cfg.fmt(cur2);
    el.querySelector(".sub").textContent =
      (info.years ? (info.years >= 9.5 ? "近十年分位" : "近" + info.years + "年分位") : "分位") +
      (chg === null || chg === undefined ? "" : "　1年变化 " + (chg > 0 ? "+" : "") + chg + "%");
    var p = el.querySelector(".pct");
    p.textContent = (info.pct === null || info.pct === undefined) ? "—" : info.pct.toFixed(1) + "%";
    p.style.color = c.fg;
    var bd = el.querySelector(".badge");
    bd.textContent = st.txt;
    bd.style.background = c.bg;
    bd.style.color = c.fg;
    el.addEventListener("click", function () { openDetail(cfg.t); });
    box.appendChild(el);
  });
}

function renderViewBar() {
  var box = $("#valView");
  box.innerHTML = "";
  VIEWS.forEach(function (it) {
    var b = document.createElement("button");
    b.textContent = it.label;
    if (it.key === view) b.className = "on";
    b.addEventListener("click", function () { view = it.key; renderGrid(); syncHash(true); });
    box.appendChild(b);
  });
  var mg = document.createElement("button");
  mg.textContent = "管理";
  if (!$("#pickPanel").hidden) mg.className = "on";
  mg.addEventListener("click", function () {
    $("#pickPanel").hidden = !$("#pickPanel").hidden;
    renderGrid();
  });
  box.appendChild(mg);
}

var heatGroup = "none";   // none / sector

/* 一个标的的色块 */
function heatCell(r) {
  var c = pctColor(r.pct);
  var el = document.createElement("div");
  el.className = "hc";
  el.style.background = c.bg;
  el.innerHTML = "<div class='t'></div><div class='p'></div><div class='v'></div>";
  el.querySelector(".t").textContent = r.t;
  var p = el.querySelector(".p");
  p.textContent = (r.pct === null || r.pct === undefined) ? "—" : r.pct.toFixed(1) + "%";
  p.style.color = c.fg;
  el.querySelector(".v").textContent =
    (r.cur === null || r.cur === undefined ? "—" : r.cur.toFixed(2) + "×") +
    (r.years && r.years < 9.5 ? "  近" + r.years + "年" : "");
  el.title = r.name + "：" + BASE_METRICS.filter(function (x) { return x.key === heatMetric; })[0].label +
             " 分位 " + (r.pct == null ? "样本不足" : r.pct + "%") +
             (r.sector ? "　板块：" + r.sector : "");
  el.addEventListener("click", function () { openDetail(r.t); });
  return el;
}

function renderHeat() {
  seg($("#heatMetric"), BASE_METRICS, function (it) { return it.key === heatMetric; },
      function (it) { heatMetric = it.key; renderHeat(); });
  seg($("#heatGroup"), [{ key: "none", label: "不分组" }, { key: "sector", label: "按板块" }],
      function (it) { return it.key === heatGroup; },
      function (it) { heatGroup = it.key; renderHeat(); });
  var box = $("#heatGrid");
  box.innerHTML = "";
  var rows = Object.keys(D.meta).filter(function (t) {
      return D.meta[t].has_series && !isHidden(t) && !isMacro(t);   // 黄金那套指标跟股票不同轴，不混在一起比
    })
    .map(function (t) {
      var m = D.meta[t];
      var info = (m.pct10y || {})[heatMetric] || {};
      return { t: t, name: m.name || t, pct: info.neg ? null : info.pct,
               years: info.years, cur: (m.cur || {})[heatMetric],
               sector: m.sector || "", sectorZh: m.sector_zh || "未分类" };
    });
  // 便宜的排前面；没有分位的垫底
  rows.sort(function (a, b) {
    if (a.pct === null || a.pct === undefined) return 1;
    if (b.pct === null || b.pct === undefined) return -1;
    return a.pct - b.pct;
  });
  if (heatGroup === "none") {
    box.className = "heat";
    rows.forEach(function (r) { box.appendChild(heatCell(r)); });
    return;
  }

  // 按板块分组：每组自己一个网格，组标题带该板块的中位分位，便于横向比较板块贵贱
  box.className = "";
  var groups = {};
  rows.forEach(function (r) {
    var k = r.sectorZh || "未分类";
    (groups[k] = groups[k] || []).push(r);
  });
  function median(a) {
    var v = a.filter(function (x) { return x !== null && x !== undefined; })
             .sort(function (x, y) { return x - y; });
    if (!v.length) return null;
    var m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  Object.keys(groups).map(function (k) {
    return { k: k, rows: groups[k], med: median(groups[k].map(function (r) { return r.pct; })) };
  }).sort(function (a, b) {
    if (a.med === null) return 1;
    if (b.med === null) return -1;
    return a.med - b.med;          // 板块也按便宜到贵排
  }).forEach(function (g) {
    var sec = document.createElement("div");
    sec.className = "heatsec";
    var h = document.createElement("h3");
    h.innerHTML = "";
    h.appendChild(document.createTextNode(g.k));
    var sub = document.createElement("span");
    sub.textContent = g.rows.length + " 只　中位分位 " +
                      (g.med === null ? "—" : g.med.toFixed(1) + "%");
    h.appendChild(sub);
    sec.appendChild(h);
    var grid = document.createElement("div");
    grid.className = "heat";
    g.rows.forEach(function (r) { grid.appendChild(heatCell(r)); });
    sec.appendChild(grid);
    box.appendChild(sec);
  });
}

/* ---------------- 多标的对比 ---------------- */

var CMP_COLORS = ["--accent", "--pctline", "--amber", "--rich", "--ink2", "--cheap"];
var cmpSel = ["NVDA", "AMZN", "MSFT"].filter(function (t) { return D.meta[t]; });
var cmpMetric = "pe", cmpRange = "5y", cmpPlot = null;

function renderCompare() {
  seg($("#cmpMetricSeg"), BASE_METRICS, function (it) { return it.key === cmpMetric; },
      function (it) { cmpMetric = it.key; renderCompare(); });
  seg($("#cmpRangeSeg"), RANGES, function (it) { return it.key === cmpRange; },
      function (it) { cmpRange = it.key; renderCompare(); });

  // 可选标的
  var pick = $("#cmpPick");
  pick.innerHTML = "";
  Object.keys(D.meta).filter(function (t) {
      return D.meta[t].has_series && !isHidden(t);
    }).sort().forEach(function (t) {
      var b = document.createElement("button");
      b.textContent = t;
      if (cmpSel.indexOf(t) >= 0) b.className = "on";
      b.addEventListener("click", function () {
        var i = cmpSel.indexOf(t);
        if (i >= 0) cmpSel.splice(i, 1);
        else if (cmpSel.length < CMP_COLORS.length) cmpSel.push(t);
        renderCompare();
      });
      pick.appendChild(b);
    });

  if (!cmpPlot) {
    cmpPlot = new window.VPlot.Plot($("#p-cmp"), {
      height: 300, series: [],
      yfmt: function (v) { return v.toFixed(1) + "×"; }
    });
  }

  // 逐个确保分片已加载，全到齐了再画
  var pending = cmpSel.filter(function (t) { return !PARTS[t]; });
  if (pending.length) {
    $("#cmpNote").textContent = "加载中…（" + pending.length + " 只）";
    pending.forEach(function (t) {
      loadPart(t, function () {
        if (cmpSel.indexOf(t) >= 0 && !cmpSel.some(function (x) { return !PARTS[x]; })) renderCompare();
      });
    });
    return;
  }
  $("#cmpNote").textContent = "折线图数据口径与当前指标一致";
  drawCompare();
}

/* 相关性矩阵：选中标的的日收益两两求 Pearson 相关系数。
   用收益率而不是价格——两条长期上涨的价格曲线天然高度相关，那是趋势不是共动。 */
function renderCorr(tickers, base, i0, i1) {
  var tab = $("#corrTable");
  if (tickers.length < 2) {
    tab.innerHTML = "";
    $("#corrNote").textContent = "至少选两只才能比";
    return;
  }
  // 各标的按基准日期轴对齐后的日收益
  var rets = {}, minLen = Infinity;
  tickers.forEach(function (t) {
    var ds = expandDates(PARTS[t]), px = PARTS[t].px || [];
    var pos = {};
    for (var i = 0; i < ds.length; i++) pos[ds[i]] = i;
    var r = [], prev = null;
    for (var k = i0; k <= i1; k++) {
      var j = pos[base[k]];
      var v = (j === undefined) ? null : px[j];
      r.push((v != null && prev != null && prev > 0) ? (v / prev - 1) : null);
      if (v != null) prev = v;
    }
    rets[t] = r;
    minLen = Math.min(minLen, r.length);
  });

  function corr(a, b) {
    var xs = [], ys = [];
    for (var i = 0; i < a.length; i++) {
      if (a[i] === null || b[i] === null || !isFinite(a[i]) || !isFinite(b[i])) continue;
      xs.push(a[i]); ys.push(b[i]);
    }
    var n = xs.length;
    if (n < 60) return null;                 // 不足三个月的重叠，不给数
    var mx = xs.reduce(function (p, c) { return p + c; }, 0) / n;
    var my = ys.reduce(function (p, c) { return p + c; }, 0) / n;
    var sxy = 0, sxx = 0, syy = 0;
    for (var k = 0; k < n; k++) {
      var dx = xs[k] - mx, dy = ys[k] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : null;
  }

  function cell(v) {
    if (v === null) return { bg: "var(--panel2)", fg: "var(--ink3)", t: "—" };
    // 越接近 1 越红（同涨同跌，分散不了风险），越接近 0 或负越绿
    var a = Math.max(0, Math.min(1, v));
    var c = v < 0 ? [47, 211, 155] : [Math.round(47 + (248 - 47) * a),
                                      Math.round(211 + (81 - 211) * a),
                                      Math.round(155 + (73 - 155) * a)];
    return { bg: "rgba(" + c.join(",") + ",.22)", fg: "rgb(" + c.join(",") + ")",
             t: v.toFixed(2) };
  }

  var html = "<tr><th></th>" + tickers.map(function (t) {
    return "<th>" + esc(t) + "</th>";
  }).join("") + "</tr>";
  tickers.forEach(function (a) {
    html += "<tr><th class='rowh'>" + esc(a) + "</th>";
    tickers.forEach(function (b2) {
      var v = (a === b2) ? 1 : corr(rets[a], rets[b2]);
      var c = cell(v);
      html += "<td style='background:" + c.bg + ";color:" + c.fg + "'>" + c.t + "</td>";
    });
    html += "</tr>";
  });
  tab.innerHTML = html;
  $("#corrNote").textContent =
    "区间 " + base[i0] + " — " + base[i1] + " 的日收益相关系数。" +
    "红 = 同涨同跌（放一起分散不了风险），绿 = 走势独立。";
}

function drawCompare() {
  if (!cmpSel.length) {
    cmpPlot.o.series = [];
    cmpPlot.render();
    $("#cmpLegend").innerHTML = "";
    $("#cmpTable").innerHTML = "";
    $("#corrTable").innerHTML = "";
    return;
  }
  // 各标的交易日不完全一样，以选中里最长的那条为轴，其余按日期对齐
  var base = cmpSel.map(function (t) { return expandDates(PARTS[t]); })
                   .sort(function (a, b) { return b.length - a.length; })[0];
  if (!base) return;
  var rng = RANGES.filter(function (x) { return x.key === cmpRange; })[0];
  var i0 = rangeIdx(base, rng ? rng.years : null), i1 = base.length - 1;

  // 折线图只画有当前指标的（黄金没有市盈率），但下面的相关性矩阵不受这个限制
  var lineSel = cmpSel.filter(function (t) {
    var p = PARTS[t];
    return p && (p[cmpMetric] || []).some(function (v) { return v !== null && v !== undefined; });
  });
  var series = lineSel.map(function (t, k) {
    var ds = expandDates(PARTS[t]), vs = PARTS[t][cmpMetric] || [];
    var pos = {};
    for (var i = 0; i < ds.length; i++) pos[ds[i]] = i;
    var aligned = base.map(function (d) {
      var i = pos[d];
      return (i === undefined) ? null : vs[i];
    });
    return { data: aligned, color: CMP_COLORS[k % CMP_COLORS.length], ticker: t };
  });

  /* Y 轴按 2%–98% 分位裁一刀。不裁的话，某些标的历史上盈利接近 0 的那几个季度
     会把市盈率顶到上万倍（NVDA 2012 年前后就是），一根尖峰能把其余几条线全压成直线。
     超出范围的点贴着边界画，图上注明，不当它不存在。 */
  var pool = [];
  series.forEach(function (s2) {
    for (var i = i0; i <= i1; i++) {
      var v = s2.data[i];
      if (v !== null && v !== undefined) pool.push(v);
    }
  });
  pool.sort(function (a, b) { return a - b; });
  var clipped = 0;
  if (pool.length > 50) {
    var lo = pool[Math.floor(pool.length * 0.02)];
    var hi = pool[Math.floor(pool.length * 0.98)];
    var pad = (hi - lo) * 0.06;
    lo -= pad; hi += pad;
    series.forEach(function (s2) {
      s2.data = s2.data.map(function (v) {
        if (v === null || v === undefined) return v;
        if (v < lo) { clipped++; return lo; }
        if (v > hi) { clipped++; return hi; }
        return v;
      });
    });
    cmpPlot.o.fixed = [lo, hi];
  } else {
    cmpPlot.o.fixed = null;
  }
  $("#cmpNote").textContent = clipped
    ? "Y 轴按 2%–98% 分位裁剪，" + clipped + " 个极端点贴边显示"
    : "折线图数据口径与当前指标一致";

  window.VPlot.setDates(base);
  window.VPlot.setRange(i0, i1);
  cmpPlot.o.series = series;
  cmpPlot.render();

  $("#cmpNote").textContent = (lineSel.length < cmpSel.length)
    ? ("有 " + (cmpSel.length - lineSel.length) + " 只没有这个指标，只进下面的相关性矩阵")
    : $("#cmpNote").textContent;
  $("#cmpLegend").innerHTML = series.map(function (s) {
    return "<span><i style='background:var(" + s.color + ")'></i>" +
           (D.meta[s.ticker].name || s.ticker) + "</span>";
  }).join("");

  // 右边的对比表：当前值 + 该区间内的分位 + 状态
  var rows = series.map(function (s) {
    var seg2 = [];
    for (var i = i0; i <= i1; i++) {
      var v = s.data[i];
      if (v !== null && v !== undefined && v > 0) seg2.push(v);
    }
    var cur2 = seg2.length ? seg2[seg2.length - 1] : null;
    var sorted = seg2.slice().sort(function (a, b) { return a - b; });
    var p = null;
    if (cur2 !== null && sorted.length >= 30) {
      var lo = bisectLeft(sorted, cur2), hi = bisectRight(sorted, cur2);
      p = Math.round(1000 * ((lo + hi) / 2) / sorted.length) / 10;
    }
    var raw = lastValid(s.data.slice(i0, i1 + 1));
    return { t: s.ticker, color: s.color, cur: raw, pct: p, st: statusOf(p, raw !== null && raw < 0) };
  });
  $("#cmpAsOf").textContent = "区间 " + base[i0] + " — " + base[i1] + "，分位按这段算";
  renderCorr(cmpSel.filter(function (t) { return PARTS[t] && PARTS[t].px; }), base, i0, i1);
  $("#cmpTable").innerHTML =
    "<tr><th>标的</th><th class='r'>当前值</th><th class='r'>区间分位</th><th>状态</th></tr>" +
    rows.map(function (r) {
      return "<tr><td><i style='display:inline-block;width:8px;height:8px;border-radius:50%;" +
        "margin-right:6px;background:var(" + r.color + ")'></i>" + r.t + "</td>" +
        "<td class='r'>" + (r.cur === null ? "—" : r.cur.toFixed(2)) + "</td>" +
        "<td class='r'>" + (r.pct === null ? "样本不足" : r.pct + "%") + "</td>" +
        "<td style='color:" + (r.st.cls === "cheap" ? "var(--cheap)" :
          r.st.cls === "rich" ? "var(--rich)" : r.st.cls === "fair" ? "var(--ink)" : "var(--ink3)") +
        "'>" + r.st.txt + "</td></tr>";
    }).join("");
}

/* ---------------- 投资组合分析 ----------------
 * 只用索引里的当前值（价格、市盈率、十年分位、板块），不需要加载任何分片。
 *
 * 组合市盈率用**调和加权** 1 ÷ Σ(wᵢ/PEᵢ)，也就是「组合总市值 ÷ 组合总盈利」。
 * 这是唯一正确的算法——算术加权 Σ(wᵢ·PEᵢ) 会被少数几只高市盈率的持仓拉飞
 * （对 QQQ 实测过：调和 28.9，算术 91.2）。亏损或没有市盈率的持仓不进这个加权，
 * 但它们的权重仍然占着，所以下面会写明「参与计算的权重是多少」。
 */
var PF_DEMO = "NVDA 40%\nAAPL 20%\nQQQ 25%\nGOLD 15%";

function parsePortfolio(text) {
  var rows = [], errs = [], pctMode = null;
  text.split(/\n+/).forEach(function (line) {
    line = line.trim();
    if (!line || line.charAt(0) === "#") return;
    var m = line.split(/[\s,，:：]+/).filter(Boolean);
    if (m.length < 2) { errs.push(line + "（少了数量或权重）"); return; }
    var t = m[0].toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
    var raw = m[1].replace(/[,，]/g, "");
    var isPct = /%$/.test(raw);
    var v = parseFloat(raw.replace("%", ""));
    if (!isFinite(v) || v <= 0) { errs.push(line + "（数量得是正数）"); return; }
    if (pctMode === null) pctMode = isPct;
    else if (pctMode !== isPct) { errs.push(line + "（股数和百分比不能混着写）"); return; }
    if (!D.meta[t]) { errs.push(t + "（页面里还没有这只标的）"); return; }
    rows.push({ t: t, v: v, pct: isPct });
  });
  return { rows: rows, errs: errs, pctMode: !!pctMode };
}

function renderPortfolio() {
  var parsed = parsePortfolio($("#pfInput").value || "");
  var rows = parsed.rows;
  var msg = $("#pfMsg");
  msg.innerHTML = parsed.errs.length
    ? "这几行没算进去：<br>" + parsed.errs.map(function (e) { return "· " + e; }).join("<br>")
    : (rows.length ? "" : "在左边填持仓，一行一只。");
  if (!rows.length) {
    $("#pfKpis").innerHTML = ""; $("#pfTable").innerHTML = "";
    $("#pfSectors").innerHTML = ""; $("#pfCount").textContent = "";
    $("#pfFoot").innerHTML = "";
    return;
  }

  // 先把每一行折成市值
  var total = 0;
  rows.forEach(function (r) {
    var m = D.meta[r.t];
    r.name = m.name || r.t;
    r.px = m.px;
    r.pe = (m.cur || {}).pe;
    r.pct10 = ((m.pct10y || {}).pe || {}).pct;
    r.sector = m.sector_zh || (m.kind === "macro" ? "商品" : m.kind && m.kind !== "stock" ? "ETF / 指数" : "未分类");
    r.value = parsed.pctMode ? r.v : (r.px ? r.px * r.v : null);
    if (r.value) total += r.value;
  });
  rows.forEach(function (r) { r.w = r.value && total ? r.value / total * 100 : 0; });
  rows.sort(function (a, b) { return b.w - a.w; });

  // 调和加权市盈率 + 权重加权分位；没有市盈率的持仓不进分母，但要如实说明覆盖了多少
  var invSum = 0, covPe = 0, pctSum = 0, covPct = 0;
  rows.forEach(function (r) {
    if (r.pe && r.pe > 0) { invSum += r.w / 100 / r.pe; covPe += r.w; }
    if (r.pct10 !== null && r.pct10 !== undefined) { pctSum += r.w / 100 * r.pct10; covPct += r.w; }
  });
  var pfPe = (invSum > 0) ? (covPe / 100) / invSum : null;
  var pfPct = (covPct > 0) ? pctSum / (covPct / 100) : null;
  var st = statusOf(pfPct);
  var top3 = rows.slice(0, 3).reduce(function (a, r) { return a + r.w; }, 0);
  var top5 = rows.slice(0, 5).reduce(function (a, r) { return a + r.w; }, 0);

  $("#pfAsOf").textContent = "价格与估值取自 " + D.built;
  $("#pfKpis").innerHTML =
    kpi("组合市盈率", pfPe === null ? "—" : pfPe.toFixed(2) + "×", "hi") +
    kpi("加权估值分位", pfPct === null ? "—" : pfPct.toFixed(1) + "%", "amber") +
    kpi("估值状态", st.txt, st.cls) +
    kpi("前三大集中度", top3.toFixed(1) + "%", "");

  // 板块分布
  var bys = {};
  rows.forEach(function (r) { bys[r.sector] = (bys[r.sector] || 0) + r.w; });
  var maxw = Math.max.apply(null, Object.keys(bys).map(function (k) { return bys[k]; }));
  $("#pfSectors").innerHTML = Object.keys(bys).sort(function (a, b) { return bys[b] - bys[a]; })
    .map(function (k) {
      return "<div class='pfbar'><span class='nm'>" + esc(k) + "</span>" +
challengeBar(bys[k], maxw) + "<span class='pc'>" + bys[k].toFixed(1) + "%</span></div>";
    }).join("");

  $("#pfCount").textContent = rows.length + " 只，" +
    (parsed.pctMode ? "按你给的权重" : "按股数×最新收盘价折算");
  $("#pfTable").innerHTML =
    "<tr><th>标的</th><th class='r'>" + (parsed.pctMode ? "权重" : "股数") + "</th>" +
    "<th class='r'>市值</th><th class='r'>占比</th><th class='r'>PE</th>" +
    "<th class='r'>十年分位</th><th>板块</th></tr>" +
    rows.map(function (r) {
      var c = pctColor(r.pct10);
      return "<tr><td><b>" + esc(r.t) + "</b><br><span style='color:var(--ink3);font-size:11px'>" +
        esc(r.name) + "</span></td>" +
        "<td class='r'>" + (parsed.pctMode ? r.v + "%" : r.v) + "</td>" +
        "<td class='r'>" + (r.value ? "$" + Math.round(r.value).toLocaleString("en-US") : "—") + "</td>" +
        "<td class='r'><b>" + r.w.toFixed(1) + "%</b></td>" +
        "<td class='r'>" + (r.pe ? r.pe.toFixed(2) : "—") + "</td>" +
        "<td class='r' style='color:" + c.fg + "'>" +
        (r.pct10 === null || r.pct10 === undefined ? "—" : r.pct10.toFixed(1) + "%") + "</td>" +
        "<td style='color:var(--ink3)'>" + esc(r.sector) + "</td></tr>";
    }).join("");

  var bench = ["QQQ", "VOO"].filter(function (t) { return D.meta[t]; }).map(function (t) {
    var m = D.meta[t];
    return t + " " + (((m.cur || {}).pe) || "—") + "×（分位 " +
           (((m.pct10y || {}).pe || {}).pct || "—") + "%）";
  }).join("　");
  $("#pfFoot").innerHTML =
    "组合市盈率用<b>调和加权</b>（组合总市值 ÷ 组合总盈利），不是各只市盈率的算术平均——" +
    "后者会被少数几只高市盈率持仓拉飞。参与市盈率计算的权重占 <b>" + covPe.toFixed(1) +
    "%</b>，参与分位计算的占 <b>" + covPct.toFixed(1) + "%</b>" +
    (covPe < 99 ? "（其余是亏损、刚上市或没有市盈率的持仓，它们的权重仍算在占比里）" : "") + "。<br>" +
    "前五大集中度 " + top5.toFixed(1) + "%。对照：" + bench + "<br>" +
    "分位是固定十年窗口；上市不足十年的按实际年限算，逐只明细里点不开，要看历史去卡片墙。";
}

function kpi(k, v, cls) {
  return "<div class='kpi" + (cls === "hi" ? " hi" : "") + "'><div class='k'>" + esc(k) +
    "</div><div class='v" + (cls === "amber" ? " amber" : "") + "' style='" +
    (cls === "cheap" ? "color:var(--cheap)" : cls === "rich" ? "color:var(--rich)" : "") +
    "'>" + esc(v) + "</div></div>";
}
function esc(x) {
  return String(x === null || x === undefined ? "" : x)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function challengeBar(w, maxw) {
  return "<span class='tr'><span class='fi' style='width:" +
         (maxw ? (w / maxw * 100) : 0) + "%'></span></span>";
}

/* ---------------- 详情视图 ---------------- */

function seg(box, items, isOn, onPick) {
  box.innerHTML = "";
  items.forEach(function (it) {
    var b = document.createElement("button");
    b.textContent = it.label;
    if (isOn(it)) b.className = "on";
    b.addEventListener("click", function () { onPick(it); });
    box.appendChild(b);
  });
}

function rangeIdx(dates, years) {
  if (years === null) return 0;
  var last = new Date(dates[dates.length - 1]);
  var lo = new Date(last.getFullYear() - years, last.getMonth(), last.getDate());
  var s = lo.toISOString().slice(0, 10);
  for (var i = 0; i < dates.length; i++) if (dates[i] >= s) return i;
  return 0;
}

/* 按需拉取单只标的的日频序列。加载期间给个提示，别让详情页干晾在那。 */
function loadPart(ticker, cb) {
  if (PARTS[ticker]) return cb(true);
  var s = document.createElement("script");
  s.src = "v/" + encodeURIComponent(ticker) + ".js";
  s.onload = function () { cb(!!PARTS[ticker]); };
  s.onerror = function () { cb(false); };
  document.head.appendChild(s);
}

/* 分片里日期存的是「起始日 + 逐日增量」，画图要的是日期字符串数组，这里还原一次并缓存 */
function expandDates(part) {
  if (part._d) return part._d;
  var out = [part.d0], t = Date.parse(part.d0 + "T00:00:00Z");
  for (var i = 0; i < part.dd.length; i++) {
    t += part.dd[i] * 86400000;
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  part._d = out;
  return out;
}

/* 外推标记是游程编码过的 [首值, 段长, 段长, ...]，还原成布尔数组 */
function expandFlags(rle, n) {
  if (!rle || !rle.length) return null;
  var out = [], v = !!rle[0];
  for (var i = 1; i < rle.length; i++) {
    for (var k = 0; k < rle[i]; k++) out.push(v);
    v = !v;
  }
  while (out.length < n) out.push(false);
  return out;
}

function openDetail(ticker) {
  $("#macroBar").hidden = true;
  if (cur.ticker !== ticker) {
    cur.i0 = null; cur.i1 = null;   // 换标的不沿用上一只的自定义区间
    var mts0 = metricsFor(ticker);
    if (!mts0.some(function (x) { return x.key === cur.metric; })) cur.metric = mts0[0].key;
  }
  cur.ticker = ticker;
  $("#valGrid").hidden = true;
  $("#valDetail").hidden = false;
  var m = D.meta[ticker];
  $("#valName").textContent = m.name || ticker;
  $("#valCrumb").textContent = ticker + " · 估值详情";
  if (!trendPlot) {
    trendPlot = new window.VPlot.Plot($("#p-val"), {
      height: 260, series: [{ data: null, color: "--accent" }],
      yfmt: function (v) { return v.toFixed(1) + "×"; }
    });
    pctPlot = new window.VPlot.Plot($("#p-valpct"), {
      height: 260, fixed: [0, 100], series: [{ data: null, color: "--pctline" }],
      bands: [{ lo: 80, hi: 100, color: "--rich", alpha: "22" },
              { lo: 0, hi: 20, color: "--cheap", alpha: "22" }],
      yfmt: function (v) { return v.toFixed(0) + "%"; }
    });
    bindCursor();
    bindBrush();
  }
  $("#valSpan").textContent = "加载中…";
  syncHash(true);                                // 进详情页就把它写进地址栏
  loadPart(ticker, function (ok) {
    if (cur.ticker !== ticker) return;           // 用户已经点去别的标的了
    if (!ok) { $("#valSpan").textContent = "这只标的的历史数据加载失败"; return; }
    redrawDetail();
  });
}

/* 把基准标的的序列按日期对齐到当前标的的日期轴上 */
function alignTo(dates, baseTicker, key) {
  var bp = PARTS[baseTicker];
  if (!bp) return null;
  var bd = expandDates(bp), bv = bp[key] || [];
  var pos = {};
  for (var i = 0; i < bd.length; i++) pos[bd[i]] = i;
  return dates.map(function (d) {
    var i = pos[d];
    return (i === undefined) ? null : bv[i];
  });
}

function redrawDetail() {
  var part = PARTS[cur.ticker];
  if (!part) return;
  var dates = expandDates(part);
  var s = part;

  var MTS = metricsFor(cur.ticker);
  if (!MTS.some(function (x) { return x.key === cur.metric; })) cur.metric = MTS[0].key;
  var metNow = MTS.filter(function (x) { return x.key === cur.metric; })[0];
  if (metNow && metNow.base) {
    if (cur.ticker === metNow.base) {           // 自己跟自己比没意义
      cur.metric = "pe";
    } else if (!PARTS[metNow.base]) {           // 基准分片还没下，先下再画
      $("#valSpan").textContent = "加载基准（" + metNow.base + "）…";
      loadPart(metNow.base, function (ok) {
        if (ok && cur.metric === metNow.key) redrawDetail();
        else if (!ok) $("#valSpan").textContent = "基准数据加载失败";
      });
      return;
    }
  }
  var met = MTS.filter(function (x) { return x.key === cur.metric; })[0];
  var rng = RANGES.filter(function (x) { return x.key === cur.range; })[0] || null;

  seg($("#valMetrics"), MTS, function (it) { return it.key === cur.metric; },
      function (it) { cur.metric = it.key; redrawDetail(); syncHash(false); });
  seg($("#valRanges"), RANGES, function (it) { return it.key === cur.range; },   // custom 时一个都不亮
      function (it) { cur.range = it.key; cur.i0 = null; cur.i1 = null; redrawDetail(); syncHash(false); });
  seg($("#valToggles"),
      [{ key: "px", label: "叠加股价" }, { key: "anc", label: "标财季末" }],
      function (it) { return it.key === "px" ? showPrice : showAnchors; },
      function (it) {
        if (it.key === "px") showPrice = !showPrice; else showAnchors = !showAnchors;
        redrawDetail();
      });
  seg($("#valExport"),
      [{ key: "csv", label: "导出 CSV" }, { key: "png", label: "存图" }],
      function () { return false; },
      function (it) { it.key === "csv" ? exportCsv() : exportPng(); });

  var vals;
  if (met.base) {
    var mine = s.pe || [], theirs = alignTo(dates, met.base, "pe");
    vals = mine.map(function (v, i) {
      var b = theirs ? theirs[i] : null;
      if (v == null || b == null || b <= 0 || v <= 0) return null;
      return Math.round(v / b * 1000) / 1000;
    });
  } else {
    vals = s[met.key] || [];
  }
  var i0, i1;
  if (cur.i0 != null && cur.i1 != null) {       // 用户拖过区间刷，以它为准
    i0 = Math.max(0, Math.min(cur.i0, dates.length - 2));
    i1 = Math.max(i0 + 1, Math.min(cur.i1, dates.length - 1));
  } else {
    i0 = rangeIdx(dates, rng ? rng.years : null);
    i1 = dates.length - 1;
  }
  cur.i0 = i0; cur.i1 = i1;

  var spanLabel = rng ? rng.label : "自定义";
  $("#valSpan").textContent = spanLabel + " · " + dates[i0] + " — " + dates[i1] +
                              "（" + (i1 - i0 + 1) + " 个交易日）";
  $("#trendNote").textContent = met.label + " 走势";

  // 该指标在这个区间里一个有效值都没有（例如前瞻市盈率只有约 5 年，切到 20Y 的早段）
  var any = false;
  for (var i = i0; i <= i1; i++) if (vals[i] !== null && vals[i] !== undefined) { any = true; break; }

  pctSeries = any ? rollingPct(vals, i0, i1) : [];
  // 分位序列只覆盖区间，补齐成全长数组，Plot 才能按 r0/r1 切片
  var full = new Array(dates.length);
  for (var k = 0; k < dates.length; k++) full[k] = (k >= i0 && any) ? pctSeries[k - i0] : null;

  var curVal = any ? lastValid(vals.slice(i0, i1 + 1)) : null;
  var firstVal = any ? firstValid(vals.slice(i0, i1 + 1)) : null;
  var curPct = any ? lastValid(pctSeries) : null;
  var st = statusOf(curPct, curVal !== null && curVal < 0);

  $("#kpi1k").textContent = met.kpi;
  $("#kpi1v").textContent = curVal === null ? "无数据"
    : (met.base ? fmt(curVal) + "×大盘" : fmt(curVal) + met.unit);
  $("#kpi2v").textContent = curPct === null ? "样本不足" : curPct + "%";
  $("#kpi3v").textContent = st.txt;
  $("#kpi3v").style.color = st.cls === "cheap" ? "var(--cheap)"
                          : st.cls === "rich" ? "var(--rich)"
                          : st.cls === "fair" ? "var(--ink)" : "var(--ink3)";
  var chg = (curVal !== null && firstVal !== null && firstVal !== 0)
            ? (curVal / firstVal - 1) * 100 : null;
  $("#kpi4v").textContent = chg === null ? "—" : (chg > 0 ? "+" : "") + chg.toFixed(2) + "%";

  $("#posVal").textContent = curPct === null ? "样本不足" : curPct + "%";
  var knob = $("#posKnob");
  knob.style.display = curPct === null ? "none" : "block";
  if (curPct !== null) knob.style.left = curPct + "%";

  viewCtx = { dates: dates, vals: vals, pct: pctSeries || [], i0: i0, i1: i1, met: met };
  renderBrush(dates, vals, i0, i1);
  hideCursorTip();

  trendPlot.o.series = [{ data: vals, color: "--accent",
                          extrap: expandFlags((part.extrap || {})[met.key], dates.length) }];
  if (showPrice && part.px) {
    // 价格走右轴：股价两三百块、市盈率二三十倍，塞进同一根轴市盈率会被压成直线
    trendPlot.o.series.push({ data: part.px, color: "--pctline", axis: "right" });
  }
  trendPlot.o.yfmt2 = function (v) { return "$" + (v >= 100 ? Math.round(v) : v.toFixed(1)); };
  // 财季末竖线。注意这是**财季结束日**，不是财报发布日——后者通常还要晚三到六周。
  trendPlot.o.vmarks = (showAnchors && part.anchors)
    ? part.anchors.filter(function (i) { return i >= i0 && i <= i1; })
                  .map(function (i) { return dates[i]; })
    : null;
  pctPlot.o.series[0].data = full;
  window.VPlot.setDates(dates);
  window.VPlot.setRange(i0, i1);
  trendPlot.render();
  pctPlot.render();

  var p10 = ((D.meta[cur.ticker].pct10y) || {})[met.key] || {};
  if (met.base) p10 = {};     // 相对估值是前端现算的，没有预存的固定十年分位
  renderWhatIf(vals, i0, i1, met, curVal, curPct);
  runBacktest();

  var kindNote = D.meta[cur.ticker].note ? ("口径：" + D.meta[cur.ticker].note + "<br>") : "";
  $("#valDetailFoot").innerHTML = kindNote +
    "「百分位（当前区间）」= 当前值在 <b>" + spanLabel + "</b> 这段里的排名，换区间就会变；" +
    "估值卡上那个是固定十年窗口的分位（本指标为 " +
    (p10.pct === null || p10.pct === undefined ? "样本不足" : p10.pct + "%，覆盖 " + p10.years + " 年") +
    "），两者不是同一个数。<br>" +
    "负市盈率（盈利为负）照常画进走势图，但不参与分位排名，分位曲线在那段留空。" +
    (cur.metric === "fwd_pe" ? "<br>前瞻市盈率的历史只有约 5 年（免费源上限），切到更长区间时早段是空的。" : "");
}

/* ---------------- 十字准星与数值气泡 ----------------
 * Plot 自带 cursor()（在上层 canvas 上画竖线和圆点），这里把鼠标位置换算成数据下标，
 * 让两张图同步显示同一天，再把那天的数字浮在图上。
 */
var viewCtx = null;      // { dates, vals, pct, i0, i1, met } 由 redrawDetail 填

function fmtDay(iso) { return iso; }

function moveCursor(plot, clientX) {
  if (!viewCtx) return;
  var box = plot.el.getBoundingClientRect();
  var i = plot.iOf(clientX - box.left);
  window.VPlot.state.cur = i;
  trendPlot.cursor();
  pctPlot.cursor();
  showCursorTip(i);
}

function showCursorTip(i) {
  var c = viewCtx;
  if (!c || i < c.i0 || i > c.i1) return hideCursorTip();
  var v = c.vals[i], p = (i - c.i0 >= 0) ? c.pct[i - c.i0] : null;
  place($("#tipTrend"), trendPlot, i, v == null ? null : v,
        "<div class='dt'>" + c.dates[i] + "</div><b>" +
        (v == null ? "—" : v.toFixed(2) + c.met.unit) + "</b>");
  place($("#tipPct"), pctPlot, i, p == null ? null : p,
        "<div class='dt'>" + c.dates[i] + "</div><b>" +
        (p == null ? "—" : p.toFixed(1) + "%") + "</b>");
}

function place(tip, plot, i, v, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  var x = plot.xOf(i), y = (v == null ? plot.h / 2 : plot.yOf(v));
  var w = tip.offsetWidth, h = tip.offsetHeight;
  // 靠右侧时气泡翻到左边，免得被图边裁掉
  tip.style.left = Math.max(2, Math.min(plot.w - w - 2, x + (x > plot.w - w - 20 ? -w - 12 : 12))) + "px";
  tip.style.top = Math.max(2, Math.min(plot.h - h - 2, y - h - 10)) + "px";
}

function hideCursorTip() {
  $("#tipTrend").hidden = true;
  $("#tipPct").hidden = true;
  var g = trendPlot && trendPlot.over.getContext("2d");
  if (g) g.clearRect(0, 0, trendPlot.w, trendPlot.h);
  var g2 = pctPlot && pctPlot.over.getContext("2d");
  if (g2) g2.clearRect(0, 0, pctPlot.w, pctPlot.h);
}

function bindCursor() {
  [["#p-val", function () { return trendPlot; }],
   ["#p-valpct", function () { return pctPlot; }]].forEach(function (pair) {
    var el = $(pair[0]);
    el.addEventListener("pointermove", function (e) { moveCursor(pair[1](), e.clientX); });
    el.addEventListener("pointerleave", hideCursorTip);
    el.addEventListener("touchmove", function (e) {
      if (e.touches[0]) { moveCursor(pair[1](), e.touches[0].clientX); e.preventDefault(); }
    }, { passive: false });
  });
}

/* ---------------- 区间刷 ----------------
 * 底下那条小图画的是「全历史」的走势轮廓，绿色选区就是当前看的那段。
 * 拖手柄改起止，拖选区整体平移；点区间按钮会把它复位到那个预设。
 */
var brushDrag = null;

function renderBrush(dates, vals, i0, i1) {
  var box = $("#valBrush"), cv = $("#brushMini");
  var w = box.clientWidth, h = box.clientHeight;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  var g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  var lo = Infinity, hi = -Infinity;
  for (var k = 0; k < vals.length; k++) {
    var v = vals[k];
    if (v == null || v <= 0) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo < hi) {
    g.strokeStyle = window.VPlot.cssv("--accent-d") || "#1f9c73";
    g.lineWidth = 1;
    g.beginPath();
    var started = false;
    for (var j = 0; j < vals.length; j++) {
      var y = vals[j];
      if (y == null || y <= 0) { started = false; continue; }
      var px = w * j / Math.max(1, vals.length - 1);
      var py = h - 4 - (h - 8) * (y - lo) / (hi - lo);
      if (started) g.lineTo(px, py); else { g.moveTo(px, py); started = true; }
    }
    g.stroke();
  }
  var sel = $("#brushSel");
  sel.style.left = (100 * i0 / Math.max(1, vals.length - 1)) + "%";
  sel.style.width = (100 * (i1 - i0) / Math.max(1, vals.length - 1)) + "%";
}

function brushIndexAt(clientX, n) {
  var box = $("#valBrush").getBoundingClientRect();
  var t = (clientX - box.left) / Math.max(1, box.width);
  return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
}

function bindBrush() {
  var box = $("#valBrush");
  function start(kind) {
    return function (e) {
      if (!viewCtx) return;
      brushDrag = { kind: kind, n: viewCtx.dates.length,
                    i0: cur.i0, i1: cur.i1,
                    from: brushIndexAt(e.clientX, viewCtx.dates.length) };
      box.setPointerCapture && box.setPointerCapture(e.pointerId);
      e.preventDefault(); e.stopPropagation();
    };
  }
  $("#brushSel").querySelector(".hl").addEventListener("pointerdown", start("l"));
  $("#brushSel").querySelector(".hr").addEventListener("pointerdown", start("r"));
  $("#brushSel").addEventListener("pointerdown", start("move"));

  // 在选区外面按下拖动 = 直接框出一段新区间（标准的 brush 行为，不用先把选区拖过去）
  box.addEventListener("pointerdown", function (e) {
    if (brushDrag || !viewCtx) return;
    var n = viewCtx.dates.length;
    brushDrag = { kind: "new", n: n, i0: cur.i0, i1: cur.i1,
                  anchor: brushIndexAt(e.clientX, n) };
    box.setPointerCapture && box.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  box.addEventListener("pointermove", function (e) {
    if (!brushDrag || !viewCtx) return;
    var n = brushDrag.n, i = brushIndexAt(e.clientX, n), MIN = 30;
    var a = cur.i0, b = cur.i1;
    if (brushDrag.kind === "new") {
      a = Math.min(brushDrag.anchor, i);
      b = Math.max(brushDrag.anchor, i);
      if (b - a < MIN) b = Math.min(n - 1, a + MIN);
    }
    else if (brushDrag.kind === "l") a = Math.min(i, b - MIN);
    else if (brushDrag.kind === "r") b = Math.max(i, a + MIN);
    else {
      var d = i - brushDrag.from, span = brushDrag.i1 - brushDrag.i0;
      a = Math.max(0, Math.min(n - 1 - span, brushDrag.i0 + d));
      b = a + span;
    }
    a = Math.max(0, a); b = Math.min(n - 1, b);
    if (a === cur.i0 && b === cur.i1) return;
    cur.i0 = a; cur.i1 = b; cur.range = "custom";
    redrawDetail();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) {
    box.addEventListener(ev, function () { brushDrag = null; });
  });
}

/* ---------------- 目标估值反推 ----------------
 *
 * 问题：「其他都不变，我想让估值百分位回到 X%，股价得是多少？」
 *
 * 「其他不变」= 每股收益（或每股净资产）不变，只有股价动。于是：
 *     目标估值 = 当前区间里 X% 分位对应的那个倍数
 *     目标股价 = 当前股价 × (目标估值 ÷ 当前估值)
 * 这个式子对 PE / Forward PE / PB 都成立，也不需要知道每股收益本身是多少。
 *
 * 对 QQQ / VOO 这种指数口径的标的，估值是指数的、股价是 ETF 的，两者同比例变动，
 * 所以式子照样成立——它给的是「纳指100 估值回到 X% 时 QQQ 大概多少钱」。
 */
var wiState = null;

function quantile(sortedArr, p) {
  if (!sortedArr.length) return null;
  if (sortedArr.length === 1) return sortedArr[0];
  var idx = (p / 100) * (sortedArr.length - 1);
  var lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

function renderWhatIf(vals, i0, i1, met, curVal, curPct) {
  var box = $("#whatif"), slider = $("#wiSlider");
  var px = D.meta[cur.ticker].px;
  var seg = [];
  for (var i = i0; i <= i1; i++) {
    var v = vals[i];
    if (v !== null && v !== undefined && v > 0) seg.push(v);
  }
  seg.sort(function (a, b) { return a - b; });

  // 负估值、没有价格、样本太少，都没法反推——这时把面板整个关掉，而不是给个假数字
  if (met.base || !px || seg.length < 30 || curVal === null || curVal <= 0) {
    box.hidden = true;
    wiState = null;
    return;
  }
  box.hidden = false;
  wiState = { seg: seg, px: px, curVal: curVal, met: met,
              pxDate: D.meta[cur.ticker].px_date };
  slider.value = (curPct === null ? 50 : curPct);
  updateWhatIf();
}

function updateWhatIf() {
  if (!wiState) return;
  var p = parseFloat($("#wiSlider").value);
  var target = quantile(wiState.seg, p);
  var px = wiState.px * (target / wiState.curVal);
  var chg = (px / wiState.px - 1) * 100;

  $("#wiPct").textContent = p.toFixed(1) + "%";
  $("#wiRatio").textContent = target.toFixed(2) + wiState.met.unit;
  $("#wiPx").textContent = "$" + px.toFixed(2);
  var el = $("#wiChg");
  el.textContent = (chg > 0 ? "+" : "") + chg.toFixed(1) + "%";
  el.className = "v " + (Math.abs(chg) < 0.05 ? "" : chg > 0 ? "up" : "down");

  $("#wiFoot").textContent =
    "现价 $" + wiState.px.toFixed(2) + "（" + wiState.pxDate + "），当前 " +
    wiState.met.label + " " + wiState.curVal.toFixed(2) + wiState.met.unit +
    "。分位取自当前所选区间内的 " + wiState.seg.length + " 个有效交易日，" +
    "换区间会换一套分布，算出来的价格也会变。";
}

$("#wiSlider").addEventListener("input", updateWhatIf);
$("#btTh").addEventListener("input", function () {
  btTh = parseInt($("#btTh").value, 10);
  runBacktest();
});

/* ---------------- 亮 / 暗切换 ----------------
 * 整站一套变量：:root 是亮色，html[data-theme="dark"] 覆盖成暗色，
 * 估值面板在亮色模式下另有一组浅色变量（见 viewer.html 的样式）。
 * canvas 上的颜色是每次重绘时从 CSS 变量读的，所以切换后重画一遍就行。
 */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  var btn = document.getElementById("theme");
  if (btn) {
    btn.textContent = t === "dark" ? "☀" : "🌙";
    btn.title = t === "dark" ? "切到亮色" : "切到暗色";
  }
  try { localStorage.setItem("sv_theme", t); } catch (e) { /* 隐私模式下写不了，无所谓 */ }
  if (trendPlot && !$("#valDetail").hidden) { trendPlot.render(); pctPlot.render(); }
  window.dispatchEvent(new Event("resize"));   // 信号页那张主图也重画
}

(function initTheme() {
  var saved = null;
  try { saved = localStorage.getItem("sv_theme"); } catch (e) { /* 同上 */ }
  if (!saved) {
    saved = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark" : "light";
  }
  applyTheme(saved);
  var btn = document.getElementById("theme");
  if (btn) btn.addEventListener("click", function () {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
})();

/* ---------------- 估值择时回测 ----------------
 *
 * 回答的问题：「历史上估值分位跌破 X% 的那些日子买进去，拿 1 / 3 / 5 年，后来赚不赚」。
 *
 * 几条为了不骗自己而定的规矩：
 * 1. 分位用**固定十年窗口的滚动分位**，每一天只看那天之前的十年——不是拿全历史算完
 *    再回头套，那样等于用了未来数据，回测会漂亮得离谱。
 * 2. 只统计「上一天还在阈值之上、这一天跌破」的那一刻（首次穿越），不是每个低于阈值的
 *    日子都算一次。否则一段长时间的低估会被重复计上百次，样本量是假的。
 * 3. 持有期不够长的触发点直接不计入，不用「截至今天的收益」凑数。
 * 4. 收益是价格收益，不含分红，也没有扣税费。
 */
var btTh = 20, btWin = 252;
var btScatterPts = [];

/* 固定窗口的滚动分位：第 i 天只跟它之前 win 个有效观测比 */
function rollingFixedPct(vals, win) {
  var out = new Array(vals.length).fill(null), sorted = [], queue = [];
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    if (v === null || v === undefined || v <= 0) continue;
    sorted.splice(bisectLeft(sorted, v), 0, v);
    queue.push(v);
    if (queue.length > win) {
      var old = queue.shift();
      var k = bisectLeft(sorted, old);
      if (sorted[k] === old) sorted.splice(k, 1);
    }
    if (queue.length < 250) continue;      // 样本不足一年不出数
    var lo = bisectLeft(sorted, v), hi = bisectRight(sorted, v);
    out[i] = Math.round(1000 * ((lo + hi) / 2) / sorted.length) / 10;
  }
  return out;
}

function runBacktest() {
  var part = PARTS[cur.ticker];
  var card = $("#btCard");
  if (!part || !part.px || !viewCtx) { card.hidden = true; return; }
  var met = viewCtx.met;
  // 相对估值是现算的比值，名义金价的分位没有意义，这两类不做回测
  if (met.base || met.key === "nominal") { card.hidden = true; return; }
  var vals = viewCtx.vals, px = part.px, dates = viewCtx.dates;
  var pct = rollingFixedPct(vals, 2520);   // 十年窗口

  seg($("#btWin"), [{ key: 252, label: "持有 1 年" }, { key: 756, label: "3 年" },
                    { key: 1260, label: "5 年" }],
      function (it) { return it.key === btWin; },
      function (it) { btWin = it.key; runBacktest(); });
  $("#btThVal").textContent = btTh + "%";

  var hits = [], all = [];
  for (var i = 1; i < pct.length; i++) {
    if (pct[i] === null) continue;
    var j = i + btWin;
    if (j >= px.length) break;             // 持有期还没走完的不计入
    var p0 = px[i], p1 = px[j];
    if (!p0 || !p1) continue;
    var ret = (p1 / p0 - 1) * 100;
    all.push({ pct: pct[i], ret: ret, i: i });
    if (pct[i] < btTh && pct[i - 1] !== null && pct[i - 1] >= btTh) {
      hits.push({ d: dates[i], pct: pct[i], ret: ret });
    }
  }
  btScatterPts = all;
  card.hidden = false;

  function stat(arr) {
    if (!arr.length) return null;
    var v = arr.slice().sort(function (a, b) { return a - b; });
    var mean = arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
    var med = v.length % 2 ? v[(v.length - 1) / 2]
                           : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
    var win = arr.filter(function (x) { return x > 0; }).length / arr.length * 100;
    return { n: arr.length, mean: mean, med: med, win: win,
             lo: v[0], hi: v[v.length - 1] };
  }
  var hs = stat(hits.map(function (h) { return h.ret; }));
  var bs = stat(all.map(function (a) { return a.ret; }));
  var yrs = (btWin / 252).toFixed(0);

  function row(label, s2, hi) {
    if (!s2) return "<tr><td>" + esc(label) + "</td><td colspan='4' style='color:var(--ink3)'>样本不足</td></tr>";
    var c = s2.mean > 0 ? "var(--cheap)" : "var(--rich)";
    return "<tr><td>" + esc(label) + (hi ? "" : "") + "</td>" +
      "<td class='r'>" + s2.n + "</td>" +
      "<td class='r' style='color:" + c + ";font-weight:600'>" + s2.mean.toFixed(1) + "%</td>" +
      "<td class='r'>" + s2.med.toFixed(1) + "%</td>" +
      "<td class='r'>" + s2.win.toFixed(0) + "%</td></tr>";
  }
  $("#btTable").innerHTML =
    "<tr><th>买入时机</th><th class='r'>样本</th><th class='r'>平均收益</th>" +
    "<th class='r'>中位</th><th class='r'>胜率</th></tr>" +
    row("分位跌破 " + btTh + "% 那天", hs, true) +
    row("任意一天（基准）", bs, false);

  var edge = (hs && bs) ? (hs.mean - bs.mean) : null;
  $("#btNote").innerHTML =
    "持有 " + yrs + " 年的价格收益，不含分红、不计税费。" +
    (hs ? "跌破阈值共触发 <b>" + hs.n + "</b> 次" +
          (edge !== null ? "，比「任意一天买入」平均多 <b style='color:" +
           (edge > 0 ? "var(--cheap)" : "var(--rich)") + "'>" +
           (edge > 0 ? "+" : "") + edge.toFixed(1) + " 个百分点</b>" : "") + "。"
        : "这个阈值下没有足够的历史样本。") +
    "<br>分位是固定十年窗口的滚动值，每天只看它之前的十年，没有用未来数据；" +
    "只统计「上一天还在阈值之上、这天跌破」的那一刻，不是每个低估的日子都算一次。" +
    (hs && hs.n < 8 ? "<br><b>样本只有 " + hs.n + " 次，统计上说明不了什么，看看就好。</b>" : "");

  drawScatter();
}

function drawScatter() {
  var cv = $("#btScatter");
  var box = cv.parentNode.getBoundingClientRect();
  var w = box.width, h = box.height;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  var g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  var pts = btScatterPts;
  if (!pts.length) return;

  var pad = { l: 44, r: 8, t: 8, b: 22 };
  var rets = pts.map(function (p) { return p.ret; }).sort(function (a, b) { return a - b; });
  // 上下各裁 1%，免得个别极端点把其余的压成一条线
  var lo = rets[Math.floor(rets.length * 0.01)], hi = rets[Math.floor(rets.length * 0.99)];
  if (lo === hi) { lo -= 1; hi += 1; }
  var X = function (p) { return pad.l + (w - pad.l - pad.r) * p / 100; };
  var Y = function (r) {
    var t = (Math.max(lo, Math.min(hi, r)) - lo) / (hi - lo);
    return pad.t + (h - pad.t - pad.b) * (1 - t);
  };
  var ink3 = window.VPlot.cssv("--ink3") || "#6b7685";
  var grid = window.VPlot.cssv("--line") || "#262d38";

  g.strokeStyle = grid; g.lineWidth = 1;
  g.font = '10px "IBM Plex Mono", monospace'; g.textBaseline = "middle";
  [0, 25, 50, 75, 100].forEach(function (p) {
    g.beginPath(); g.moveTo(X(p) + .5, pad.t); g.lineTo(X(p) + .5, h - pad.b); g.stroke();
    g.fillStyle = ink3; g.textAlign = "center";
    g.fillText(p + "%", X(p), h - pad.b + 10);
  });
  [lo, (lo + hi) / 2, hi].forEach(function (r) {
    g.beginPath(); g.moveTo(pad.l, Y(r) + .5); g.lineTo(w - pad.r, Y(r) + .5); g.stroke();
    g.fillStyle = ink3; g.textAlign = "right";
    g.fillText(Math.round(r) + "%", pad.l - 6, Y(r));
  });
  if (lo < 0 && hi > 0) {   // 零轴画粗一点，一眼看出赚还是亏
    g.strokeStyle = ink3; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(pad.l, Y(0) + .5); g.lineTo(w - pad.r, Y(0) + .5); g.stroke();
  }
  pts.forEach(function (p) {
    var c = pctColor(p.pct);
    g.fillStyle = c.fg;
    g.globalAlpha = .28;
    g.beginPath(); g.arc(X(p.pct), Y(p.ret), 1.7, 0, 7); g.fill();
  });
  g.globalAlpha = 1;
  // 阈值线
  g.strokeStyle = window.VPlot.cssv("--accent") || "#2fd39b";
  g.setLineDash([3, 3]); g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(X(btTh) + .5, pad.t); g.lineTo(X(btTh) + .5, h - pad.b); g.stroke();
  g.setLineDash([]);
}

/* ---------------- 导出 ---------------- */

function download(name, blob) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function exportCsv() {
  if (!viewCtx) return;
  var c = viewCtx, part = PARTS[cur.ticker] || {};
  var head = ["date", c.met.key, "rolling_pct_in_range", "close"];
  var lines = [head.join(",")];
  for (var i = c.i0; i <= c.i1; i++) {
    var v = c.vals[i], p = c.pct[i - c.i0], px = (part.px || [])[i];
    lines.push([c.dates[i],
                v == null ? "" : v,
                p == null ? "" : p,
                px == null ? "" : px].join(","));
  }
  // 开头写一行注释交代口径，免得单独一个 CSV 传出去之后没人说得清这些数是怎么算的
  var note = "# " + cur.ticker + " " + c.met.label +
             "；分位是这段区间内的滚动百分位，换区间会变；" +
             "市盈率的分子是当日收盘价、分母是季度财报锚点插值出来的每股收益；" +
             "数据生成于 " + D.built + "\n";
  download(cur.ticker + "_" + c.met.key + "_" + c.dates[c.i0] + "_" + c.dates[c.i1] + ".csv",
           new Blob(["\ufeff" + note + lines.join("\n")],
                    { type: "text/csv;charset=utf-8" }));
}

function exportPng() {
  if (!trendPlot || $("#valDetail").hidden) return;
  var pad = 16, gap = 14, headH = 44, footH = 26;
  var w = trendPlot.w + pctPlot.w + gap + pad * 2;
  var h = Math.max(trendPlot.h, pctPlot.h) + headH + footH + pad * 2;
  var cv = document.createElement("canvas");
  var dpr = 2;
  cv.width = w * dpr; cv.height = h * dpr;
  var g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = window.VPlot.cssv("--panel") || "#161b22";
  g.fillRect(0, 0, w, h);

  var m = D.meta[cur.ticker] || {};
  g.fillStyle = window.VPlot.cssv("--ink") || "#e6edf7";
  g.font = "600 16px system-ui, sans-serif";
  g.fillText((m.name || cur.ticker) + "  " + cur.ticker, pad, pad + 16);
  g.fillStyle = window.VPlot.cssv("--ink3") || "#6b7685";
  g.font = "12px system-ui, sans-serif";
  g.fillText(viewCtx.met.label + " · " + $("#valSpan").textContent, pad, pad + 34);

  g.drawImage(trendPlot.base, pad, pad + headH, trendPlot.w, trendPlot.h);
  g.drawImage(pctPlot.base, pad + trendPlot.w + gap, pad + headH, pctPlot.w, pctPlot.h);

  g.fillStyle = window.VPlot.cssv("--ink3") || "#6b7685";
  g.font = "11px system-ui, sans-serif";
  g.fillText("左：估值走势　右：区间滚动分位　·　数据生成于 " + D.built +
             "　·　只呈现公开数据，不构成投资建议",
             pad, h - pad - 2);

  cv.toBlob(function (blob) {
    if (blob) download(cur.ticker + "_" + viewCtx.met.key + "_" + D.built + ".png", blob);
  }, "image/png");
}

/* ---------------- 地址栏路由 ----------------
 *
 * 把「现在看的是什么」写进 URL 的 # 后面，这样：
 *   · 可以把某一只标的、某个视图的链接直接发给别人，对方打开就是同一个画面
 *   · 浏览器的前进/后退能用
 *   · 刷新之后还停在原处，不会被打回卡片墙
 *   · 能加书签
 *
 * 形式：
 *   #cards / #heat / #cmp / #pf   估值面板的四个视图
 *   #t/NVDA                       某只标的的详情
 *   #t/NVDA/pb/10y                连指标和区间一起带上
 *   #signal                       低点信号页
 *
 * 切视图、进详情用 pushState（后退键有用）；调指标和区间用 replaceState，
 * 免得拖一下区间刷就往历史里塞几十条记录。
 */
var routing = false;      // 正在按 URL 布置画面，这期间不要反过来改 URL

function currentHash() {
  if (!$("#view-val").hidden && !$("#valDetail").hidden && cur.ticker) {
    return "#t/" + encodeURIComponent(cur.ticker) + "/" + cur.metric + "/" + cur.range;
  }
  if ($("#view-val").hidden) return "#signal";
  return "#" + view;
}

function syncHash(push) {
  if (routing) return;
  var h = currentHash();
  if (location.hash === h) return;
  try {
    if (push) history.pushState(null, "", h);
    else history.replaceState(null, "", h);
  } catch (e) {
    location.hash = h;      // file:// 下 history API 可能不让用
  }
}

function applyHash() {
  var raw = (location.hash || "").replace(/^#\/?/, "");
  routing = true;
  try {
    if (raw === "signal") { showTab("signal"); return; }
    var m = raw.match(/^t\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (m) {
      var t = decodeURIComponent(m[1]).toUpperCase();
      if (D.meta[t]) {
        if (m[2]) cur.metric = m[2];
        if (m[3]) { cur.range = m[3]; cur.i0 = null; cur.i1 = null; }
        showTab("val");
        openDetail(t);
        return;
      }
    }
    if (["cards", "heat", "cmp", "pf"].indexOf(raw) >= 0) view = raw;
    showTab("val");
    $("#valDetail").hidden = true;
    $("#valGrid").hidden = false;
    $("#macroBar").hidden = false;
    renderGrid();
  } finally {
    routing = false;
  }
}

window.addEventListener("hashchange", applyHash);

/* ---------------- 页签切换 ---------------- */

/* 「低点信号」那套数据有 2.8 MB，是整个页面里最重的东西，而且只有那个页签用得上。
   所以首屏不下它，等用户真点过去的时候再按顺序插入 viewer_data.js → viewer.js。
   期间显示加载提示，不留空白。 */
var signalState = "idle";     // idle / loading / ready / failed

function loadSignalApp(done) {
  if (signalState === "ready") return done(true);
  if (signalState === "loading") return;
  signalState = "loading";
  var boot = document.getElementById("boot");
  if (boot) boot.hidden = false;
  function addScript(src, next) {
    var el = document.createElement("script");
    el.src = src;
    el.onload = next;
    el.onerror = function () {
      signalState = "failed";
      if (boot) boot.textContent = "行情数据加载失败，刷新页面再试一次";
      done(false);
    };
    document.head.appendChild(el);
  }
  addScript("viewer_data.js", function () {
    addScript("viewer.js", function () {
      signalState = "ready";
      if (boot) boot.hidden = true;
      done(true);
    });
  });
}

function showTab(which) {
  var sig = which === "signal";
  wrap.hidden = sig;
  document.getElementById("tabSignal").className = sig ? "on" : "";
  document.getElementById("tabVal").className = sig ? "" : "on";
  if (!sig) {
    document.getElementById("view-signal").hidden = true;
    var boot = document.getElementById("boot");
    if (boot && signalState !== "loading") boot.hidden = true;
    if (trendPlot && !$("#valDetail").hidden) { trendPlot.render(); pctPlot.render(); }
    return;
  }
  loadSignalApp(function (ok) {
    if (!ok || document.getElementById("tabSignal").className !== "on") return;
    document.getElementById("view-signal").hidden = false;
    window.dispatchEvent(new Event("resize"));   // 让主图按真实宽度重画
  });
}

document.getElementById("tabSignal").addEventListener("click", function () {
  showTab("signal"); syncHash(true);
});
document.getElementById("tabVal").addEventListener("click", function () {
  showTab("val"); syncHash(true);
});
$("#valBack").addEventListener("click", function (e) {
  e.preventDefault();
  $("#valDetail").hidden = true;
  $("#valGrid").hidden = false;
  $("#macroBar").hidden = false;
  syncHash(true);
});

var rt;
window.addEventListener("resize", function () {
  clearTimeout(rt);
  rt = setTimeout(function () {
    if (!wrap.hidden && trendPlot && !$("#valDetail").hidden) { trendPlot.render(); pctPlot.render(); }
  }, 120);
});

$("#pfCalc").addEventListener("click", renderPortfolio);
$("#pfDemo").addEventListener("click", function () {
  $("#pfInput").value = PF_DEMO;
  renderPortfolio();
});
$("#pfClear").addEventListener("click", function () {
  $("#pfInput").value = "";
  try { localStorage.removeItem("sv_pf"); } catch (e) { /* 隐私模式 */ }
  renderPortfolio();
});
// 持仓存本地，刷新不用重填（只在这台浏览器里，不会上传）
$("#pfInput").addEventListener("input", function () {
  try { localStorage.setItem("sv_pf", $("#pfInput").value); } catch (e) { /* 同上 */ }
});
try {
  var savedPf = localStorage.getItem("sv_pf");
  if (savedPf) $("#pfInput").value = savedPf;
} catch (e) { /* 同上 */ }

renderGrid();
if (location.hash) applyHash();

/* 给 tests/test_valuation.py 用 */
window.__valRollingPct = rollingPct;
})();
