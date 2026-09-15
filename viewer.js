/* 股票查看器 —— 本地离线版
   数据来自 window.STOCK_DATA（scripts/build_viewer.py 生成）。
   所有指标在浏览器里实时计算，改参数即时重画。 */
(function () {
"use strict";

var DATA = window.STOCK_DATA;
/* 带 ?reset=1 打开就丢掉浏览器里存的信号配置，回到默认——
   改了默认配置后要让已经用过页面的浏览器看到新的，就用这个。 */
if (/[?&]reset=1/.test(location.search)) {
  try {
    ["sv_sigs", "sv_env", "sv_log", "sv_range", "sv_covwin"].forEach(function (k) {
      localStorage.removeItem(k);
    });
  } catch (e) { /* 无痕模式下会抛，忽略 */ }
}
var LANG = localStorage.getItem("sv_lang") || "zh";

/* ============ 文案 ============ */
var T = {
  title:       ["股票查看器", "Stock Viewer"],
  searchPh:    ["搜索股票代码…", "Search ticker…"],
  mCur:        ["当前价格", "Current price"],
  mChg:        ["总涨跌幅", "Total change"],
  mHigh:       ["最高价", "High"],
  mLow:        ["最低价", "Low"],
  mAvg:        ["平均价", "Average"],
  mSig:        ["信号触发", "Signals fired"],
  sigTitle:    ["信号", "Signals"],
  add:         ["添加", "Add"],
  noSig:       ["还没有添加信号。用上面的下拉框添加一个。", "No signals yet. Add one with the dropdown above."],
  hitsTitle:   ["触发记录（当前时间范围内）", "Triggers (within current range)"],
  noHits:      ["还没有启用任何信号。", "No signal enabled yet."],
  statTitle:   ["各信号的历史表现（全部历史，非当前时间范围）", "Historical performance of each signal (full history)"],
  statNote:    ["<b>怎么读这张表</b>：「触发后 N 日」是触发当天收盘买入、N 个交易日后卖出的平均收益；" +
                "「超额」是它减去同一标的在<b>任意一天</b>买入持有 N 日的平均收益。超额为正才说明这个信号带来了信息，" +
                "接近 0 或为负说明它不比闭眼买强。触发日之间高度重叠，这些平均值不是独立观察，不能当显著性看。",
                "<b>How to read</b>: “after N days” is the average return from buying at the close on a trigger day and " +
                "selling N trading days later. “Excess” subtracts the average return of buying on <b>any</b> day and holding " +
                "N days. Only a positive excess means the signal carried information. Trigger days overlap heavily, so these " +
                "averages are not independent observations and carry no significance claim."],
  statNote2:   ["「触发天数」是全部历史上的触发总数；收益列只用那些已经过了 N 个交易日的触发日来平均，" +
                "所以最近 N 天内的触发不进入收益平均。",
                "“Trigger days” counts every trigger in the full history; the return columns average only those triggers " +
                "that are already N trading days old, so the most recent N days are excluded from the averages."],
  watchTitle:  ["我的提醒", "My alarms"],
  noWatch:     ["暂无提醒。", "No alarms yet."],
  watchAddBtn: ["把当前配置存为提醒", "Save current setup as alarm"],
  watchNote:   ["提醒保存在这台电脑的浏览器里。每条提醒显示的是<b>最新一个交易日</b>是否满足条件。" +
                "要做成每天自动检查并发邮件，用 <code>watch/check_daily.py</code>（见 README）。",
                "Alarms are stored in this browser. Each row shows whether the <b>latest trading day</b> meets the condition. " +
                "For a daily automatic check by email, use <code>watch/check_daily.py</code> (see README)."],
  foot1:       ["指标在全部历史数据上计算，再按所选时间范围裁剪显示，所以切换范围不会改变任何一个触发点。" +
                "本页只呈现公开价格数据及其技术指标，不构成投资建议。",
                "Indicators are computed over the full history and then clipped to the selected range, so changing the range " +
                "never moves a trigger. This page shows public price data and technical indicators only; it is not investment advice."],
  built:       ["数据生成于 ", "Data built on "],
  buy:         ["买入", "Buy"],
  sell:        ["卖出", "Sell"],
  fired:       ["最新交易日：触发", "Latest day: FIRED"],
  notFired:    ["最新交易日：未触发", "Latest day: not fired"],
  lastFire:    ["最近一次触发 ", "Last fired "],
  never:       ["历史上从未触发", "Never fired"],
  daysAgo:     [" 个交易日前", " trading days ago"],
  colDate:     ["日期", "Date"],
  colSignal:   ["信号", "Signal"],
  colClose:    ["收盘", "Close"],
  colR20:      ["其后20日", "+20d"],
  colR60:      ["其后60日", "+60d"],
  colN:        ["触发天数", "Trigger days"],
  colAvg20:    ["触发后20日", "After 20d"],
  colAvg60:    ["触发后60日", "After 60d"],
  colEx20:     ["超额20日", "Excess 20d"],
  colEx60:     ["超额60日", "Excess 60d"],
  colBase:     ["基准（任意日）", "Baseline (any day)"],
  pending:     ["未到期", "pending"],
  price:       ["价格", "Price"],
  noData:      ["数据不足以计算这个信号", "Not enough data for this signal"],
  del:         ["删除", "Remove"],
  load:        ["载入", "Load"],
  rangeName:   [["1月","3月","6月","1年","5年","全部"], ["1M","3M","6M","1Y","5Y","MAX"]],
  dirBelow:    ["在下方", "below"],
  dirAbove:    ["在上方", "above"],
  dirCrossDn:  ["向下穿越", "crosses below"],
  dirCrossUp:  ["向上穿越", "crosses above"],
  pWeeks:      ["周数", "Weeks"],
  pFluct:      ["浮动容差 %", "Tolerance %"],
  pMa1:        ["快线 MA", "Fast MA"],
  pMa2:        ["慢线 MA", "Slow MA"],
  pDir:        ["方向", "Direction"],
  pDist:       ["距离 %", "Distance %"],
  pThresh:     ["阈值", "Threshold"],
  pPeriod:     ["周期", "Period"],
  pStd:        ["标准差倍数", "Std dev"],
  sigCount:    [" 次触发", " triggers"],
  logAxis:     ["对数坐标", "Log scale"],
  envOff:      ["不画趋势线", "No trend line"],
  envUpper:    ["上包络（强点在线下）", "Upper envelope"],
  envLower:    ["下包络（强点在线上）", "Lower envelope"],
  envBoth:     ["两条都画（通道）", "Both (channel)"],
  envLs:       ["最小二乘线", "Least squares"],
  envRecent:   ["最近 N 个强点", "Last N strong lows"],
  trigPrice:   ["下一交易日触发价", "Next-day trigger price"],
  trigNA:      ["平均分方式无法反解成单一价格（各指标可以互相补偿）。改用「全部达标」或只选一个指标即可看到。",
                "The mean mode has no single trigger price (metrics can offset each other). Use “all” mode or a single metric."],
  trigNone:    ["这个指标暂不支持反解", "No closed form for this metric yet"],
  trigHint:    ["把这个价位设成券商的到价提醒即可。", "Set this as a price alert at your broker."],
  trigDrift:   ["注意：距MA50 的触发价会随 MA50 上移——横盘也会让它升高。", 
                "Note: the distance-to-MA50 trigger drifts up as MA50 rises, even in a flat market."],
  envLabel:    ["强点趋势线", "Strong-low trend"],
  pctCombo:    ["百分位组合（抄底分）", "Percentile combo"],
  pctDesc:     ["选中指标各自换算成「当日读数相对自己过去三年的百分位」（越极端分越高），再按下面的方式合成一个分数。" +
                "深熊底和浅回调因此落到同一把尺子上。",
                "Each selected metric is converted to its percentile against its own past three years (more extreme = higher), " +
                "then combined into one score. This puts deep bear bottoms and shallow dips on the same scale."],
  mode:        ["合成方式", "Combine"],
  modeMean:    ["平均分", "mean"],
  modeAll:     ["全部达标(AND)", "all (AND)"],
  modeAny:     ["任一达标(OR)", "any (OR)"],
  metrics:     ["参与的指标", "Metrics"],
  pickOne:     ["至少选一个指标", "Select at least one metric"],
  markTitle:   ["标注低点的覆盖情况", "Coverage of marked lows"],
  markNone:    ["这个标的没有标注低点（只有 ^GSPC 有）。", "No marked lows for this ticker (only ^GSPC has them)."],
  colMark:     ["标注低点", "Marked low"],
  colStrong:   ["强", "Strong"],
  colLow:      ["当日最低", "Day low"],
  colCovered:  ["是否覆盖", "Covered"],
  colScore:    ["当日分数", "Score"],
  covYes:      ["覆盖", "yes"],
  covNo:       ["未覆盖", "no"],
  covWindow:   ["容差(交易日)", "Window (days)"],
  covSummary:  ["当前配置覆盖 ", "Currently covering "],
  covOf:       [" / ", " of "],
  markNote:    ["「覆盖」= 标注日的前后若干个交易日内，当前启用的信号至少触发过一次（容差在上方调）。" +
                "<b>这 10 个点是手工标注的样本，用它们挑指标属于拟合，不是预测</b>——" +
                "覆盖得越全，信号就越钝：实测覆盖全部 10 个点的最优组合要触发 17% 的交易日，" +
                "只覆盖 7 个「强」点可降到 9.5%，放弃 2002-10-10 与 2022-10-13 这两个熊市末期底后能降到 2.1%。详见 README。",
                "“Covered” means an enabled signal fired at least once within N trading days of the marked date. " +
                "<b>These 10 points are a hand-labelled sample; picking indicators to fit them is fitting, not prediction.</b> " +
                "The fuller the coverage, the blunter the signal — see README."],
};
function t(k) { var v = T[k]; return v ? v[LANG === "zh" ? 0 : 1] : k; }

/* ============ 信号定义 ============ */
/* 默认参数与 yourtimetobuy.com 前端代码里的默认值一致（2026-09-11 抓取）。 */
var DIRS = [["below","dirBelow"],["above","dirAbove"],["cross-down","dirCrossDn"],["cross-up","dirCrossUp"]];

var SIGNALS = {
  "nweek-low": {
    buy: true, overlay: "none",
    name: ["N周最低", "N-Week Low"],
    defaults: { weeks: 8, fluctuation: 0 },
    params: [
      { k: "weeks", label: "pWeeks", opts: [4,8,12,13,26,52] },
      { k: "fluctuation", label: "pFluct", opts: [0,0.5,1,2,3,5] },
    ],
    label: function (p) { return LANG==="zh"
      ? p.weeks+"周最低"+(p.fluctuation>0?" (±"+p.fluctuation+"%)":"")
      : p.weeks+"-Week Low"+(p.fluctuation>0?" (±"+p.fluctuation+"%)":""); },
    desc: ["收盘价跌到过去 N 周的最低点（容差之内）。", "Close at its lowest level of the past N weeks (within tolerance)."],
    calc: function (s, p) {
      var n = Math.max(2, Math.round(p.weeks * 5)), mn = rollMin(s.c, n), out = new Array(s.n);
      for (var i = 0; i < s.n; i++)
        out[i] = (i >= n - 1 && mn[i] != null) ? s.c[i] <= mn[i] * (1 + p.fluctuation / 100) : false;
      return out;
    },
  },
  "nweek-high": {
    buy: false, overlay: "none",
    name: ["N周最高", "N-Week High"],
    defaults: { weeks: 8, fluctuation: 0 },
    params: [
      { k: "weeks", label: "pWeeks", opts: [4,8,12,13,26,52] },
      { k: "fluctuation", label: "pFluct", opts: [0,0.5,1,2,3,5] },
    ],
    label: function (p) { return LANG==="zh"
      ? p.weeks+"周最高"+(p.fluctuation>0?" (±"+p.fluctuation+"%)":"")
      : p.weeks+"-Week High"+(p.fluctuation>0?" (±"+p.fluctuation+"%)":""); },
    desc: ["收盘价涨到过去 N 周的最高点（容差之内）。", "Close at its highest level of the past N weeks (within tolerance)."],
    calc: function (s, p) {
      var n = Math.max(2, Math.round(p.weeks * 5)), mx = rollMax(s.c, n), out = new Array(s.n);
      for (var i = 0; i < s.n; i++)
        out[i] = (i >= n - 1 && mx[i] != null) ? s.c[i] >= mx[i] * (1 - p.fluctuation / 100) : false;
      return out;
    },
  },
  "ma-buy": {
    buy: true, overlay: "ma",
    name: ["均线低点信号", "MA Low Signal"],
    defaults: { ma1: 50, ma2: 200, direction: "below", distancePct: 0 },
    params: [
      { k: "ma1", label: "pMa1", opts: [5,10,20,50,100,150] },
      { k: "ma2", label: "pMa2", opts: [20,50,100,150,200,250] },
      { k: "direction", label: "pDir", opts: DIRS },
      { k: "distancePct", label: "pDist", opts: [0,1,2,3,5,10] },
    ],
    label: function (p) { return (LANG==="zh" ? "均线低点信号 (MA" : "MA Low Signal (MA")
      + p.ma1 + " " + t(dirKey(p.direction)) + " MA" + p.ma2 + ")"; },
    desc: ["快线相对慢线处于（或穿越到）指定位置。", "Fast MA sits at — or crosses into — the given position versus the slow MA."],
    calc: function (s, p) { return maCross(s, p); },
  },
  "ma-sell": {
    buy: false, overlay: "ma",
    name: ["均线高点信号", "MA High Signal"],
    defaults: { ma1: 50, ma2: 200, direction: "cross-down", distancePct: 0 },
    params: [
      { k: "ma1", label: "pMa1", opts: [5,10,20,50,100,150] },
      { k: "ma2", label: "pMa2", opts: [20,50,100,150,200,250] },
      { k: "direction", label: "pDir", opts: DIRS },
      { k: "distancePct", label: "pDist", opts: [0,1,2,3,5,10] },
    ],
    label: function (p) { return (LANG==="zh" ? "均线高点信号 (MA" : "MA High Signal (MA")
      + p.ma1 + " " + t(dirKey(p.direction)) + " MA" + p.ma2 + ")"; },
    desc: ["快线相对慢线处于（或穿越到）指定位置。", "Fast MA sits at — or crosses into — the given position versus the slow MA."],
    calc: function (s, p) { return maCross(s, p); },
  },
  "rsi-oversold": {
    buy: true, overlay: "rsi",
    name: ["RSI超卖", "RSI Oversold"],
    defaults: { threshold: 30, period: 14 },
    params: [
      { k: "threshold", label: "pThresh", opts: [15,20,25,30,35,40] },
      { k: "period", label: "pPeriod", opts: [7,9,14,21,28] },
    ],
    label: function (p) { return LANG==="zh"
      ? "RSI超卖 (≤"+p.threshold+", 周期"+p.period+")" : "RSI Oversold (≤"+p.threshold+", period "+p.period+")"; },
    desc: ["Wilder RSI 跌到阈值以下。", "Wilder RSI falls at or below the threshold."],
    calc: function (s, p) {
      var r = rsi(s.c, p.period), out = new Array(s.n);
      for (var i = 0; i < s.n; i++) out[i] = r[i] != null && r[i] <= p.threshold;
      return out;
    },
  },
  "rsi-overbought": {
    buy: false, overlay: "rsi",
    name: ["RSI超买", "RSI Overbought"],
    defaults: { threshold: 70, period: 14 },
    params: [
      { k: "threshold", label: "pThresh", opts: [60,65,70,75,80,85] },
      { k: "period", label: "pPeriod", opts: [7,9,14,21,28] },
    ],
    label: function (p) { return LANG==="zh"
      ? "RSI超买 (≥"+p.threshold+", 周期"+p.period+")" : "RSI Overbought (≥"+p.threshold+", period "+p.period+")"; },
    desc: ["Wilder RSI 涨到阈值以上。", "Wilder RSI rises at or above the threshold."],
    calc: function (s, p) {
      var r = rsi(s.c, p.period), out = new Array(s.n);
      for (var i = 0; i < s.n; i++) out[i] = r[i] != null && r[i] >= p.threshold;
      return out;
    },
  },
  "bb-lower": {
    buy: true, overlay: "bb",
    name: ["BB下轨", "BB Lower Band"],
    defaults: { distancePct: 0, period: 20, stdDev: 2 },
    params: [
      { k: "period", label: "pPeriod", opts: [10,14,20,30,50] },
      { k: "stdDev", label: "pStd", opts: [1,1.5,2,2.5,3] },
      { k: "distancePct", label: "pDist", opts: [0,0.5,1,2,3] },
    ],
    label: function (p) { return (LANG==="zh" ? "BB下轨 (" : "BB Lower (") + p.period + ", " + p.stdDev + "σ)"; },
    desc: ["价格触及或跌破布林带下轨。", "Price touches or breaks below the lower Bollinger band."],
    calc: function (s, p) {
      var b = boll(s.c, p.period, p.stdDev), out = new Array(s.n);
      for (var i = 0; i < s.n; i++) out[i] = b.lo[i] != null && s.c[i] <= b.lo[i] * (1 + p.distancePct / 100);
      return out;
    },
  },
  "bb-upper": {
    buy: false, overlay: "bb",
    name: ["BB上轨", "BB Upper Band"],
    defaults: { distancePct: 0, period: 20, stdDev: 2 },
    params: [
      { k: "period", label: "pPeriod", opts: [10,14,20,30,50] },
      { k: "stdDev", label: "pStd", opts: [1,1.5,2,2.5,3] },
      { k: "distancePct", label: "pDist", opts: [0,0.5,1,2,3] },
    ],
    label: function (p) { return (LANG==="zh" ? "BB上轨 (" : "BB Upper (") + p.period + ", " + p.stdDev + "σ)"; },
    desc: ["价格触及或突破布林带上轨。", "Price touches or breaks above the upper Bollinger band."],
    calc: function (s, p) {
      var b = boll(s.c, p.period, p.stdDev), out = new Array(s.n);
      for (var i = 0; i < s.n; i++) out[i] = b.up[i] != null && s.c[i] >= b.up[i] * (1 - p.distancePct / 100);
      return out;
    },
  },
  "adx-trend-buy": {
    buy: true, overlay: "adx",
    name: ["ADX上升趋势", "ADX Uptrend"],
    defaults: { threshold: 25 },
    params: [{ k: "threshold", label: "pThresh", opts: [15,20,25,30,35,40] }],
    label: function (p) { return LANG==="zh" ? "ADX上升趋势 (≥"+p.threshold+")" : "ADX Uptrend (≥"+p.threshold+")"; },
    desc: ["ADX 高于阈值且 +DI 在 −DI 之上（趋势成立且方向向上）。",
           "ADX above the threshold with +DI above −DI (an established uptrend)."],
    calc: function (s, p) {
      var a = adx(s), out = new Array(s.n);
      for (var i = 0; i < s.n; i++) out[i] = a.adx[i] != null && a.adx[i] >= p.threshold && a.pdi[i] > a.mdi[i];
      return out;
    },
  },
  "adx-trend-sell": {
    buy: false, overlay: "adx",
    name: ["ADX下降趋势", "ADX Downtrend"],
    defaults: { threshold: 25 },
    params: [{ k: "threshold", label: "pThresh", opts: [15,20,25,30,35,40] }],
    label: function (p) { return LANG==="zh" ? "ADX下降趋势 (≥"+p.threshold+")" : "ADX Downtrend (≥"+p.threshold+")"; },
    desc: ["ADX 高于阈值且 −DI 在 +DI 之上（趋势成立且方向向下）。",
           "ADX above the threshold with −DI above +DI (an established downtrend)."],
    calc: function (s, p) {
      var a = adx(s), out = new Array(s.n);
      for (var i = 0; i < s.n; i++) out[i] = a.adx[i] != null && a.adx[i] >= p.threshold && a.mdi[i] > a.pdi[i];
      return out;
    },
  },
};
SIGNALS["pct-combo"] = {
  buy: true, overlay: "pct",
  name: ["百分位组合（抄底分）", "Percentile combo"],
  defaults: { metrics: ["RSI14", "距MA50", "20日跌幅"], mode: "mean", threshold: 90 },
  params: [],                      /* 参数面板是特制的，见 renderSigs */
  label: function (p) {
    var m = { mean: LANG === "zh" ? "平均" : "mean", all: "AND", any: "OR" }[p.mode];
    return (LANG === "zh" ? "抄底分 " : "Combo ") + m + " ≥ " + p.threshold +
           " (" + (p.metrics.length ? p.metrics.join("+") : "—") + ")";
  },
  desc: T.pctDesc,
  calc: function (s, p) {
    var cols = pctCols(s, p.metrics), out = new Array(s.n).fill(false);
    if (!cols.length) return out;
    for (var i = 0; i < s.n; i++) {
      var v = score(cols, i, p.mode);
      out[i] = v != null && v >= p.threshold;
    }
    return out;
  },
};
/* 取出选中指标的百分位列（原始数据是 ×10 的整数，这里还原成 0-100） */
function pctCols(s, metrics) {
  var P = DATA.pct && DATA.pct[s.tk];
  if (!P) return [];
  var out = [];
  (metrics || []).forEach(function (m) { if (P[m]) out.push(P[m]); });
  return out;
}
function score(cols, i, mode) {
  var sum = 0, mn = Infinity, mx = -Infinity, k;
  for (k = 0; k < cols.length; k++) {
    var v = cols[k][i];
    if (v == null) return null;
    v /= 10;
    sum += v; if (v < mn) mn = v; if (v > mx) mx = v;
  }
  return mode === "all" ? mn : mode === "any" ? mx : sum / cols.length;
}

var SIG_ORDER = ["pct-combo","nweek-low","nweek-high","ma-buy","ma-sell","rsi-oversold","rsi-overbought",
                 "bb-lower","bb-upper","adx-trend-buy","adx-trend-sell"];
function dirKey(d) {
  return d === "below" ? "dirBelow" : d === "above" ? "dirAbove"
       : d === "cross-down" ? "dirCrossDn" : "dirCrossUp";
}

/* ============ 指标 ============ */
function sma(a, n) {
  var out = new Array(a.length).fill(null), s = 0;
  for (var i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= n) s -= a[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}
function rollMin(a, n) {
  var out = new Array(a.length).fill(null), dq = [];
  for (var i = 0; i < a.length; i++) {
    while (dq.length && a[dq[dq.length - 1]] >= a[i]) dq.pop();
    dq.push(i);
    while (dq[0] <= i - n) dq.shift();
    if (i >= n - 1) out[i] = a[dq[0]];
  }
  return out;
}
function rollMax(a, n) {
  var out = new Array(a.length).fill(null), dq = [];
  for (var i = 0; i < a.length; i++) {
    while (dq.length && a[dq[dq.length - 1]] <= a[i]) dq.pop();
    dq.push(i);
    while (dq[0] <= i - n) dq.shift();
    if (i >= n - 1) out[i] = a[dq[0]];
  }
  return out;
}
function rsi(c, n) {                       /* Wilder 平滑 */
  var out = new Array(c.length).fill(null);
  if (c.length <= n) return out;
  var ag = 0, al = 0, i;
  for (i = 1; i <= n; i++) {
    var d = c[i] - c[i - 1];
    if (d >= 0) ag += d; else al -= d;
  }
  ag /= n; al /= n;
  out[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (i = n + 1; i < c.length; i++) {
    var dd = c[i] - c[i - 1];
    ag = (ag * (n - 1) + (dd > 0 ? dd : 0)) / n;
    al = (al * (n - 1) + (dd < 0 ? -dd : 0)) / n;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function boll(c, n, k) {
  var mid = sma(c, n), up = new Array(c.length).fill(null), lo = new Array(c.length).fill(null);
  for (var i = n - 1; i < c.length; i++) {
    var s = 0;
    for (var j = i - n + 1; j <= i; j++) { var d = c[j] - mid[i]; s += d * d; }
    var sd = Math.sqrt(s / n);              /* 总体标准差，与主流图表软件一致 */
    up[i] = mid[i] + k * sd; lo[i] = mid[i] - k * sd;
  }
  return { mid: mid, up: up, lo: lo };
}
function adx(s, n) {                        /* Wilder ADX，周期固定 14（与对方站一致） */
  n = n || 14;
  if (s._adx) return s._adx;
  var N = s.n, tr = [], pdm = [], mdm = [], i;
  for (i = 0; i < N; i++) {
    if (i === 0) { tr.push(0); pdm.push(0); mdm.push(0); continue; }
    var up = s.h[i] - s.h[i - 1], dn = s.l[i - 1] - s.l[i];
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(s.h[i] - s.l[i], Math.abs(s.h[i] - s.c[i - 1]), Math.abs(s.l[i] - s.c[i - 1])));
  }
  var atr = null, ap = null, am = null,
      A = new Array(N).fill(null), P = new Array(N).fill(null), M = new Array(N).fill(null),
      dxs = [], adxv = null;
  for (i = 1; i < N; i++) {
    if (i < n) { continue; }
    if (i === n) {
      atr = ap = am = 0;
      for (var j = 1; j <= n; j++) { atr += tr[j]; ap += pdm[j]; am += mdm[j]; }
    } else {
      atr = atr - atr / n + tr[i]; ap = ap - ap / n + pdm[i]; am = am - am / n + mdm[i];
    }
    if (atr === 0) continue;
    var pdi = 100 * ap / atr, mdi = 100 * am / atr;
    P[i] = pdi; M[i] = mdi;
    var sum = pdi + mdi, dx = sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum;
    dxs.push(dx);
    if (dxs.length === n) { adxv = dxs.reduce(function (a, b) { return a + b; }, 0) / n; A[i] = adxv; }
    else if (dxs.length > n) { adxv = (adxv * (n - 1) + dx) / n; A[i] = adxv; }
  }
  s._adx = { adx: A, pdi: P, mdi: M };
  return s._adx;
}
function maCross(s, p) {
  var a = sma(s.c, p.ma1), b = sma(s.c, p.ma2), out = new Array(s.n).fill(false), d = p.distancePct / 100;
  for (var i = 1; i < s.n; i++) {
    if (a[i] == null || b[i] == null) continue;
    if (p.direction === "below") out[i] = a[i] <= b[i] * (1 - d);
    else if (p.direction === "above") out[i] = a[i] >= b[i] * (1 + d);
    else if (a[i - 1] != null && b[i - 1] != null) {
      if (p.direction === "cross-down") out[i] = a[i - 1] > b[i - 1] && a[i] <= b[i];
      else out[i] = a[i - 1] < b[i - 1] && a[i] >= b[i];
    }
  }
  return out;
}

/* ============ 触发价反解 ============
   把「百分位 >= 阈值」换算成下一交易日的收盘价门槛，这样就能拿去券商设到价提醒。
   与 watch/cloud_check.py 的算法一致，tests/parity_check.py 会比对两边。 */
function xStar(hist, th) {
  var w = hist.slice().sort(function (a, b) { return a - b; }), n = w.length;
  var k = Math.floor((n + 1) * (1 - th / 100) - 1);
  if (k < 0) return null;
  if (k >= n) return Infinity;
  return w[k];
}
function triggerPrice(s, metric, th) {
  var n = s.n, i, xs = [], xstar;
  if (metric === "距MA50") {
    for (i = 49; i < n; i++) {
      var sum = 0;
      for (var j = i - 49; j <= i; j++) sum += s.c[j];
      xs.push(s.c[i] / (sum / 50) - 1);
    }
    if (xs.length < 250) return null;
    xstar = xStar(xs.slice(-756), th);
    if (xstar == null || !isFinite(xstar)) return null;
    var S49 = 0;
    for (i = n - 49; i < n; i++) S49 += s.c[i];
    var den = 49 - xstar;
    return den <= 0 ? null : (1 + xstar) * S49 / den;
  }
  if (metric === "回撤深度") {
    var mx = [], q;
    for (i = 251; i < n; i++) {
      q = -Infinity;
      for (var k2 = i - 251; k2 <= i; k2++) if (s.h[k2] > q) q = s.h[k2];
      mx.push(q);
      xs.push(s.c[i] / q - 1);
    }
    if (xs.length < 250) return null;
    xstar = xStar(xs.slice(-756), th);
    if (xstar == null || !isFinite(xstar)) return null;
    /* 252 日最高与待定的收盘价无关（下跌不会创新高），直接用当前值 */
    return (1 + xstar) * mx[mx.length - 1];
  }
  return null;                     /* 其余指标暂无闭式解 */
}
/* 组合的触发价：全部达标取最严（最低）的，任一达标取最松（最高）的，平均分无解 */
function comboTrigger(s, p) {
  if (!p.metrics.length) return { v: null, why: "none" };
  if (p.mode === "mean" && p.metrics.length > 1) return { v: null, why: "mean" };
  var vals = [], miss = false;
  p.metrics.forEach(function (m) {
    var v = triggerPrice(s, m, p.threshold);
    if (v == null) miss = true; else vals.push(v);
  });
  if (!vals.length) return { v: null, why: "unsupported" };
  var v = p.mode === "any" ? Math.max.apply(null, vals) : Math.min.apply(null, vals);
  return { v: v, why: miss ? "partial" : "ok" };
}

/* ============ 状态 ============ */
var state = {
  ticker: localStorage.getItem("sv_ticker") || "^GSPC",
  range: localStorage.getItem("sv_range") || "5Y",
  log: localStorage.getItem("sv_log") === "1",
  covWin: parseInt(localStorage.getItem("sv_covwin") || "3", 10),
  env: localStorage.getItem("sv_env") || "off",
  sigs: [],          /* [{type, active, params:{}}] */
};
try {
  var saved = JSON.parse(localStorage.getItem("sv_sigs") || "null");
  if (saved && saved.length) state.sigs = saved;
} catch (e) { /* 忽略坏掉的本地存储 */ }
/* 公开站（GitHub Pages）与本地版跑的是同一份代码，但公开站上不摆这些东西：
   操作者手工标注的低点、触发记录、各信号历史表现——那是个人研究过程，
   放在谁都能打开的页面上既没必要也容易被误读成「推荐买卖点」。
   代码和数据都还在，本地打开（file:// 或 localhost）照旧完整显示。 */
var PUBLIC_SITE = document.documentElement.dataset.public === "1" ||
                  /\.github\.io$/.test(location.hostname);
if (PUBLIC_SITE) {
  ["cardHits", "cardMarks", "cardStats"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.hidden = true;
  });
}

if (!PUBLIC_SITE && !state.sigs.length && localStorage.getItem("sv_sigs_seen") !== "1") {
  /* 默认不再预设抄底分那两条——抄底分是「跌得够不够深/够不够急」的择时信号，
     当默认值会把人往追跌的方向带。估值类的提醒现在在「估值面板」页签里，
     那边按 PE 分位给阈值，逻辑上更稳。
     这里只留一条最中性的：股价相对 200 日均线跌到历史 97 分位（跌破年线且幅度罕见），
     纯粹作为「有东西可看」的示例，用户删掉后不会再自动加回来。 */
  state.sigs = [
    { type: "pct-combo", active: true, params: { metrics: ["距MA200"], mode: "mean", threshold: 97 } },
  ];
  localStorage.setItem("sv_sigs_seen", "1");
}
if (!DATA.series[state.ticker]) state.ticker = Object.keys(DATA.series)[0];

var RANGES = [["1M",21],["3M",63],["6M",126],["1Y",252],["5Y",1260],["MAX",0]];
var seriesCache = {};
function series(tk) {
  if (seriesCache[tk]) return seriesCache[tk];
  var s = DATA.series[tk];
  var o = { d: s.d, o: s.o, h: s.h, l: s.l, c: s.c, n: s.d.length, tk: tk };
  seriesCache[tk] = o;
  return o;
}
function save() {
  localStorage.setItem("sv_ticker", state.ticker);
  localStorage.setItem("sv_range", state.range);
  localStorage.setItem("sv_log", state.log ? "1" : "0");
  localStorage.setItem("sv_covwin", String(state.covWin));
  localStorage.setItem("sv_env", state.env);
  localStorage.setItem("sv_sigs", JSON.stringify(state.sigs));
}

/* ============ 计算 ============ */
var computed = null;
function compute() {
  var s = series(state.ticker);
  var fires = state.sigs.map(function (sg) {
    if (!sg.active) return null;
    try { return SIGNALS[sg.type].calc(s, sg.params); } catch (e) { return null; }
  });
  var i0 = 0, span = 0;
  for (var r = 0; r < RANGES.length; r++) if (RANGES[r][0] === state.range) span = RANGES[r][1];
  if (span > 0) i0 = Math.max(0, s.n - span);
  computed = { s: s, fires: fires, i0: i0, i1: s.n - 1 };
  return computed;
}

/* 触发后 N 日的平均收益 vs 任意日买入的基准 */
function perf(s, fire, horizon) {
  var sum = 0, cnt = 0, bsum = 0, bcnt = 0, total = 0, i;
  for (i = 0; i < s.n; i++) {
    if (fire[i]) total++;                      /* total 是全部触发天数 */
    if (i + horizon >= s.n) continue;          /* 末尾这些天收益还没到期 */
    var r = s.c[i + horizon] / s.c[i] - 1;
    bsum += r; bcnt++;
    if (fire[i]) { sum += r; cnt++; }
  }
  if (!bcnt) return null;
  var base = bsum / bcnt;
  return { total: total, n: cnt, avg: cnt ? sum / cnt : null, base: base,
           ex: cnt ? sum / cnt - base : null };
}

/* ============ 绘图 ============ */
var cv = document.getElementById("chart"), ctx = cv.getContext("2d"), tip = document.getElementById("tip");
var layout = null, hoverIdx = -1;

function overlaysNeeded() {
  var need = { ma: [], bb: null, rsi: null, adx: null };
  state.sigs.forEach(function (sg) {
    if (!sg.active) return;
    var def = SIGNALS[sg.type];
    if (def.overlay === "ma") { need.ma.push(sg.params.ma1); need.ma.push(sg.params.ma2); }
    else if (def.overlay === "bb") need.bb = { period: sg.params.period, stdDev: sg.params.stdDev };
    else if (def.overlay === "rsi") {
      if (!need.rsi) need.rsi = { period: sg.params.period, lines: [] };
      need.rsi.lines.push({ v: sg.params.threshold, buy: def.buy });
    } else if (def.overlay === "adx") {
      if (!need.adx) need.adx = { lines: [] };
      need.adx.lines.push({ v: sg.params.threshold, buy: def.buy });
    } else if (def.overlay === "pct" && sg.params.metrics.length) {
      if (!need.pct) need.pct = { series: [] };
      need.pct.series.push({ p: sg.params, label: def.label(sg.params) });
    }
  });
  need.ma = need.ma.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
  return need;
}

function draw() {
  var C = computed, s = C.s, i0 = C.i0, i1 = C.i1;
  var need = overlaysNeeded();
  var subs = [];
  if (need.rsi) subs.push("rsi");
  if (need.adx) subs.push("adx");
  if (need.pct) subs.push("pct");

  var W = cv.parentNode.clientWidth - 16;
  var mainH = 340, subH = 110, padT = 12, padB = 26, padL = 8, padR = 62;
  var H = padT + mainH + subs.length * (subH + 18) + padB;
  var dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  var x0 = padL, x1 = W - padR, plotW = x1 - x0, N = i1 - i0 + 1;
  function X(i) { return N <= 1 ? x0 : x0 + (i - i0) / (N - 1) * plotW; }

  /* ---- 主图纵轴范围 ---- */
  var lo = Infinity, hi = -Infinity, i;
  for (i = i0; i <= i1; i++) { if (s.c[i] < lo) lo = s.c[i]; if (s.c[i] > hi) hi = s.c[i]; }
  var bb = need.bb ? boll(s.c, need.bb.period, need.bb.stdDev) : null;
  if (bb) for (i = i0; i <= i1; i++) {
    if (bb.lo[i] != null) { if (bb.lo[i] < lo) lo = bb.lo[i]; if (bb.up[i] > hi) hi = bb.up[i]; }
  }
  var mas = need.ma.map(function (n) { return { n: n, v: sma(s.c, n) }; });
  mas.forEach(function (m) {
    for (var k = i0; k <= i1; k++) if (m.v[k] != null) { if (m.v[k] < lo) lo = m.v[k]; if (m.v[k] > hi) hi = m.v[k]; }
  });
  var yT = padT, yB = padT + mainH, Y, ticks;
  if (state.log && lo > 0) {
    var llo = Math.log(lo) - (Math.log(hi) - Math.log(lo)) * 0.04,
        lhi = Math.log(hi) + (Math.log(hi) - Math.log(lo)) * 0.04;
    Y = function (v) { return v <= 0 ? yB : yB - (Math.log(v) - llo) / (lhi - llo) * (yB - yT); };
    ticks = logTicks(Math.exp(llo), Math.exp(lhi));
  } else {
    var pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    Y = function (v) { return yB - (v - lo) / (hi - lo) * (yB - yT); };
    ticks = niceTicks(lo, hi, 5);
  }

  /* ---- 网格 + 纵轴 ---- */
  ctx.font = "11px system-ui,sans-serif"; ctx.textBaseline = "middle";
  ticks.forEach(function (v) {
    var y = Y(v);
    if (y < yT - 1 || y > yB + 1) return;
    ctx.strokeStyle = "#f1f3f5"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + .5); ctx.lineTo(x1, Math.round(y) + .5); ctx.stroke();
    ctx.fillStyle = "#9ca3af"; ctx.textAlign = "left";
    ctx.fillText(fmtNum(v), x1 + 6, y);
  });

  /* ---- 布林带 ---- */
  if (bb) {
    ctx.beginPath();
    var started = false;
    for (i = i0; i <= i1; i++) { if (bb.up[i] == null) continue; if (!started) { ctx.moveTo(X(i), Y(bb.up[i])); started = true; } else ctx.lineTo(X(i), Y(bb.up[i])); }
    for (i = i1; i >= i0; i--) { if (bb.lo[i] == null) continue; ctx.lineTo(X(i), Y(bb.lo[i])); }
    if (started) { ctx.closePath(); ctx.fillStyle = "rgba(118,75,162,.09)"; ctx.fill(); }
    [["up","rgba(118,75,162,.55)"],["mid","rgba(118,75,162,.35)"],["lo","rgba(118,75,162,.55)"]].forEach(function (p) {
      line(bb[p[0]], p[1], 1, true);
    });
  }
  function line(arr, color, w, dash) {
    ctx.save(); if (dash) ctx.setLineDash([4, 3]);
    ctx.strokeStyle = color; ctx.lineWidth = w || 1.4; ctx.beginPath();
    var st = false;
    for (var k = i0; k <= i1; k++) {
      if (arr[k] == null) { st = false; continue; }
      var xx = X(k), yy = Y(arr[k]);
      if (!st) { ctx.moveTo(xx, yy); st = true; } else ctx.lineTo(xx, yy);
    }
    ctx.stroke(); ctx.restore();
  }

  /* ---- 均线 ---- */
  var MACOL = ["#f59e0b","#0ea5e9","#10b981","#ef4444"];
  mas.forEach(function (m, k) { line(m.v, MACOL[k % MACOL.length], 1.3); });

  /* ---- 强点趋势线：对数坐标下是直线，线性坐标下自动呈指数曲线 ---- */
  var env = (DATA.envelope || {})[state.ticker];
  if (env && state.env !== "off") {
    var want = state.env === "both" ? ["lower", "upper"] : [state.env];
    want.forEach(function (kind) {
      var a, b, col;
      if (kind === "ls") { a = env.a_ls; b = env.b_ls; col = "#0891b2"; }
      else {
        var L = (env.lines || {})[kind];
        if (!L) return;
        a = L.a; b = L.b;
        col = kind === "upper" ? "#b45309" : kind === "lower" ? "#059669" : "#7c3aed";
      }
      var base = Date.parse(env.base + "T00:00:00Z");
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, yT, x1 - x0, yB - yT); ctx.clip();   /* 别画到副图里 */
      ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.setLineDash([7, 4]);
      ctx.beginPath();
      var started = false;
      for (var k = i0; k <= i1; k++) {
        var tt = (Date.parse(s.d[k] + "T00:00:00Z") - base) / 86400000 / 365.25;
        var vv = Math.exp(a + b * tt);
        var yy = Y(vv);
        if (!isFinite(yy)) { started = false; continue; }
        if (!started) { ctx.moveTo(X(k), yy); started = true; } else ctx.lineTo(X(k), yy);
      }
      ctx.stroke(); ctx.restore();
    });
  }

  /* ---- 价格线 ---- */
  ctx.strokeStyle = "#667eea"; ctx.lineWidth = 1.6; ctx.beginPath();
  for (i = i0; i <= i1; i++) { var x = X(i), y = Y(s.c[i]); if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.stroke();

  /* ---- 触发点 ---- */
  var pts = [];
  state.sigs.forEach(function (sg, si) {
    var f = C.fires[si]; if (!f) return;
    var def = SIGNALS[sg.type];
    for (var k = i0; k <= i1; k++) if (f[k]) pts.push({ i: k, buy: def.buy, si: si });
  });
  pts.forEach(function (p) {
    ctx.beginPath();
    ctx.arc(X(p.i), Y(s.c[p.i]), 4, 0, 6.2832);
    ctx.fillStyle = p.buy ? "rgba(5,150,105,.75)" : "rgba(220,38,38,.75)";
    ctx.fill();
  });

  /* ---- 标注低点（手工标注的样本，画成空心星） ---- */
  var lows = (DATA.markedLows || {})[state.ticker] || [];
  var lowPts = [];
  lows.forEach(function (m) {
    var k = s.d.indexOf(m.date);
    if (k < i0 || k > i1) return;
    var x = X(k), y = Y(s.c[k]);
    lowPts.push({ i: k, x: x, y: y, m: m });
    ctx.save();
    ctx.strokeStyle = m.strong ? "#b45309" : "#9ca3af";
    ctx.fillStyle = m.strong ? "rgba(180,83,9,.16)" : "rgba(156,163,175,.16)";
    ctx.lineWidth = m.strong ? 1.8 : 1.2;
    star(ctx, x, y + 16, m.strong ? 8 : 6.5);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  });

  /* ---- 横轴 ---- */
  ctx.fillStyle = "#9ca3af"; ctx.textAlign = "center";
  var step = Math.max(1, Math.floor(N / 7));
  for (i = i0; i <= i1; i += step) ctx.fillText(shortDate(s.d[i]), X(i), H - padB / 2 + 2);

  /* ---- 副图 ---- */
  var subTop = yB + 18;
  var subInfo = [];
  subs.forEach(function (kind) {
    var top = subTop, bot = top + subH;
    ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, bot + .5); ctx.lineTo(x1, bot + .5); ctx.stroke();
    var arr, mn, mx, lines, title;
    if (kind === "rsi") { arr = rsi(s.c, need.rsi.period); mn = 0; mx = 100; lines = need.rsi.lines; title = "RSI " + need.rsi.period; }
    else if (kind === "pct") {
      var q = need.pct.series[0], cols = pctCols(s, q.p.metrics);
      arr = new Array(s.n);
      for (i = 0; i < s.n; i++) arr[i] = score(cols, i, q.p.mode);
      mn = 0; mx = 100;
      lines = need.pct.series.map(function (x) { return { v: x.p.threshold, buy: true }; });
      title = q.label;
    }
    else { var a = adx(s); arr = a.adx; mn = 0; mx = 60; lines = need.adx.lines; title = "ADX 14"; }
    function SY(v) { return bot - (Math.min(mx, Math.max(mn, v)) - mn) / (mx - mn) * (bot - top); }
    lines.forEach(function (L) {
      var y = SY(L.v);
      ctx.save(); ctx.setLineDash([3, 3]);
      ctx.strokeStyle = L.buy ? "rgba(5,150,105,.6)" : "rgba(220,38,38,.6)";
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.restore();
      ctx.fillStyle = L.buy ? "#059669" : "#dc2626"; ctx.textAlign = "left";
      ctx.fillText(String(L.v), x1 + 6, y);
    });
    ctx.strokeStyle = "#6b7280"; ctx.lineWidth = 1.2; ctx.beginPath();
    var st = false;
    for (i = i0; i <= i1; i++) {
      if (arr[i] == null) { st = false; continue; }
      var xx = X(i), yy = SY(arr[i]);
      if (!st) { ctx.moveTo(xx, yy); st = true; } else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
    ctx.fillStyle = "#6b7280"; ctx.textAlign = "left";
    ctx.fillText(title, x0 + 4, top + 8);
    subInfo.push({ kind: kind, arr: arr, top: top, bot: bot });
    subTop = bot + 18;
  });

  layout = { x0: x0, x1: x1, X: X, Y: Y, yT: yT, yB: yB, i0: i0, i1: i1, N: N, H: H, W: W,
             mas: mas, bb: bb, subs: subInfo, pts: pts, lowPts: lowPts };

  if (hoverIdx >= i0 && hoverIdx <= i1) drawCross(hoverIdx);
}
function star(ctx, cx, cy, r) {
  ctx.beginPath();
  for (var i = 0; i < 10; i++) {
    var a = Math.PI / 5 * i - Math.PI / 2, rr = i % 2 ? r * 0.45 : r;
    var x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}
function drawCross(idx) {
  var L = layout, s = computed.s, x = L.X(idx);
  ctx.save();
  ctx.strokeStyle = "rgba(17,24,39,.22)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x, L.yT); ctx.lineTo(x, L.H - 26); ctx.stroke();
  ctx.restore();
  ctx.beginPath(); ctx.arc(x, L.Y(s.c[idx]), 3.5, 0, 6.2832);
  ctx.fillStyle = "#667eea"; ctx.fill();
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
}

function niceTicks(lo, hi, n) {
  var span = hi - lo; if (!(span > 0)) return [lo];
  var raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), norm = raw / mag;
  var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  var out = [], v = Math.ceil(lo / step) * step;
  for (; v <= hi; v += step) out.push(v);
  return out;
}
function logTicks(lo, hi) {
  var out = [], k = Math.floor(Math.log10(lo));
  for (; k <= Math.ceil(Math.log10(hi)); k++)
    [1, 2, 5].forEach(function (m) {
      var v = m * Math.pow(10, k);
      if (v >= lo && v <= hi) out.push(v);
    });
  return out.length >= 2 ? out : niceTicks(lo, hi, 5);
}
function fmtNum(v) {
  var a = Math.abs(v);
  return a >= 1000 ? v.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
       : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}
function fmtPct(v, digits) {
  if (v == null || isNaN(v)) return "—";
  var d = digits == null ? 2 : digits;
  return (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%";
}
function shortDate(d) { return d.slice(2, 4) + "-" + d.slice(5, 7); }

/* ============ 交互 ============ */
function idxFromX(px) {
  var L = layout; if (!L) return -1;
  var r = (px - L.x0) / (L.x1 - L.x0);
  var i = Math.round(L.i0 + r * (L.N - 1));
  return Math.max(L.i0, Math.min(L.i1, i));
}
cv.addEventListener("pointermove", function (e) {
  var r = cv.getBoundingClientRect(), i = idxFromX(e.clientX - r.left);
  if (i < 0) return;
  hoverIdx = i; draw(); showTip(i, e.clientX - r.left, e.clientY - r.top);
});
cv.addEventListener("pointerleave", function () { hoverIdx = -1; tip.style.opacity = 0; draw(); });

function showTip(i, mx, my) {
  var s = computed.s, L = layout, rows = [];
  rows.push("<div style='font-weight:600;margin-bottom:3px'>" + s.d[i] + "</div>");
  rows.push("<div class='r'><span><i class='sw' style='background:#667eea'></i>" + t("price") + "</span><b>" + fmtNum(s.c[i]) + "</b></div>");
  var MACOL = ["#f59e0b","#0ea5e9","#10b981","#ef4444"];
  L.mas.forEach(function (m, k) {
    if (m.v[i] != null) rows.push("<div class='r'><span><i class='sw' style='background:" + MACOL[k % 4] + "'></i>MA" + m.n + "</span><b>" + fmtNum(m.v[i]) + "</b></div>");
  });
  if (L.bb && L.bb.lo[i] != null)
    rows.push("<div class='r'><span><i class='sw' style='background:#764ba2'></i>BB</span><b>" + fmtNum(L.bb.lo[i]) + " / " + fmtNum(L.bb.up[i]) + "</b></div>");
  L.subs.forEach(function (sb) {
    if (sb.arr[i] != null)
      rows.push("<div class='r'><span>" + (sb.kind === "rsi" ? "RSI" : "ADX") + "</span><b>" + sb.arr[i].toFixed(1) + "</b></div>");
  });
  var mk = (DATA.markedLows || {})[state.ticker] || [];
  for (var q = 0; q < mk.length; q++) if (mk[q].date === s.d[i]) {
    rows.push("<div style='margin-top:4px;color:#fbbf24'>★ " + t("colMark") +
      (mk[q].strong ? "（" + t("colStrong") + "）" : "") + "  " + t("colLow") + " " + fmtNum(mk[q].low) + "</div>");
  }
  var fired = [];
  state.sigs.forEach(function (sg, si) {
    var f = computed.fires[si];
    if (f && f[i]) fired.push({ txt: SIGNALS[sg.type].label(sg.params), buy: SIGNALS[sg.type].buy });
  });
  if (fired.length) {
    rows.push("<div style='margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,.2)'></div>");
    fired.forEach(function (f) {
      rows.push("<div style='color:" + (f.buy ? "#6ee7b7" : "#fca5a5") + "'>● " + f.txt + "</div>");
    });
  }
  tip.innerHTML = rows.join("");
  tip.style.opacity = 1;
  var w = tip.offsetWidth, left = mx + 14;
  if (left + w > L.W) left = mx - w - 14;
  tip.style.left = Math.max(0, left) + "px";
  tip.style.top = Math.max(0, Math.min(my - 10, L.H - tip.offsetHeight - 4)) + "px";
}

/* ============ 渲染各面板 ============ */
function renderAll() { compute(); draw(); renderQuote(); renderSigs(); renderHits(); renderStats(); renderMarks(); renderWatch(); save(); }

function renderMarks() {
  var lows = (DATA.markedLows || {})[state.ticker] || [],
      tb = document.getElementById("markTable"), s = computed.s;
  var sel = document.getElementById("covWin");
  if (!sel.options.length) {
    [0, 1, 2, 3, 5, 10].forEach(function (w) {
      var o = document.createElement("option");
      o.value = w; o.textContent = "±" + w;
      sel.appendChild(o);
    });
    sel.onchange = function () { state.covWin = +sel.value; renderAll(); };
  }
  sel.value = state.covWin;
  document.getElementById("markEmpty").hidden = lows.length > 0;
  document.querySelector("[data-t='markNote']").innerHTML = t("markNote");
  if (!lows.length) { tb.innerHTML = ""; document.getElementById("covSum").textContent = ""; return; }

  /* 当前启用的信号里，哪些用了百分位分数 —— 顺带把当日分数显示出来 */
  var pctSig = null;
  state.sigs.forEach(function (sg) {
    if (sg.active && sg.type === "pct-combo" && sg.params.metrics.length && !pctSig) pctSig = sg;
  });
  var cols = pctSig ? pctCols(s, pctSig.params.metrics) : null;

  var w = state.covWin, covered = 0, h =
    "<thead><tr><th>" + t("colMark") + "</th><th>" + t("colStrong") + "</th><th>" + t("colLow") +
    "</th><th>" + t("colScore") + "</th><th>" + t("colCovered") + "</th></tr></thead><tbody>";
  lows.forEach(function (m) {
    var i0 = s.d.indexOf(m.date), ok = false;
    if (i0 >= 0) {
      for (var si = 0; si < state.sigs.length && !ok; si++) {
        var f = computed.fires[si];
        if (!f) continue;
        for (var k = Math.max(0, i0 - w); k <= Math.min(s.n - 1, i0 + w) && !ok; k++) if (f[k]) ok = true;
      }
    }
    if (ok) covered++;
    var sc = (cols && i0 >= 0) ? score(cols, i0, pctSig.params.mode) : null;
    h += "<tr><td class='date' data-i='" + i0 + "'>" + m.date + "</td>" +
         "<td style='text-align:right'>" + (m.strong ? "★" : "") + "</td>" +
         "<td>" + fmtNum(m.low) + "</td>" +
         "<td>" + (sc == null ? "—" : sc.toFixed(1)) + "</td>" +
         "<td class='" + (ok ? "up" : "down") + "'>" + (ok ? t("covYes") : t("covNo")) + "</td></tr>";
  });
  tb.innerHTML = h + "</tbody>";
  document.getElementById("covSum").textContent =
    t("covSummary") + covered + t("covOf") + lows.length;
  tb.querySelectorAll("td.date").forEach(function (el) {
    el.onclick = function () {
      var i = +el.dataset.i;
      if (i < computed.i0) { state.range = "MAX"; renderRanges(); renderAll(); }
      hoverIdx = i; draw(); showTip(i, layout.X(i), layout.Y(computed.s.c[i]));
      cv.scrollIntoView({ behavior: "smooth", block: "center" });
    };
  });
}

function renderQuote() {
  var s = computed.s, i0 = computed.i0, i1 = computed.i1, m = DATA.meta[state.ticker];
  document.getElementById("qName").textContent = LANG === "zh" ? m.zh : m.en;
  document.getElementById("qCode").textContent = state.ticker;
  var lo = Infinity, hi = -Infinity, sum = 0, i;
  for (i = i0; i <= i1; i++) { if (s.c[i] < lo) lo = s.c[i]; if (s.c[i] > hi) hi = s.c[i]; sum += s.c[i]; }
  var chg = s.c[i1] / s.c[i0] - 1;
  document.getElementById("mCur").textContent = fmtNum(s.c[i1]);
  var el = document.getElementById("mChg");
  el.textContent = fmtPct(chg); el.className = "v " + (chg >= 0 ? "up" : "down");
  document.getElementById("mHigh").textContent = fmtNum(hi);
  document.getElementById("mLow").textContent = fmtNum(lo);
  document.getElementById("mAvg").textContent = fmtNum(sum / (i1 - i0 + 1));
  var cnt = 0;
  computed.fires.forEach(function (f) { if (f) for (var k = i0; k <= i1; k++) if (f[k]) cnt++; });
  document.getElementById("mSig").textContent = cnt;

  var lg = [];
  lg.push("<span><i style='background:#667eea'></i>" + t("price") + "</span>");
  var MACOL = ["#f59e0b","#0ea5e9","#10b981","#ef4444"];
  layout.mas.forEach(function (m2, k) { lg.push("<span><i style='background:" + MACOL[k % 4] + "'></i>MA" + m2.n + "</span>"); });
  if (layout.bb) lg.push("<span><i style='background:#764ba2'></i>Bollinger</span>");
  var env2 = (DATA.envelope || {})[state.ticker];
  if (env2 && state.env !== "off") {
    if (state.env === "ls") lg.push("<span><i style='background:#0891b2'></i>" + t("envLs") + " " + (env2.annual_ls * 100).toFixed(2) + "%/y</span>");
    else (state.env === "both" ? ["lower", "upper"] : [state.env]).forEach(function (k) {
      var L = (env2.lines || {})[k]; if (!L) return;
      var nm = k === "upper" ? t("envUpper") : k === "lower" ? t("envLower")
             : t("envRecent").replace("N", L.n) + "（" + L.anchors.join(" + ") + "）";
      lg.push("<span><i style='background:" + (k === "upper" ? "#b45309" : k === "lower" ? "#059669" : "#7c3aed") +
        "'></i>" + nm + " " + (L.annual * 100).toFixed(2) + "%/y</span>");
    });
  }
  lg.push("<span><i class='pt' style='background:rgba(5,150,105,.75)'></i>" + t("buy") + "</span>");
  lg.push("<span><i class='pt' style='background:rgba(220,38,38,.75)'></i>" + t("sell") + "</span>");
  document.getElementById("legend").innerHTML = lg.join("");
}

function renderSigs() {
  var box = document.getElementById("sigList"), s = computed.s;
  box.innerHTML = "";
  document.getElementById("sigEmpty").hidden = state.sigs.length > 0;
  state.sigs.forEach(function (sg, si) {
    var def = SIGNALS[sg.type];
    var d = document.createElement("div");
    d.className = "sig" + (sg.active ? "" : " off");
    var ps;
    if (sg.type === "pct-combo") {
      var boxes = (DATA.pctNames || []).map(function (m) {
        return "<label><input type='checkbox' data-pm='" + si + "' value='" + m + "'" +
          (sg.params.metrics.indexOf(m) >= 0 ? " checked" : "") + ">" + m + "</label>";
      }).join("");
      ps = "<div style='grid-column:1/3'><label>" + t("metrics") + "</label>" +
             "<div class='metricgrid'>" + boxes + "</div></div>" +
           "<div><label>" + t("mode") + "</label><select data-pmode='" + si + "'>" +
             ["mean","all","any"].map(function (m) {
               return "<option value='" + m + "'" + (sg.params.mode === m ? " selected" : "") + ">" +
                 t(m === "mean" ? "modeMean" : m === "all" ? "modeAll" : "modeAny") + "</option>";
             }).join("") + "</select></div>" +
           "<div><label>" + t("pThresh") + "</label>" +
             "<input type='number' step='0.1' min='0' max='100' value='" + sg.params.threshold +
             "' data-pth='" + si + "'></div>";
      if (!sg.params.metrics.length) ps += "<div style='grid-column:1/3;color:#dc2626;font-size:12px'>" + t("pickOne") + "</div>";
      else {
        var tp = comboTrigger(s, sg.params);
        var body;
        if (tp.v != null) {
          var gap = tp.v / s.c[s.n - 1] - 1;
          body = "<div style='font-size:17px;font-weight:700;color:#b45309'>" + fmtNum(tp.v) +
                 "<span style='font-size:12px;font-weight:500;color:#6b7280'>　" + fmtPct(gap, 2) + "</span></div>" +
                 "<div style='font-size:11px;color:#6b7280;margin-top:2px'>" + t("trigHint") +
                 (sg.params.metrics.indexOf("距MA50") >= 0 ? "<br>" + t("trigDrift") : "") + "</div>";
        } else {
          body = "<div style='font-size:11.5px;color:#6b7280'>" +
                 (tp.why === "mean" ? t("trigNA") : t("trigNone")) + "</div>";
        }
        ps += "<div style='grid-column:1/3;margin-top:2px;padding:8px 9px;background:#fffbeb;" +
              "border:1px solid #fde68a;border-radius:8px'>" +
              "<div style='font-size:11px;color:#92400e;letter-spacing:.02em'>" + t("trigPrice") + "</div>" +
              body + "</div>";
      }
    } else ps = def.params.map(function (p) {
      var opts;
      if (Array.isArray(p.opts[0])) {
        opts = p.opts.map(function (o) {
          return "<option value='" + o[0] + "'" + (sg.params[p.k] === o[0] ? " selected" : "") + ">" + t(o[1]) + "</option>";
        }).join("");
      } else {
        opts = p.opts.map(function (o) {
          return "<option value='" + o + "'" + (Number(sg.params[p.k]) === o ? " selected" : "") + ">" + o + "</option>";
        }).join("");
      }
      return "<div><label>" + t(p.label) + "</label><select data-si='" + si + "' data-k='" + p.k + "'>" + opts + "</select></div>";
    }).join("");

    var f = computed.fires[si], hit = "";
    if (sg.active && f) {
      var last = -1, total = 0;
      for (var k = 0; k < s.n; k++) if (f[k]) { last = k; total++; }
      if (last === s.n - 1)
        hit = "<div class='hit fire" + (def.buy ? "" : " sellfire") + "'><span>" + t("fired") + "</span><span>" + total + t("sigCount") + "</span></div>";
      else if (last >= 0)
        hit = "<div class='hit'><span>" + t("lastFire") + s.d[last] + "（" + (s.n - 1 - last) + t("daysAgo") + "）</span><span>" + total + t("sigCount") + "</span></div>";
      else
        hit = "<div class='hit'><span>" + t("never") + "</span><span>0</span></div>";
    }
    d.innerHTML =
      "<div class='top'>" +
        "<label class='switch'><input type='checkbox' data-tog='" + si + "'" + (sg.active ? " checked" : "") + "><span></span></label>" +
        "<span class='ttl'>" + def.label(sg.params) + "</span>" +
        "<span class='tag " + (def.buy ? "buy" : "sell") + "'>" + (def.buy ? t("buy") : t("sell")) + "</span>" +
        "<button class='x' data-del='" + si + "' title='" + t("del") + "'>×</button>" +
      "</div>" +
      "<div class='params'>" + ps + "</div>" +
      "<div class='desc'>" + def.desc[LANG === "zh" ? 0 : 1] + "</div>" + hit;
    box.appendChild(d);
  });
  box.querySelectorAll("select").forEach(function (el) {
    el.onchange = function () {
      var sg = state.sigs[+el.dataset.si], v = el.value;
      sg.params[el.dataset.k] = isNaN(Number(v)) ? v : Number(v);
      renderAll();
    };
  });
  box.querySelectorAll("[data-tog]").forEach(function (el) {
    el.onchange = function () { state.sigs[+el.dataset.tog].active = el.checked; renderAll(); };
  });
  box.querySelectorAll("[data-del]").forEach(function (el) {
    el.onclick = function () { state.sigs.splice(+el.dataset.del, 1); renderAll(); };
  });
  box.querySelectorAll("[data-pm]").forEach(function (el) {
    el.onchange = function () {
      var sg = state.sigs[+el.dataset.pm], m = el.value, k = sg.params.metrics.indexOf(m);
      if (el.checked && k < 0) sg.params.metrics.push(m);
      else if (!el.checked && k >= 0) sg.params.metrics.splice(k, 1);
      renderAll();
    };
  });
  box.querySelectorAll("[data-pmode]").forEach(function (el) {
    el.onchange = function () { state.sigs[+el.dataset.pmode].params.mode = el.value; renderAll(); };
  });
  box.querySelectorAll("[data-pth]").forEach(function (el) {
    el.onchange = function () {
      var v = parseFloat(el.value);
      if (!isNaN(v)) { state.sigs[+el.dataset.pth].params.threshold = v; renderAll(); }
    };
  });
}

function renderHits() {
  var C = computed, s = C.s, rows = [];
  for (var i = C.i0; i <= C.i1; i++) {
    state.sigs.forEach(function (sg, si) {
      var f = C.fires[si];
      if (f && f[i]) rows.push({ i: i, si: si });
    });
  }
  rows.reverse();
  var tb = document.getElementById("hitsTable");
  document.getElementById("hitsEmpty").hidden = rows.length > 0;
  if (!rows.length) { tb.innerHTML = ""; return; }
  var h = "<thead><tr><th>" + t("colDate") + "</th><th style='text-align:left'>" + t("colSignal") + "</th><th>" +
      t("colClose") + "</th><th>" + t("colR20") + "</th><th>" + t("colR60") + "</th></tr></thead><tbody>";
  rows.slice(0, 400).forEach(function (r) {
    var def = SIGNALS[state.sigs[r.si].type];
    var r20 = r.i + 20 < s.n ? s.c[r.i + 20] / s.c[r.i] - 1 : null;
    var r60 = r.i + 60 < s.n ? s.c[r.i + 60] / s.c[r.i] - 1 : null;
    h += "<tr><td class='date' data-i='" + r.i + "'>" + s.d[r.i] + "</td>" +
         "<td style='text-align:left'><span class='tag " + (def.buy ? "buy" : "sell") + "'>" +
           (def.buy ? t("buy") : t("sell")) + "</span> " + def.label(state.sigs[r.si].params) + "</td>" +
         "<td>" + fmtNum(s.c[r.i]) + "</td>" +
         "<td class='" + cls(r20) + "'>" + (r20 == null ? t("pending") : fmtPct(r20, 1)) + "</td>" +
         "<td class='" + cls(r60) + "'>" + (r60 == null ? t("pending") : fmtPct(r60, 1)) + "</td></tr>";
  });
  tb.innerHTML = h + "</tbody>";
  tb.querySelectorAll("td.date").forEach(function (el) {
    el.onclick = function () {
      hoverIdx = +el.dataset.i; draw();
      var r = cv.getBoundingClientRect();
      showTip(hoverIdx, layout.X(hoverIdx) , layout.Y(computed.s.c[hoverIdx]));
      cv.scrollIntoView({ behavior: "smooth", block: "center" });
    };
  });
  function cls(v) { return v == null ? "" : v >= 0 ? "up" : "down"; }
}

function renderStats() {
  var s = computed.s, tb = document.getElementById("statTable");
  var act = state.sigs.map(function (sg, si) { return { sg: sg, f: computed.fires[si] }; })
                      .filter(function (x) { return x.f; });
  if (!act.length) { tb.innerHTML = ""; return; }
  var h = "<thead><tr><th style='text-align:left'>" + t("colSignal") + "</th><th>" + t("colN") + "</th><th>" +
      t("colAvg20") + "</th><th>" + t("colEx20") + "</th><th>" + t("colAvg60") + "</th><th>" + t("colEx60") + "</th></tr></thead><tbody>";
  act.forEach(function (x) {
    var def = SIGNALS[x.sg.type];
    var p20 = perf(s, x.f, 20), p60 = perf(s, x.f, 60);
    var nfull = p60 ? p60.total : (p20 ? p20.total : 0);
    h += "<tr><td style='text-align:left'>" + def.label(x.sg.params) + "</td><td>" + nfull + "</td>" +
      cell(p20 && p20.avg) + cell(p20 && p20.ex, true) + cell(p60 && p60.avg) + cell(p60 && p60.ex, true) + "</tr>";
  });
  var b20 = perf(s, new Array(s.n).fill(false), 20), b60 = perf(s, new Array(s.n).fill(false), 60);
  h += "<tr style='color:#9ca3af'><td style='text-align:left'>" + t("colBase") + "</td><td>—</td>" +
       "<td>" + fmtPct(b20.base, 2) + "</td><td>—</td><td>" + fmtPct(b60.base, 2) + "</td><td>—</td></tr>";
  tb.innerHTML = h + "</tbody>";
  document.querySelector("[data-t='statNote']").innerHTML = t("statNote") + "<br>" + t("statNote2");
  function cell(v, ex) {
    if (v == null || isNaN(v)) return "<td>—</td>";
    return "<td class='" + (ex ? (v >= 0 ? "up" : "down") : "") + "'>" + fmtPct(v, 2) + "</td>";
  }
}

/* ============ 我的提醒（localStorage） ============ */
function watches() { try { return JSON.parse(localStorage.getItem("sv_watch") || "[]"); } catch (e) { return []; } }
function setWatches(w) { localStorage.setItem("sv_watch", JSON.stringify(w)); }
function renderWatch() {
  var w = watches(), box = document.getElementById("watchList");
  document.getElementById("watchEmpty").hidden = w.length > 0;
  box.innerHTML = "";
  w.forEach(function (item, wi) {
    var s = series(item.ticker), lines = [], anyFire = false;
    item.sigs.forEach(function (sg) {
      var def = SIGNALS[sg.type]; if (!def) return;
      var f;
      try { f = def.calc(s, sg.params); } catch (e) { return; }
      var fired = !!f[s.n - 1];
      if (fired) anyFire = true;
      lines.push("<div style='display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:1px 0'>" +
        "<span>" + (fired ? "●" : "○") + " " + def.label(sg.params) + "</span>" +
        "<span style='color:" + (fired ? (def.buy ? "#059669" : "#dc2626") : "#9ca3af") + "'>" +
        (fired ? t("buy") === "买入" && def.buy ? "触发" : (LANG === "zh" ? "触发" : "fired") : (LANG === "zh" ? "—" : "—")) + "</span></div>");
    });
    var d = document.createElement("div");
    d.className = "sig";
    d.innerHTML = "<div class='top'><span class='ttl'>" + item.ticker + " · " +
        (LANG === "zh" ? DATA.meta[item.ticker].zh : DATA.meta[item.ticker].en) + "</span>" +
        "<button class='x' data-lw='" + wi + "' title='" + t("load") + "' style='font-size:12px'>↺</button>" +
        "<button class='x' data-dw='" + wi + "'>×</button></div>" +
      "<div style='padding:8px 10px'>" + lines.join("") + "</div>" +
      "<div class='hit" + (anyFire ? " fire" : "") + "'><span>" + (anyFire ? t("fired") : t("notFired")) +
        "</span><span>" + s.d[s.n - 1] + "</span></div>";
    box.appendChild(d);
  });
  box.querySelectorAll("[data-dw]").forEach(function (el) {
    el.onclick = function () { var w2 = watches(); w2.splice(+el.dataset.dw, 1); setWatches(w2); renderWatch(); };
  });
  box.querySelectorAll("[data-lw]").forEach(function (el) {
    el.onclick = function () {
      var item = watches()[+el.dataset.lw];
      state.ticker = item.ticker;
      state.sigs = JSON.parse(JSON.stringify(item.sigs)).map(function (x) { x.active = true; return x; });
      document.getElementById("search").value = "";
      renderAll();
    };
  });
  document.querySelector("[data-t='watchNote']").innerHTML = t("watchNote");
}
document.getElementById("watchAdd").onclick = function () {
  var act = state.sigs.filter(function (s) { return s.active; });
  if (!act.length) return;
  var w = watches();
  w.push({ ticker: state.ticker, sigs: JSON.parse(JSON.stringify(act)), created: new Date().toISOString().slice(0, 10) });
  setWatches(w); renderWatch();
};

/* ============ 顶栏控件 ============ */
var rangeBox = document.getElementById("ranges");
function renderRanges() {
  rangeBox.innerHTML = "";
  RANGES.forEach(function (r, i) {
    var b = document.createElement("button");
    b.textContent = T.rangeName[LANG === "zh" ? 0 : 1][i];
    if (r[0] === state.range) b.className = "on";
    b.onclick = function () { state.range = r[0]; renderRanges(); renderAll(); };
    rangeBox.appendChild(b);
  });
  var envSel = document.createElement("select");
  envSel.style.cssText = "margin-left:10px;padding:4px 6px;border:1px solid var(--line);border-radius:7px;background:#fff;font-size:13px";
  var envOpts = [["off","envOff"],["upper","envUpper"],["lower","envLower"],["both","envBoth"],["ls","envLs"]];
  var envData = (DATA.envelope || {})[state.ticker];
  if (envData && envData.lines) {
    Object.keys(envData.lines).forEach(function (k) {
      if (k.indexOf("recent") !== 0) return;
      envOpts.push([k, null, t("envRecent").replace("N", envData.lines[k].n) +
        "（" + (envData.lines[k].annual * 100).toFixed(1) + "%/y）"]);
    });
  }
  envOpts.forEach(function (o) {
    var op = document.createElement("option");
    op.value = o[0]; op.textContent = o[2] || t(o[1]);
    if (state.env === o[0]) op.selected = true;
    envSel.appendChild(op);
  });
  envSel.onchange = function () { state.env = envSel.value; renderAll(); };
  if (!(DATA.envelope || {})[state.ticker]) envSel.disabled = true;

  var lg = document.createElement("button");
  lg.textContent = t("logAxis");
  lg.style.marginLeft = "10px";
  if (state.log) lg.className = "on";
  lg.onclick = function () { state.log = !state.log; renderRanges(); renderAll(); };
  rangeBox.appendChild(lg);
  rangeBox.appendChild(envSel);
}
var addSel = document.getElementById("addSel");
function renderAddSel() {
  addSel.innerHTML = SIG_ORDER.map(function (k) {
    return "<option value='" + k + "'>" + SIGNALS[k].name[LANG === "zh" ? 0 : 1] +
      "（" + (SIGNALS[k].buy ? t("buy") : t("sell")) + "）</option>";
  }).join("");
}
document.getElementById("addBtn").onclick = function () {
  var k = addSel.value;
  state.sigs.push({ type: k, active: true, params: Object.assign({}, SIGNALS[k].defaults) });
  renderAll();
};

/* 标的搜索 */
var search = document.getElementById("search"), sugg = document.getElementById("sugg");
function tickers() {
  return Object.keys(DATA.series).map(function (k) {
    return { k: k, name: LANG === "zh" ? DATA.meta[k].zh : DATA.meta[k].en };
  });
}
function showSugg(q) {
  var list = tickers().filter(function (x) {
    return !q || x.k.toLowerCase().indexOf(q) >= 0 || x.name.toLowerCase().indexOf(q) >= 0;
  });
  if (!list.length) { sugg.hidden = true; return; }
  sugg.innerHTML = list.map(function (x) {
    return "<div data-k='" + x.k + "'><b>" + x.k + "</b><span>" + x.name + "</span></div>";
  }).join("");
  sugg.hidden = false;
  sugg.querySelectorAll("div").forEach(function (el) {
    el.onclick = function () {
      state.ticker = el.dataset.k; sugg.hidden = true; search.value = ""; search.blur(); renderAll();
    };
  });
}
search.oninput = function () { showSugg(search.value.trim().toLowerCase()); };
search.onfocus = function () { showSugg(search.value.trim().toLowerCase()); };
/* 原来只能用鼠标点建议项，敲回车没有任何反应——看着就像「搜了但没数据」。
   现在回车直接选中当前高亮项（没高亮就选第一条），上下键可以在建议里移动。 */
function suggItems() { return Array.prototype.slice.call(sugg.querySelectorAll("div")); }
search.onkeydown = function (e) {
  if (sugg.hidden) {
    if (e.key === "Enter" || e.key === "ArrowDown") showSugg(search.value.trim().toLowerCase());
    if (sugg.hidden) return;
  }
  var items = suggItems();
  if (!items.length) return;
  var i = items.findIndex(function (el) { return el.classList.contains("on"); });
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (i >= 0) items[i].classList.remove("on");
    i = e.key === "ArrowDown" ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
    items[i].classList.add("on");
    items[i].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    (items[i >= 0 ? i : 0]).onclick();
  } else if (e.key === "Escape") {
    sugg.hidden = true; search.blur();
  }
};
document.addEventListener("click", function (e) {
  if (!sugg.contains(e.target) && e.target !== search) sugg.hidden = true;
});

document.getElementById("lang").onclick = function () {
  LANG = LANG === "zh" ? "en" : "zh";
  localStorage.setItem("sv_lang", LANG);
  applyLang();
  renderRanges(); renderAddSel(); renderAll();
};
function applyLang() {
  document.documentElement.lang = LANG;
  document.getElementById("lang").textContent = LANG === "zh" ? "EN" : "中文";
  document.querySelectorAll("[data-t]").forEach(function (el) {
    var k = el.dataset.t;
    if (k === "statNote") el.innerHTML = t(k) + "<br>" + t("statNote2");
    else if (k === "watchNote" || k === "foot1") el.innerHTML = t(k);
    else el.textContent = t(k);
  });
  document.querySelectorAll("[data-tph]").forEach(function (el) { el.placeholder = t(el.dataset.tph); });
  document.title = t("title");
  document.getElementById("built").textContent = t("built") + DATA.built;
}

window.addEventListener("resize", function () { if (computed) draw(); });

/* 给 tests/parity_check.py 用 */
window.__svSeries = series;
window.__svTrigger = triggerPrice;

applyLang(); renderRanges(); renderAddSel(); renderAll();
})();
