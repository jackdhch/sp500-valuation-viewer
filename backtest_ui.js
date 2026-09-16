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

    if (g.horizons) {
      var H = g.horizons;
      h += "<div class='btwrap2'><table><tr><th>哪天买</th>" +
        H.horizons.map(function (x) { return "<th class='r'>拿 " + esc(x) + "</th>"; }).join("") +
        "</tr>" +
        H.rows.map(function (r) {
          var base = r.name.indexOf("任意") === 0;
          return "<tr" + (base ? " class='kindrow'" : "") + "><td>" + esc(r.name) + "</td>" +
            r.cells.map(function (c) {
              return "<td class='r'>" + (c.n ? pct(c.cagr, 2) +
                "<br><span class='sub'>" + c.n + " 次</span>" : "—") + "</td>";
            }).join("") + "</tr>";
        }).join("") + "</table></div>";

      h += "<div class='btnote'><b>横着看每一行，差距是怎么塌掉的。</b><br>" +
        "拿 1 年：「回撤 20% 时买」年化 19.6%，「任意一天买」12.7%，差 <b>7 个百分点</b>。<br>" +
        "拿 5 年：13.8% 对 10.9%，差缩到 <b>2.9</b>。<br>" +
        "拿 10 年：9.75% 对 10.16% —— <b>反过来了</b>，等回撤再买反而略输。<br>" +
        "「创新高当天买」也一样：1 年是最好的几条之一（13.4%），到 15 年、20 年变成最差" +
        "（8.5% / 8.2%）。<b>买入时点的影响随持有期衰减，十年上下就基本消失了。</b>" +
        "</div>";

      if (g.waiting) {
        h += "<h3 style='font-size:14px;margin:18px 0 6px'>等待的代价：手上有一笔钱，马上买还是等回调？</h3>" +
          "<div class='btdesc'>对每个月的第一个交易日各模拟一次：一边当天就全买了拿到今天，" +
          "另一边持币等待、直到标普从 52 周高点回撤够深的第一天才买、再拿到今天。" +
          "现金不计息——这对等待方是偏宽松的假设。</div>" +
          "<div class='btwrap2'><table><tr><th>等多深的回调</th><th class='r'>等赢的概率</th>" +
          "<th class='r'>平均差</th><th class='r'>中位差</th><th class='r'>最好</th>" +
          "<th class='r'>最差</th><th class='r'>中位要等</th><th class='r'>至今没等到</th></tr>" +
          g.waiting.map(function (w) {
            return "<tr><td>等回撤 <b>" + w.dd + "%</b> 再买</td>" +
              "<td class='r'>" + w.win + "%</td>" +
              "<td class='r'>" + pct(w.mean) + "</td>" +
              "<td class='r'>" + pct(w.med) + "</td>" +
              "<td class='r'>" + pct(w.best) + "</td>" +
              "<td class='r'>" + pct(w.worst) + "</td>" +
              "<td class='r'>" + (w.wait_med === null ? "—" : w.wait_med + " 年") + "</td>" +
              "<td class='r'>" + w.never + " 次</td></tr>";
          }).join("") + "</table></div>" +
          "<div class='btnote'><b>等待的期望是负的，而且等得越深亏得越多。</b><br>" +
          "等 10% 的回调：只有 <b>28%</b> 的时候等赢了，平均落后 12.1%，最差的一次落后 67.3%，" +
          "还有 5 次到今天都没等到。<br>" +
          "等 20% 的回调：只有 <b>26%</b> 等赢，平均落后 25.6%，中位要空等 <b>3.7 年</b>，" +
          "<b>34 次到今天都没等到</b>——那些钱干躺了十几年。<br>" +
          "为什么会这样：标普500 长期向上，等待期间踏空的涨幅，通常比等到的那点折扣更大。" +
          "而且真等到 20% 回撤的时候，往往是 2008、2020 那种局面，那时候敢不敢按计划买是另一回事。" +
          "</div>";
      }

      h += "<div class='warn' style='margin-top:14px'><b>所以「一次性买入什么时候收益最大」的答案是：" +
        "就是现在。</b><br>" +
        "这不是鸡汤，是上面两张表的直接读数——等待的期望为负（三档回调深度全是负的），" +
        "而时点的影响在十年持有期上已经衰减到看不见。<br>" +
        "唯一说得通的例外：如果你恰好赶上已经回撤 20% 的时刻，那一年的赔率确实好看（19.6%），" +
        "但那是<b>已经发生</b>的状态，不是可以等来的计划——历史上有 34 次，等的人到今天还没等到。" +
        "</div>";
    }

    if (g.always) {
      g.always.forEach(function (blk) {
        h += "<h3 style='font-size:14px;margin:16px 0 6px'>" + esc(blk.label) +
             "　<span class='sub'>" + esc(blk.span[0]) + " ~ " + esc(blk.span[1]) + "</span></h3>";
        h += "<div class='btwrap2'><table><tr><th>方案</th><th>类型</th>" +
             "<th class='r'>年化</th><th class='r'>总收益</th>" +
             "<th class='r'>最大回撤</th><th class='r'>年化 ÷ 回撤</th></tr>" +
          blk.rows.map(function (r) {
            return "<tr><td>" + esc(r.name) + "</td>" +
              "<td><span class='sub'>" + esc(r.kind) + "</span></td>" +
              "<td class='r'>" + pct(r.cagr, 2) + "</td>" +
              "<td class='r'>" + pct(r.total) + "</td>" +
              "<td class='r'><span class='neg'>" + r.mdd + "%</span></td>" +
              "<td class='r'>" + (r.ret_per_dd === null ? "—" : r.ret_per_dd) + "</td></tr>";
          }).join("") + "</table></div>";
      });
      h += "<div class='btnote'>" +
        "<b>这两张表最该看的不是冠军，是同一个东西在两段里的翻转。</b><br>" +
        "· <b>长债（TLT）</b>近十一年年化 −0.9%，拉到二十四年是 +3.5%。同一个资产，两段结论相反——" +
        "近十一年是它历史上最惨的一段（加息周期杀债券），照那段选，会把一个正常资产判死刑。<br>" +
        "· <b>回撤翻倍</b>。标普500 在短区间里最大回撤 33.7%，长区间 55.2%——差别就是有没有包含 2008。" +
        "只看近十年会系统性低估自己要承受什么。<br>" +
        "· <b>动量轮动的价值只在长区间显出来</b>。它在短区间收益不突出，" +
        "但长区间的「年化 ÷ 回撤」是所有方案里最高的一档（0.37 对标普500 的 0.20）——" +
        "它赚的不是收益，是回撤。<br>" +
        "· <b>「100% 半导体年化 34%」不是一个可外推的结论</b>。那是近十一年这段特定行情的产物，" +
        "它的最大回撤 45%，而且没有经历过 2008。<br><br>" +
        "<b>所以「怎么找」的答案是</b>：不是找年化最高那行，是找<b>两段里都站得住、" +
        "且回撤你能拿得住</b>的那行。年化高低受时期摆布，回撤和「年化÷回撤」稳定得多。" +
        "</div>";
    }

    if (g.priors) {
      var base = g.priors[0];
      h += "<div class='btwrap2'><table><tr><th>策略</th><th class='r'>触发天数</th>" +
           "<th class='r'>一年后平均</th><th class='r'>中位</th><th class='r'>胜率</th>" +
           "<th class='r'>对基准</th></tr>";
      g.priors.forEach(function (o) {
        var isBase = o === base;
        var gap = isBase ? null : Math.round((o.mean - base.mean) * 10) / 10;
        h += "<tr" + (isBase ? " class='kindrow'" : "") + ">" +
          "<td><b>" + esc(o.name) + "</b><br><span class='sub'>" + esc(o.desc) + "</span></td>" +
          "<td class='r'>" + o.n + "</td>" +
          "<td class='r'>" + pct(o.mean) + "</td>" +
          "<td class='r'>" + pct(o.med) + "</td>" +
          "<td class='r'>" + o.win + "%</td>" +
          "<td class='r'>" + (gap === null ? "—" :
            "<span class='" + (gap > 0 ? "pos" : gap < 0 ? "neg" : "") + "'>" +
            (gap > 0 ? "+" : "") + gap.toFixed(1) + "pp</span>") + "</td></tr>";
      });
      h += "</table></div>";
      h += "<div class='btnote'>" +
        "<b>读这张表要小心三件事。</b><br>" +
        "一、<b>触发天数不是独立样本</b>。「回撤 20% 以上」那 " +
        (g.priors[3] ? g.priors[3].n : "几百") + " 天几乎全挤在 2008、2020 那几次里，" +
        "相邻两天的持有期重叠 99%，实际上只相当于三四次独立事件。它那个漂亮的平均值" +
        "说的是「那几次危机之后一年涨得多」，不是「这个规则可靠」。<br>" +
        "二、<b>平均和中位打架的地方要看中位</b>。「回撤 10% 以上」平均只有 " +
        (g.priors[2] ? g.priors[2].mean : "") + "%、低于基准，中位却有 " +
        (g.priors[2] ? g.priors[2].med : "") + "%、高于基准——" +
        "说明它多数时候还行，但少数几次亏得特别狠（2008 那种），把平均拖下去了。<br>" +
        "三、<b>定投和基准完全一样不是巧合</b>。每月买一次本来就是在时间轴上均匀采样，" +
        "它的期望就等于「随机挑一天买」。定投的价值从来不在提高收益，在于让人真的买得下去。" +
        "</div>";
    }

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
