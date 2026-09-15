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

var D = window.VAL_DATA;
if (!D) return;

var $ = function (s) { return document.querySelector(s); };
var wrap = document.getElementById("view-val");
window.VPlot.root = wrap;   // 暗色变量在 #view-val 上，画图引擎要从这里读颜色

var METRICS = [
  { key: "pe",     label: "PE TTM",      kpi: "PE (TTM)",      unit: "×" },
  { key: "fwd_pe", label: "Forward PE",  kpi: "PE (Forward)",  unit: "×" },
  { key: "pb",     label: "PB",          kpi: "PB",            unit: "×" }
];
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

var cur = { ticker: null, metric: "pe", range: "5y" };
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
  el.innerHTML =
    '<div class="top"><span class="nm"></span><span class="badge na">仅当前值</span></div>' +
    '<div class="tk"></div>' +
    '<div class="big"><span class="lab">PE · TTM</span><span class="num"></span></div>' +
    '<div class="tri">' +
      '<div><div class="k">PB</div><div class="v b"></div></div>' +
      '<div><div class="k">持仓数</div><div class="v h"></div></div>' +
      '<div><div class="k">成立</div><div class="v i" style="font-size:12px"></div></div>' +
    '</div>' +
    '<div class="why"></div>';
  el.querySelector(".nm").textContent = m.name || ticker;
  el.querySelector(".tk").textContent = ticker + " · ETF";
  el.querySelector(".num").textContent = m.cur_pe || "—";
  el.querySelector(".b").textContent = m.cur_pb || "—";
  el.querySelector(".h").textContent = m.holdings || "—";
  el.querySelector(".i").textContent = m.inception || "—";
  el.querySelector(".why").textContent = "无历史分位：" + (m.note || "");
  return el;
}

function card(ticker) {
  var m = D.meta[ticker], d = D.data[ticker];
  var s = d.series;
  var pe = lastValid(s.pe), fwd = lastValid(s.fwd_pe), pb = lastValid(s.pb);
  var p10 = (d.pct10y && d.pct10y.pe) || {};
  var st = statusOf(p10.pct, p10.neg);
  var chg = d.pe_chg_1y;
  // 上市不足十年的标的，标签要写真实年限，不能照抄「近十年」
  var winTxt = (p10.years && p10.years < 9.5) ? ("近" + p10.years + "年") : "近十年";

  var el = document.createElement("div");
  el.className = "vc";
  el.innerHTML =
    '<div class="top"><span class="nm"></span><span class="badge ' + st.cls + '"></span></div>' +
    '<div class="tk"></div>' +
    '<div class="big"><span class="lab">PE · TTM</span><span class="num"></span></div>' +
    '<div class="tri">' +
      '<div><div class="k">PE · FWD</div><div class="v f"></div></div>' +
      '<div><div class="k">PB</div><div class="v b"></div></div>' +
      '<div><div class="k">PEG</div><div class="v g"></div></div>' +
    '</div>' +
    '<div class="kv"><span>1Y PE 变化</span><b class="c"></b></div>' +
    '<div class="kv"><span>PE 分位 · ' + winTxt + '</span><b class="p"></b></div>' +
    '<div class="gradbar" style="margin-top:8px"><div class="knob"></div></div>' +
    '<div class="kv"><span>市值 USD</span><b class="mc"></b></div>';

  el.querySelector(".nm").textContent = m.name || ticker;
  el.querySelector(".badge").textContent = st.txt;
  el.querySelector(".tk").textContent = ticker +
    ((m.kind && m.kind !== "stock") ? " · ETF / 指数" : " · 美股");
  el.querySelector(".num").textContent = fmt(pe);
  el.querySelector(".f").textContent = fmt(fwd);
  el.querySelector(".b").textContent = fmt(pb);
  var pegTxt = (m.peg && m.peg !== "n/a" && m.peg !== "N/A") ? m.peg : "—";
  el.querySelector(".g").textContent = pegTxt;
  var c = el.querySelector(".c");
  c.textContent = (chg === null || chg === undefined) ? "—" : (chg > 0 ? "+" : "") + chg + "%";
  c.className = "c " + (chg === null ? "" : chg < 0 ? "good" : "bad");
  el.querySelector(".p").textContent =
    p10.pct === null || p10.pct === undefined ? "样本不足" : p10.pct + "%";
  el.querySelector(".knob").style.left = (p10.pct === null || p10.pct === undefined ? 0 : p10.pct) + "%";
  if (p10.pct === null || p10.pct === undefined) el.querySelector(".knob").style.display = "none";
  el.querySelector(".mc").textContent = (m.mcap && m.mcap !== "n/a") ? m.mcap : "—";

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
  var m = D.meta[t] || {}, d = D.data[t];
  if (key === "mcap") return mcapNum(m.mcap);
  if (!d) return null;                       // 只有当前值的 ETF 没有历史，参与不了后两种排序
  var p10 = (d.pct10y && d.pct10y.pe) || {};
  if (key === "pct") return (p10.neg ? null : p10.pct);
  if (key === "pe") {
    var v = lastValid(d.series.pe);
    return (v === null || v < 0) ? null : v;  // 负市盈率不参与排序，见分位口径说明
  }
  return null;
}

