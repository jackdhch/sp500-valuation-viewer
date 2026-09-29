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
      (g.horizons || []).forEach(function (H) {
        h += "<h3 style='font-size:14px;margin:18px 0 6px'>" + esc(H.label) +
             "　<span class='sub'>" + esc(H.span[0]) + " ~ " + esc(H.span[1]) +
             "　每格：平均 / 中位</span></h3>";
        h += "<div class='btwrap2'><table><tr><th>哪天买</th>" +
          H.horizons.map(function (x) { return "<th class='r'>拿 " + esc(x) + "</th>"; }).join("") +
          "</tr>" +
          H.rows.map(function (r) {
            var base = r.name.indexOf("任意") === 0;
            return "<tr" + (base ? " class='kindrow'" : "") + "><td>" + esc(r.name) + "</td>" +
              r.cells.map(function (c) {
                if (!c.n) return "<td class='r'>—</td>";
                return "<td class='r'>" + pct(c.cagr, 2) +
                  "<br><span class='sub'>中位 " + c.med.toFixed(2) + "%</span></td>";
              }).join("") + "</tr>";
          }).join("") + "</table></div>";
      });

      h += "<div class='btnote'><b>两段的结论是反的，这比任何单段的数字都重要。</b><br>" +
        "<b>全样本</b>（含 2000、2008 两次腰斩）：拿 1 年「回撤 20% 时买」19.6% 对「任意一天」12.7%，" +
        "差 7 个百分点；拿到 10 年反而输（9.75% 对 10.16%）。时点影响随持有期衰减到消失。<br>" +
        "<b>2010 年起</b>：「回撤 10% 时买」1 年 24.5%、中位 23.1%，把「任意一天」（15.1%）甩开近十个百分点，" +
        "而且**拿到 15 年都还领先**（15.5% 对 14.2%）。连「200 日均线下方买」都反超了。<br><br>" +
        "为什么会反过来：<b>2010 年以后每一次回撤都是 V 型反弹</b>（2010、2011、2015、2018、2020、2022），" +
        "没有一次演变成 2000、2008 那种跌两年半、腰斩一半的长熊。" +
        "「逢跌买入」在这种环境里几乎必胜，但它赌的是<b>每次跌都会很快涨回来</b>——" +
        "而这恰恰是被那十六年的样本喂出来的假设。<br>" +
        "所以你让我排除 00 和 08 是对的（平均确实会被拖），但排除之后要意识到：" +
        "<b>剩下的这段里没有一次真正的长熊，逢跌买入的漂亮数字是这个前提的产物</b>，不是它自身的属性。" +
        "中位数我也一并列出来了——这两段里平均和中位是同向移动的，说明不是被少数极端值拖累，" +
        "是整个分布搬了家。" +
        "</div>";

      if (g.waiting) {
        h += "<h3 style='font-size:14px;margin:18px 0 6px'>等待的代价：手上有一笔钱，马上买还是等回调？</h3>" +
          "<div class='btdesc'>对每个月的第一个交易日各模拟一次：一边当天就全买了拿到今天，" +
          "另一边持币等待、直到标普从 52 周高点回撤够深的第一天才买、再拿到今天。" +
          "现金不计息——这对等待方是偏宽松的假设。</div>" +
          "<div class='btwrap2'><table><tr><th>样本</th><th>等多深的回调</th>" +
          "<th class='r'>年化·马上买</th><th class='r'>年化·等待</th>" +
          "<th class='r'>等赢的概率</th>" +
          "<th class='r'>平均差</th><th class='r'>中位差</th><th class='r'>最好</th>" +
          "<th class='r'>最差</th><th class='r'>中位要等</th><th class='r'>至今没等到</th></tr>" +
          g.waiting.map(function (blk) {
            return blk.rows.map(function (w, i) {
              return "<tr>" + (i === 0 ? "<td rowspan='" + blk.rows.length + "'><b>" +
                     esc(blk.label) + "</b></td>" : "") +
                "<td>等回撤 <b>" + w.dd + "%</b></td>" +
                "<td class='r'>" + (w.now_cagr === null ? "—" : w.now_cagr.toFixed(2) + "%") + "</td>" +
                "<td class='r'>" + (w.wait_cagr === null ? "—" :
                  "<span class='" + (w.wait_cagr < w.now_cagr ? "neg" : "pos") + "'>" +
                  w.wait_cagr.toFixed(2) + "%</span>") + "</td>" +
                "<td class='r'>" + w.win + "%</td>" +
                "<td class='r'>" + pct(w.mean) + "</td>" +
                "<td class='r'>" + pct(w.med) + "</td>" +
                "<td class='r'>" + pct(w.best) + "</td>" +
                "<td class='r'>" + pct(w.worst) + "</td>" +
                "<td class='r'>" + (w.wait_med === null ? "—" : w.wait_med + " 年") + "</td>" +
                "<td class='r'>" + w.never + " 次</td></tr>";
            }).join("");
          }).join("") + "</table></div>" +
          "<div class='btnote'><b>年化这两列是怎么算的</b>（这正是「持币等待要不要计入分母」那个问题）：" +
          "两边的考察期完全相同——都从同一天出发、都算到今天。等待方前面那段空仓，" +
          "<b>收益按 0 算（现金不计息），但它照样占着时间，所以年化的分母里包含了它</b>。" +
          "所以「等 20% 回调」那行年化只有 9.53%（全样本）不是因为买得差，" +
          "是因为中位要空等 3.7 年，那 3.7 年摊进了分母。<br><br>" +
          "<b>这张表两段的结论是一致的：等待的期望是负的。</b><br>" +
          "去掉 2000 和 2008 之后，等 10% 回调的胜率从 28% 升到 36%、平均落后从 12.1% 收窄到 6.6%——" +
          "确实好看一些，<b>但仍然是负的</b>。等 20% 回调那一行几乎没变（26% → 27%，" +
          "两段都是 34 次到今天没等到）。<br>" +
          "为什么两段都负：标普500 长期向上，等待期间踏空的涨幅通常比等到的那点折扣更大，" +
          "这一条不依赖于有没有大熊市。<br>" +
          "<b>要把两件事分开</b>：「已经处在回撤 20% 的状态」买入，回报确实好（上面那张表）；" +
          "「持币等待回撤 20% 出现」，期望是负的（这张表）。前者是状态，后者是计划，不是一回事。" +
          "</div>";
      }

      if (g.sweep) {
        h += "<h3 style='font-size:14px;margin:20px 0 6px'>回撤阈值扫得细一点：10% 是不是最优？</h3>" +
          "<div class='btdesc'>把「回撤至少这么深时买入」的门槛从 0 扫到 40，" +
          "每一档都看买入后持有一年的中位收益。中位和样本量一起看——" +
          "门槛越深数字越漂亮，但样本越少，到后面就是几次危机的连续日子在撑着。</div>";
        g.sweep.forEach(function (blk) {
          var show = blk.rows.filter(function (r) { return r.th % 2 === 0 || r.th === 1; });
          h += "<div style='margin-top:8px'><b>" + esc(blk.label) + "</b>" +
            (blk.best_solid ? "　<span class='sub'>样本 ≥200 天里中位最高：回撤 ≥ " +
              blk.best_solid.th + "%（" + blk.best_solid.med + "%，" +
              blk.best_solid.n + " 天）</span>" : "") + "</div>" +
            "<div class='btwrap2'><table><tr><th>门槛</th>" +
            show.map(function (r) { return "<th class='r'>≥" + r.th + "%</th>"; }).join("") +
            "</tr><tr><td>一年后中位</td>" +
            show.map(function (r) { return "<td class='r'>" + pct(r.med, 1) + "</td>"; }).join("") +
            "</tr><tr><td>样本天数</td>" +
            show.map(function (r) { return "<td class='r'><span class='sub'>" + r.n + "</span></td>"; }).join("") +
            "</tr></table></div>";
        });
        h += "<div class='btnote'><b>10% 不是最优，但也没有一个真正的「最优点」。</b><br>" +
          "· <b>全样本</b>：中位数从 14.1%（不设门槛）一路单调升到 42.8%（≥40%），" +
          "<b>没有拐点</b>——越深越好。但样本从 9240 天掉到 76 天，那 76 天全是 2008 和 2020 的谷底附近，" +
          "说的是「在历史大底买很赚」，这句话正确但没法执行。样本还站得住（≥200 天）的范围里，" +
          "最好的是回撤 ≥29%（中位 30.5%，216 天）。<br>" +
          "· <b>2010 年起</b>：中位在 <b>11%</b> 见顶（23.1%，363 天），10% 和 12% 都差不多，" +
          "再深反而回落（14% 只有 20.7%）——因为这十六年里超过 15% 的回撤只出现过三四次，" +
          "样本稀薄到失去意义。<br>" +
          "· 所以「把 10% 调成 11%」是有据可依的微调，但那点差别（16.5%→16.7% / 23.1%→23.1%）" +
          "远小于「选哪段历史」带来的差别。<b>调阈值不是这里的主要矛盾。</b>" +
          "</div>";
      }

      if (g.bvw) {
        h += "<h3 style='font-size:14px;margin:20px 0 6px'>只有两个选项：现在全仓买，还是继续等更深的回撤？</h3>" +
          "<div class='btdesc'>按<b>当天的回撤深度</b>分桶。同一个桶里两条路：" +
          "「买」当天全仓买入；「等」持币等到回撤比现在再深 5 个百分点才买。" +
          "两边起点终点完全相同（都算到 2 年后），等待期收益按 0 算、时间照算。" +
          "看从哪个深度开始「买」稳定压过「等」。</div>";
        g.bvw.forEach(function (blk) {
          h += "<div style='margin-top:8px'><b>" + esc(blk.label) + "</b></div>" +
            "<div class='btwrap2'><table><tr><th>当前回撤</th><th class='r'>现在买·中位</th>" +
            "<th class='r'>继续等·中位</th><th class='r'>差</th>" +
            "<th class='r'>买赢的比例</th><th class='r'>样本</th></tr>" +
            blk.rows.map(function (r) {
              return "<tr><td>" + r.lo + " ~ " + r.hi + "%</td>" +
                "<td class='r'><b>" + pct(r.buy_med, 1) + "</b></td>" +
                "<td class='r'>" + pct(r.wait_med, 1) + "</td>" +
                "<td class='r'>" + pct(r.gap, 1) + "</td>" +
                "<td class='r'>" + r.buy_win + "%</td>" +
                "<td class='r'><span class='sub'>" + r.n + "</span></td></tr>";
            }).join("") + "</table></div>";
        });
        h += "<div class='btnote'><b>临界点是 0%——没有哪个深度值得再等。</b><br>" +
          "两段样本、七个深度桶，「现在买」的中位收益<b>全部</b>高于「继续等」。<br>" +
          "为什么差距这么大：看「继续等」那一列，回撤 5% 以上的桶里中位数<b>全是 0.00%</b>——" +
          "意思是超过一半的情况下，市场根本没有再深 5 个百分点，钱就一直空在手里，两年后还是那些钱。<br>" +
          "<b>但注意「买赢的比例」那一列只有 33%~64%</b>，不到一半的情况也不少。" +
          "这不矛盾：等待是「多数时候颗粒无收、少数时候抄到更低」，" +
          "中位数衡量的是多数时候，胜率衡量的是次数。" +
          "你问的是中位数，那答案就是——<b>任何深度，现在买都更好</b>。<br>" +
          "唯一的例外藏在最浅那个桶（0~2%）：差距只有 1.2~1.4 个百分点，" +
          "接近没有差别——市场在高位附近时，早买晚买确实差不多。" +
          "</div>";
      }

      h += "<div class='warn' style='margin-top:14px'><b>「一次性买入什么时候收益最大」——两段样本给的答案不同，" +
        "但有一条在两段里都成立。</b><br>" +
        "· <b>手上有钱就买，别等</b>：三档回调深度、两段样本，六个格子全是负期望。这条最稳。<br>" +
        "· <b>如果市场已经在回撤中</b>：全样本里这个优势会随持有期消失（10 年就反超了），" +
        "2010 年起这段则一直保持到 15 年。差别在于 2010 年后没出现过长熊——" +
        "所以这个优势能不能延续，等于在赌「以后的下跌还会像过去十六年那样很快涨回来」。<br>" +
        "· <b>拿得越久，怎么买越不重要</b>：全样本 10 年期上各条规则已经挤在 9.1%~10.2% 之间。" +
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
