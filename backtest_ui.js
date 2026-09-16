/* 策略回测页：只负责把 scripts/backtest.py 算好的结果摆出来。
 *
 * 这一页是**只读**的——策略写死在那个 Python 文件里，页面上改不了任何参数。
 * 要加策略或调参数，改 scripts/backtest.py 再跑一遍。
 */
(function () {
"use strict";

var loaded = false, wrap = document.getElementById("view-bt");
if (!wrap) return;

function esc(x) {
  return String(x === null || x === undefined ? "" : x)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function pct(v, digits) {
  if (v === null || v === undefined) return "—";
  var t = (v > 0 ? "+" : "") + Number(v).toFixed(digits === undefined ? 1 : digits) + "%";
  return "<span class='" + (v > 0 ? "pos" : v < 0 ? "neg" : "") + "'>" + t + "</span>";
}

function tradeTable(trades, showCycle) {
  return "<div class='btwrap2'><table><tr>" +
    (showCycle ? "<th>周期</th>" : "<th>年份</th>") +
    "<th>买入</th><th>卖出</th><th class='r'>持有</th>" +
    "<th class='r'>总收益</th><th class='r'>年化</th>" +
    (showCycle ? "" : "<th class='r'>同年年初买入</th><th class='r'>差距</th>") +
    "</tr>" +
    trades.map(function (t) {
      return "<tr>" +
        "<td>" + esc(showCycle ? (t.cycle || "") : (t.year || "")) +
        (t.truncated ? "<br><span class='sub'>不满 10 年，算到今天</span>" : "") + "</td>" +
        "<td>" + esc(t.buy) + "</td><td>" + esc(t.sell) + "</td>" +
        "<td class='r'>" + t.years + " 年</td>" +
        "<td class='r'>" + pct(t.total) + "</td>" +
        "<td class='r'>" + pct(t.cagr, 2) + "</td>" +
        (showCycle ? "" :
          "<td class='r'>" + pct(t.bench_total) + "</td><td class='r'>" + pct(t.gap) + "</td>") +
        "</tr>";
    }).join("") + "</table></div>";
}

function render(D) {
  var h = "";
  h += "<div class='btsec'><h2>策略回测</h2>" +
    "<div class='btdesc'>" + esc(D.series_note) + "<br>" +
    "数据区间 " + esc(D.data_range[0]) + " ~ " + esc(D.data_range[1]) +
    "　生成于 " + esc(D.built) + "</div>" +
    "<div class='warn'><b>这一页是只读的。</b>策略写死在 <code>scripts/backtest.py</code> 里，" +
    "页面上改不了任何参数——要加策略或调阈值，改那个文件再跑一遍。</div></div>";

  (D.groups || []).forEach(function (g) {
    h += "<div class='btsec'><h2>" + esc(g.title) + "</h2>" +
         "<div class='btdesc'>" + esc(g.desc) + "</div>";

    if (g.kinds) {
      h += "<div class='btwrap2'><table><tr><th>周期类型</th><th class='r'>次数</th>" +
           "<th class='r'>平均收益</th><th class='r'>中位</th><th class='r'>最差</th>" +
           "<th class='r'>最好</th><th class='r'>胜率</th></tr>";
      g.kinds.forEach(function (k) {
        h += "<tr class='kindrow'><td>" + esc(k.kind) +
             "<span class='sub'>（" + (k.dir === "hike" ? "加息" : "降息") + "）</span></td>" +
             "<td class='r'>" + k.n + "</td><td class='r'>" + pct(k.mean) + "</td>" +
             "<td class='r'>" + pct(k.med) + "</td><td class='r'>" + pct(k.min) + "</td>" +
             "<td class='r'>" + pct(k.max) + "</td><td class='r'>" + k.win + "%</td></tr>";
        k.trades.forEach(function (t) {
          h += "<tr><td colspan='2'><span class='sub'>" + esc(t.cycle) + "</span></td>" +
               "<td class='r'>" + pct(t.total) + "</td>" +
               "<td colspan='4'><span class='sub'>开始时 CPI " + esc(t.cpi_start) +
               "%　起始利率 " + esc(t.start_rate) + "%　速度 " + esc(t.speed) + "bp/年" +
               (t.src ? "　" + esc(t.src) : "") + "</span></td></tr>";
        });
      });
      h += "</table></div>";
    }

    (g.strategies || []).forEach(function (s) {
      h += "<h3 style='font-size:14px;margin:16px 0 6px'>" + esc(s.name) + "</h3>";
      if (s.sum) {
        h += "<div class='btdesc'>" + s.sum.n + " 笔：平均 " + pct(s.sum.mean) +
             "、中位 " + pct(s.sum.med) + "、最差 " + pct(s.sum.min) +
             "、最好 " + pct(s.sum.max) + "、胜率 " + s.sum.win + "%" +
             (s.sum.n < 5 ? "　<b>样本只有 " + s.sum.n + " 笔，统计上说明不了什么</b>" : "") +
             "</div>";
      }
      h += tradeTable(s.trades, g.id !== "worst");
      if (s.cash) {
        h += "<div class='btnote'>把它当成一条资金曲线看（只在信号期在场，其余时间持币不计息）：" +
             s.cash.years + " 年里在场 <b>" + s.cash.in_market_pct + "%</b> 的时间，" +
             "总收益 " + pct(s.cash.total) + "、年化 " + pct(s.cash.cagr, 2) + "。</div>";
      }
    });

    if (g.bench) {
      h += "<div class='btnote'><b>基准 · " + esc(g.bench.name || "买入持有") + "</b>：" +
           esc(g.bench.buy) + " 到 " + esc(g.bench.sell) + "，" + g.bench.years + " 年，" +
           "总收益 " + pct(g.bench.total) + "、年化 " + pct(g.bench.cagr, 2) + "。<br>" +
           "为什么基准要这么设：策略 1 和 2 买的就是标普500 本身，" +
           "如果基准取「同一天买、同一天卖」，那算出来会和策略一模一样，等于什么也没比。" +
           "要比的是<b>择时有没有用</b>——只在信号期在场，对上一直满仓。</div>";
    }
    h += "</div>";
  });

  // 周期清单与分类规则
  var cy = D.cycles || [];
  h += "<div class='btsec'><h2>周期是怎么划的、类型是怎么分的</h2>" +
    "<div class='btdesc'>" +
    "<b>周期边界</b>：2008 年 12 月之后用美联储目标利率上限（每次调息的日期和幅度都是准的），" +
    "之前用 3 个月国债月均推导——反向回撤超过 50bp 才认一个拐点，滤掉月度噪声。" +
    "两段都只保留幅度 ≥ 100bp 且持续 ≥ 6 个月的。早年那段是<b>月度精度</b>，" +
    "而且国债是市场利率不是政策利率，位置会有偏差。<br>" +
    "<b>加息分三类</b>（阈值是本页定的，不是官方口径）：" +
    "开始时 CPI 同比 ≥ 4% → <b>抗通胀</b>；否则起始利率 ≤ 1.5% → <b>正常化</b>；其余 → <b>预防过热</b>。<br>" +
    "<b>降息分两类</b>：降息速度 ≥ 250bp/年 → <b>衰退式救火</b>；否则 → <b>预防式降息</b>。<br>" +
    "两个判据都改过一次：加息原本看「整个周期内的 CPI 峰值」，那样 2004 年那轮会被判成抗通胀——" +
    "可 4.7% 的通胀是 2006 年周期快结束时才出现的，是加息的结果不是起因。" +
    "降息原本只看降幅，那样 2008 下半年（只降了 183bp）会被判成预防式——" +
    "可那正是雷曼倒闭、利率砸到零的三个月，降幅小是因为已经没空间可降了。" +
    "</div><div class='btwrap2'><table><tr><th>方向</th><th>类型</th><th>起止</th>" +
    "<th class='r'>幅度</th><th class='r'>时长</th><th class='r'>速度</th>" +
    "<th class='r'>起始利率</th><th class='r'>开始时CPI</th><th>来源</th></tr>" +
    cy.map(function (c) {
      return "<tr><td>" + (c.dir === "hike" ? "加息" : "降息") + "</td>" +
        "<td><b>" + esc(c.kind) + "</b></td>" +
        "<td>" + esc(c.start) + " ~ " + esc(c.end) + "</td>" +
        "<td class='r'>" + (c.bp > 0 ? "+" : "") + c.bp + "bp</td>" +
        "<td class='r'>" + c.years + " 年</td>" +
        "<td class='r'>" + esc(c.speed) + "bp/年</td>" +
        "<td class='r'>" + esc(c.start_rate) + "%</td>" +
        "<td class='r'>" + esc(c.cpi_start) + "%</td>" +
        "<td><span class='sub'>" + esc(c.src) + "</span></td></tr>";
    }).join("") + "</table></div></div>";

  wrap.innerHTML = h;
}

window.__showBacktest = function () {
  if (loaded) return;
  wrap.innerHTML = "<div style='padding:48px;text-align:center;color:var(--ink3)'>加载中…</div>";
  var s = document.createElement("script");
  s.src = "backtest.js?v=" + encodeURIComponent((window.VAL_INDEX || {}).built || Date.now());
  s.onload = function () {
    if (!window.BACKTEST) {
      wrap.innerHTML = "<div style='padding:48px;text-align:center;color:var(--ink3)'>回测数据是空的</div>";
      return;
    }
    loaded = true;
    render(window.BACKTEST);
  };
  s.onerror = function () {
    wrap.innerHTML = "<div style='padding:48px;text-align:center;color:var(--ink3)'>回测数据加载失败</div>";
  };
  document.head.appendChild(s);
};
})();