function sortedTickers() {
  var all = Object.keys(D.meta);
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
  var box = $("#valCards");
  box.innerHTML = "";
  sortedTickers().forEach(function (t) {
    box.appendChild(D.data[t] ? card(t) : snapshotCard(t));
  });
  renderSortBar();
  $("#valBuilt").textContent = "数据生成于 " + D.built;
  $("#valGridFoot").innerHTML =
    "分位口径：估值卡上的「PE 分位」是<b>固定十年窗口</b>；点进详情页后的「百分位（当前区间）」" +
    "是<b>区间相对量</b>，会随 1Y/5Y/全部 的切换而变，两者本来就不是同一个数。<br>" +
    "日频市盈率的分子是真实当日收盘价，分母是季度财报锚点插值出来的每股收益（与本站其余页面同口径）。" +
    "每股收益、每股净资产来自 macrotrends（约 20 年季度锚点），前瞻市盈率来自 stockanalysis（约 5 年）。";
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

function openDetail(ticker) {
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
  }
  redrawDetail();
}

function redrawDetail() {
  var d = D.data[cur.ticker], s = d.series, dates = s.d;
  var met = METRICS.filter(function (x) { return x.key === cur.metric; })[0];
  var rng = RANGES.filter(function (x) { return x.key === cur.range; })[0];

  seg($("#valMetrics"), METRICS, function (it) { return it.key === cur.metric; },
      function (it) { cur.metric = it.key; redrawDetail(); });
  seg($("#valRanges"), RANGES, function (it) { return it.key === cur.range; },
      function (it) { cur.range = it.key; redrawDetail(); });

  var vals = s[met.key] || [];
  var i0 = rangeIdx(dates, rng.years), i1 = dates.length - 1;

  $("#valSpan").textContent = rng.label + " · " + dates[i0] + " — " + dates[i1];
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
  $("#kpi1v").textContent = curVal === null ? "无数据" : fmt(curVal) + met.unit;
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

  trendPlot.o.series[0].data = vals;
  trendPlot.o.series[0].extrap = (d.extrap && d.extrap[met.key]) || null;
  pctPlot.o.series[0].data = full;
  window.VPlot.setDates(dates);
  window.VPlot.setRange(i0, i1);
  trendPlot.render();
  pctPlot.render();

  var p10 = (d.pct10y && d.pct10y[met.key]) || {};
  var kindNote = D.meta[cur.ticker].note ? ("口径：" + D.meta[cur.ticker].note + "<br>") : "";
  $("#valDetailFoot").innerHTML = kindNote +
    "「百分位（当前区间）」= 当前值在 <b>" + rng.label + "</b> 这段里的排名，换区间就会变；" +
    "估值卡上那个是固定十年窗口的分位（本指标为 " +
    (p10.pct === null || p10.pct === undefined ? "样本不足" : p10.pct + "%，覆盖 " + p10.years + " 年") +
    "），两者不是同一个数。<br>" +
    "负市盈率（盈利为负）照常画进走势图，但不参与分位排名，分位曲线在那段留空。" +
    (cur.metric === "fwd_pe" ? "<br>前瞻市盈率的历史只有约 5 年（免费源上限），切到更长区间时早段是空的。" : "");
}

/* ---------------- 页签切换 ---------------- */

function showTab(which) {
  var sig = which === "signal";
  document.getElementById("view-signal").hidden = !sig;
  wrap.hidden = sig;
  document.getElementById("tabSignal").className = sig ? "on" : "";
  document.getElementById("tabVal").className = sig ? "" : "on";
  if (!sig && trendPlot && !$("#valDetail").hidden) { trendPlot.render(); pctPlot.render(); }
}

document.getElementById("tabSignal").addEventListener("click", function () { showTab("signal"); });
document.getElementById("tabVal").addEventListener("click", function () { showTab("val"); });
$("#valBack").addEventListener("click", function (e) {
  e.preventDefault();
  $("#valDetail").hidden = true;
  $("#valGrid").hidden = false;
});

var rt;
window.addEventListener("resize", function () {
  clearTimeout(rt);
  rt = setTimeout(function () {
    if (!wrap.hidden && trendPlot && !$("#valDetail").hidden) { trendPlot.render(); pctPlot.render(); }
  }, 120);
});

renderGrid();

/* 给 tests/test_valuation.py 用 */
window.__valRollingPct = rollingPct;
})();
