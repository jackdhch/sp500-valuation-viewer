# -*- coding: utf-8 -*-
"""把 data/valuation/*.csv 的季度锚点合成日频估值序列，输出 site/valuation_data.js。

口径（与本项目既有做法一致，见 README「口径」一节）
------------------------------------------------
日频市盈率的**分子是真实的当日收盘价，分母是季度锚点插值出来的每股收益**：

    每股收益锚点 → 线性插值到每个交易日 → 当日市盈率 = 当日收盘价 ÷ 插值每股收益

这样曲线的日内波动来自真实价格，只有盈利预期按季度缓慢变化——符合实际，
分析师预期本来就不是天天变的。scripts/build_dataset.py 对标普500 的前瞻市盈率
用的就是同一套做法，本脚本复用它抽出来的 scripts/valuation_lib.py。

三个指标的锚点来源不同：
  pe      macrotrends 直接给了每股收益（eps 列），不用反推
  pb      macrotrends 直接给了每股净资产（bvps 列）
  fwd_pe  stockanalysis 只给比率，所以用「锚点日股价 ÷ 前瞻市盈率」反推前瞻每股收益

负市盈率（盈利为负）照常画进走势图，但不参与分位排名——见 valuation_lib 的说明。
"""
import csv
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from valuation_lib import (interp, clip_extrap, fixed_window_percentile,  # noqa: E402
                           status_label)

# 路径默认按脚本位置推导，这样这套脚本搬到别的机器（比如 GitHub Actions 的 runner）
# 也能直接跑；需要时用环境变量覆盖。
ROOT = os.environ.get("SP500_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("SP500_DATA") or f"{ROOT}/data"
VAL = f"{DATA}/valuation"
PRICE_DIR = f"{DATA}/viewer"
SITE = os.environ.get("SP500_SITE") or f"{ROOT}/site"

# 价格缓存超过这么多天就重新抓——否则本地重跑时会一直用旧价格，
# 页面上的市盈率看着在变其实分子是陈的。设 0 表示每次都重抓。
PRICE_MAX_AGE_DAYS = int(os.environ.get("SP500_PRICE_MAX_AGE", "1"))

# 最后一个锚点之后最多外推多少个日历天（季度财报间隔 ~90 天，给 120 天留一期余量）
MAX_EXTRAP = 120

# 比率的绝对值超过这个就当没意义，置空。
#
# 为什么要这条：市盈率 = 价格 ÷ 每股收益，每股收益在由正转负的途中会经过 0，
# 这一段市盈率会冲到 ±∞。亚马逊 2013 和 2022 两次就是——插值出来的市盈率飙到
# 35 万倍再翻成 -9 万倍，画在图上是一根从天到地的垂线，还会把同一张图里其余部分
# 全压成直线。这种数字本来也没有任何解读价值（盈利接近 0 的时候「贵不贵」无从谈起），
# 所以直接断开，图上留白，分位也不统计它们。
# 1000 倍这个门槛对正常标的没有影响：本页最高的 BE 是 338 倍、TSLA 332 倍。
RATIO_CAP = 1000

# 只合成前端要画的三个指标。市销率的锚点照抓不误（留在 CSV 里），
# 但不进 valuation_data.js——页面上没有它的入口，白白撑大文件。
METRICS = [("pe", "eps"), ("fwd_pe", None), ("pb", "bvps")]


def read_anchors(ticker):
    """读 data/valuation/<T>.csv，返回按日期排序的锚点列表。"""
    path = f"{VAL}/{ticker}.csv"
    if not os.path.exists(path):
        return []
    out = []
    with open(path) as f:
        for r in csv.DictReader(f):
            d = datetime.date.fromisoformat(r["period_end"])
            row = {"d": d}
            for k in ("price", "eps", "pe", "bvps", "pb", "sps", "ps", "fwd_pe"):
                v = r.get(k, "")
                v = float(v) if v not in ("", None) else None
                # macrotrends 在「公司当期亏损、这个比率没意义」时写 0 而不是留空，
                # 直接当成数值会把市盈率压成 0。比率列的 0 一律当缺失处理。
                # （每股收益 eps 是例外：它为负是真实信息，负市盈率就是这么来的。）
                if k in ("pe", "pb", "ps", "fwd_pe") and v == 0:
                    v = None
                row[k] = v
            out.append(row)
    return sorted(out, key=lambda x: x["d"])


# 内部代码 → yfinance 代码。黄金期货的代码里有等号，不适合直接当文件名和标的 id
YF_ALIAS = {"GOLD": "GC=F"}


def read_prices(ticker):
    """日频收盘价。优先用 data/viewer/<T>.csv 的缓存，没有就用 yfinance 抓并缓存。"""
    path = f"{PRICE_DIR}/{ticker}.csv"
    stale = True
    if os.path.exists(path):
        age = (datetime.datetime.now()
               - datetime.datetime.fromtimestamp(os.path.getmtime(path))).days
        stale = age >= PRICE_MAX_AGE_DAYS
    if stale:
        try:
            import yfinance as yf
        except ImportError:
            return {}
        try:
            df = yf.Ticker(YF_ALIAS.get(ticker, ticker)).history(period="max", auto_adjust=False)
        except Exception as e:
            print(f"    {ticker} 价格抓取失败（{e}），沿用本地缓存")
            df = None
        if df is None or df.empty:
            if os.path.exists(path):
                df = None          # 抓不到就退回缓存，不要把已有数据弄丢
            else:
                return {}
    if stale and df is not None:
        os.makedirs(PRICE_DIR, exist_ok=True)
        with open(path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["Date", "Close"])
            for idx, row in df.iterrows():
                w.writerow([idx.date().isoformat(), round(float(row["Close"]), 6)])
    out = {}
    with open(path) as f:
        for r in csv.DictReader(f):
            c = r.get("Close")
            if c:
                out[datetime.date.fromisoformat(r["Date"][:10])] = float(c)
    return out


def per_share_anchors(anchors, ticker_prices, ratio_key, per_share_key):
    """凑出「每股指标」的锚点序列。

    能直接读到每股值就直接用；只有比率的（前瞻市盈率）用锚点日股价反推。
    """
    pts = []
    for a in anchors:
        if per_share_key and a.get(per_share_key) is not None:
            if a[per_share_key] != 0:
                pts.append((a["d"], a[per_share_key]))
            continue
        ratio = a.get(ratio_key)
        px = a.get("price")
        if px is None:
            px = nearest_price(ticker_prices, a["d"])
        if ratio and px and ratio != 0:
            pts.append((a["d"], px / ratio))
    return sorted(pts)


def nearest_price(prices, day, back=7):
    """取该日或之前最近 back 天内的收盘价（锚点日可能不是交易日）。"""
    for k in range(back + 1):
        d = day - datetime.timedelta(days=k)
        if d in prices:
            return prices[d]
    return None


def build_one(ticker):
    anchors = read_anchors(ticker)
    prices = read_prices(ticker)
    if not anchors or not prices:
        return None
    dates = sorted(prices)
    # 起点取锚点首日，早于此的价格没有对应的盈利数据，画出来是空的
    first = min(a["d"] for a in anchors)
    dates = [d for d in dates if d >= first]
    if len(dates) < 60:
        return None

    out = {"d": [d.isoformat() for d in dates],
           # 价格序列给「价格 + 估值双轴」用；锚点位置给财季标记用
           "px": [round(prices[d], 4) for d in dates]}
    extrap = {}
    pct10 = {}
    for ratio_key, per_share_key in METRICS:
        pts = per_share_anchors(anchors, prices, ratio_key, per_share_key)
        if not pts:
            out[ratio_key] = [None] * len(dates)
            continue
        vals = interp(pts, dates, extend=True)
        vals, flag = clip_extrap(vals, max(p[0] for p in pts), dates, MAX_EXTRAP)
        series = []
        for d, v in zip(dates, vals):
            if v in (None, 0):
                series.append(None)
                continue
            x = prices[d] / v
            series.append(round(x, 3) if abs(x) <= RATIO_CAP else None)
        out[ratio_key] = series
        extrap[ratio_key] = flag
        p, n, years = fixed_window_percentile(series, dates, days=3650)
        cur = next((v for v in reversed(series) if v is not None), None)
        neg = cur is not None and cur < 0
        pct10[ratio_key] = {"pct": None if neg else p, "n": n, "years": years,
                            "neg": neg,
                            "status": "盈利为负" if neg else status_label(p)}

    # 一年前的市盈率，用来算个股卡上的「1Y PE 变化」
    y1 = dates[-1] - datetime.timedelta(days=365)
    i1 = next((i for i, d in enumerate(dates) if d >= y1), None)
    cur_pe = out["pe"][-1] if out.get("pe") else None
    old_pe = out["pe"][i1] if (i1 is not None and out.get("pe")) else None
    chg = (round(100.0 * (cur_pe / old_pe - 1), 1)
           if (cur_pe and old_pe and old_pe > 0 and cur_pe > 0) else None)

    # 每股收益锚点落在哪几个交易日上——图上画竖线用。
    # 注意这是**财季末**，不是财报发布日（发布通常还要晚三到六周），页面上要写清楚。
    dset = {d: i for i, d in enumerate(dates)}
    anchor_idx = sorted({dset[a["d"]] for a in anchors if a["d"] in dset})

    return {"series": out, "extrap": extrap, "pct10y": pct10, "pe_chg_1y": chg,
            "anchors": anchor_idx,
            "px": round(prices[dates[-1]], 4), "px_date": dates[-1].isoformat(),
            "first": dates[0].isoformat(), "last": dates[-1].isoformat()}


# ---------------------------------------------------------------- 指数型 ETF
#
# QQQ / VOO 不走「持仓加权合成」那条路，因为本项目已经有更好的东西：
# site/data.json 里的 ndx_pe / ndx_fpe / spx_pe / spx_fpe 是**指数官方口径**
# （纳指100 来自 Siblis Research，标普500 来自 multpl 与 FactSet 周报），
# 由 scripts/build_dataset.py 按 README「口径」一节的做法算出来的日频序列。
#
# 2026-09-15 交叉验证：本项目 2026-09-08 的 ndx_pe = 34.342、ndx_fpe = 24.529；
# 参考平台 2026-09-14 给的是 33.62 与 24.36 —— 隔了 6 个交易日、纳指本身在动，
# 这个吻合度说明两边是同一个口径。
#
# 而「持仓调和加权」（1 ÷ Σ(wᵢ/PEᵢ)）算出来的 QQQ 只有 28.90（2026-09-15 实测，
# 覆盖 92.7% 权重），接近 stockanalysis 给 ETF 的 29.78，但和指数口径差了一大截。
# 算术加权更离谱，是 91.20 —— 被少数几只高市盈率成分股拉飞，根本不能用。
INDEX_ETF = {
    "QQQ": {"name": "Invesco QQQ · 纳斯达克100", "pe": "ndx_pe", "fwd_pe": "ndx_fpe",
            "note": "纳斯达克100 指数口径（Siblis Research 季度锚点），非 ETF 持仓加权"},
    "VOO": {"name": "Vanguard 标普500", "pe": "spx_pe", "fwd_pe": "spx_fpe",
            "note": "标普500 指数口径（multpl 滚动市盈率 + FactSet 前瞻市盈率）"},
}


def build_index_etf(ticker, cfg, ds):
    """从 site/data.json 取现成的指数估值序列，裁掉两端的空值。"""
    dates_all = [datetime.date.fromisoformat(x) for x in ds["dates"]]
    cols = {}
    for key in ("pe", "fwd_pe"):
        cols[key] = ds.get(cfg[key]) or [None] * len(dates_all)
    # 有效区间取两条线里最早的那个起点
    idx = [i for i in range(len(dates_all))
           if cols["pe"][i] is not None or cols["fwd_pe"][i] is not None]
    if not idx:
        return None
    i0, i1 = idx[0], idx[-1]
    dates = dates_all[i0:i1 + 1]
    out = {"d": [d.isoformat() for d in dates]}
    pct10 = {}
    for key in ("pe", "fwd_pe"):
        series = cols[key][i0:i1 + 1]
        out[key] = series
        p, n, years = fixed_window_percentile(series, dates, days=3650)
        cur = next((v for v in reversed(series) if v is not None), None)
        neg = cur is not None and cur < 0
        pct10[key] = {"pct": None if neg else p, "n": n, "years": years, "neg": neg,
                      "status": "盈利为负" if neg else status_label(p)}
    px_col = ds.get(ticker.lower()) or []
    out["px"] = [px_col[i] if i < len(px_col) else None for i in range(i0, i1 + 1)]
    out["pb"] = [None] * len(dates)      # 指数口径没有现成的市净率序列
    pct10["pb"] = {"pct": None, "n": 0, "years": 0, "neg": False, "status": "无数据"}

    y1 = dates[-1] - datetime.timedelta(days=365)
    i_1y = next((i for i, d in enumerate(dates) if d >= y1), None)
    cur_pe = next((v for v in reversed(out["pe"]) if v is not None), None)
    old_pe = out["pe"][i_1y] if i_1y is not None else None
    chg = (round(100.0 * (cur_pe / old_pe - 1), 1)
           if (cur_pe and old_pe and old_pe > 0 and cur_pe > 0) else None)
    px = ds.get(ticker.lower()) or []
    last_px = next((v for v in reversed(px[:i1 + 1]) if v is not None), None) if px else None
    return {"series": out, "extrap": {}, "pct10y": pct10, "pe_chg_1y": chg,
            "px": last_px, "px_date": dates[-1].isoformat(),
            "first": dates[0].isoformat(), "last": dates[-1].isoformat()}


# ------------------------------------------------------- 持仓加权合成的 ETF
#
# 只有在「免费源能拿到的持仓权重足够覆盖」时才合成，否则宁可不画。
# 2026-09-15 实测各 ETF 在 stockanalysis 免费版上能拿到的权重覆盖：
#   SMH  25 只 / 100.0%  → 可以合成（它总共就 26 只持仓）
#   AIS  19 只 /  55.3%  → 覆盖一半都不到，而且是主动管理、持仓一个月就换一批，不合成
#   DRAM  5 只 /  14.7%  → 核心持仓是三星、SK海力士这些外国股，免费源拿不到，不合成
#
# 加权方式用**调和加权** 1 ÷ Σ(wᵢ/PEᵢ)，也就是「组合总市值 ÷ 组合总盈利」，这是
# 指数市盈率的正确算法。算术加权 Σ(wᵢ·PEᵢ) 会被少数几只高市盈率成分股拉飞——
# 2026-09-15 对 QQQ 实测：调和 28.90，算术 91.20，后者毫无意义。
WEIGHTED_ETF = {
    "SMH": {"name": "VanEck 半导体", "min_cover": 70.0},
}

# 这些只给当前值，不画历史（理由见上）
# 这两只的中文名写死，不要用网页 <title>——抓下来是 "AIS ETF Stock Price &amp; Overview"
SNAPSHOT_ONLY_NAME = {"AIS": "VistaShares 人工智能超级周期",
                      "DRAM": "Roundhill 内存芯片"}

SNAPSHOT_ONLY_ETF = {
    "AIS": "主动管理，且免费源只能拿到前 19 只持仓（权重 55.3%）。"
           "它 2026-08-13 还是 69 只、09-11 已变 63 只，用当前权重回溯历史没有意义。",
    "DRAM": "2026-04-02 才上市，历史不足 6 个月，任何分位都算不出来；"
            "且核心持仓（三星、SK 海力士）是外国股，免费源没有它们的估值序列。",
}

MIN_COVER_DEFAULT = 70.0


def build_weighted_etf(etf, cfg):
    """按持仓调和加权合成 ETF 的日频市盈率 / 市净率。"""
    hold_path = f"{VAL}/_holdings_{etf}.csv"
    if not os.path.exists(hold_path):
        return None, "没有持仓文件，先跑 scripts/fetch_valuation.py --etf"
    with open(hold_path) as f:
        holds = [(r["ticker"], float(r["weight_pct"])) for r in csv.DictReader(f)]
    if not holds:
        return None, "持仓文件是空的"

    # 成分股的日频序列
    parts, missing = {}, []
    for t, w in holds:
        r = build_one(t)
        if r is None:
            missing.append(t)
            continue
        parts[t] = {d: i for i, d in enumerate(r["series"]["d"])}, r["series"], w
    if not parts:
        return None, f"成分股一个都没有数据（缺 {missing}）"

    prices = read_prices(etf)
    if not prices:
        return None, "拿不到该 ETF 自己的价格序列"
    dates = [d.isoformat() for d in sorted(prices)]

    out = {"d": dates}
    cover_series = []
    for key in ("pe", "pb"):
        vals = []
        for di, ds in enumerate(dates):
            num_w, cov = 0.0, 0.0
            for t, (idx, ser, w) in parts.items():
                i = idx.get(ds)
                if i is None:
                    continue
                v = (ser.get(key) or [None] * len(ser["d"]))[i]
                if v is None or v <= 0:     # 亏损股不进调和平均，否则会把结果拉成负数
                    continue
                num_w += w / v
                cov += w
            if cov < cfg.get("min_cover", MIN_COVER_DEFAULT) or num_w <= 0:
                vals.append(None)
                if key == "pe":
                    cover_series.append(round(cov, 1))
                continue
            vals.append(round(cov / num_w, 3))
            if key == "pe":
                cover_series.append(round(cov, 1))
        out[key] = vals
    out["px"] = [round(prices[datetime.date.fromisoformat(d)], 4)
                 if datetime.date.fromisoformat(d) in prices else None for d in dates]
    out["fwd_pe"] = [None] * len(dates)   # 成分股的前瞻市盈率只有约 5 年，暂不合成

    pct10 = {}
    dlist = [datetime.date.fromisoformat(x) for x in dates]
    for key in ("pe", "pb", "fwd_pe"):
        p, n, years = fixed_window_percentile(out[key], dlist, days=3650)
        pct10[key] = {"pct": p, "n": n, "years": years, "neg": False,
                      "status": status_label(p)}

    y1 = dlist[-1] - datetime.timedelta(days=365)
    i_1y = next((i for i, d in enumerate(dlist) if d >= y1), None)
    cur_pe = next((v for v in reversed(out["pe"]) if v is not None), None)
    old_pe = out["pe"][i_1y] if i_1y is not None else None
    chg = (round(100.0 * (cur_pe / old_pe - 1), 1)
           if (cur_pe and old_pe and old_pe > 0 and cur_pe > 0) else None)

    cov_now = cover_series[-1] if cover_series else 0
    note = (f"{len(parts)} 只成分股调和加权合成（总市值÷总盈利），"
            f"当日覆盖权重 {cov_now}%。权重用的是当前权重回溯，历史上的权重变动未还原，"
            f"所以这是近似值，不是官方口径。")
    if missing:
        note += f" 缺少估值数据的成分股：{', '.join(missing)}。"
    return {"series": out, "extrap": {}, "pct10y": pct10, "pe_chg_1y": chg,
            "px": round(prices[sorted(prices)[-1]], 4), "px_date": dates[-1],
            "first": dates[0], "last": dates[-1], "note": note}, None


# ------------------------------------------------------------------- 黄金
#
# 黄金没有盈利也没有净资产，市盈率、市净率这套完全不适用。能拿来当「估值」用的，
# 是几把把它和别的东西相比的尺子——本页做三条：
#
#   real       实际金价：名义金价按 CPI 折算到当月购买力。这条最接近「估值分位」的含义，
#              问的是「以今天的钱衡量，黄金现在贵不贵」。1980 年和 2011 年的两次顶
#              在这条线上看得很清楚，而名义价看不出来。
#   spx_ratio  标普500 ÷ 金价：一份标普能换多少盎司黄金。高 = 股票相对黄金贵，
#              低 = 黄金相对股票贵。这就是老派的「道金比」换个分子。
#   nominal    名义金价，美元/盎司。只作参照，它长期单调上行，分位没有意义，
#              所以不参与「低估/高估」的判断。
#
# 数据：金价用 COMEX 期货连续合约（yfinance 的 GC=F，2000-08 起）；
# CPI 用 data/cpi_monthly.csv（月度，插值到交易日）；标普500 用 data/sp500_index.csv。
GOLD_METRICS = [
    {"key": "real", "label": "实际金价", "kpi": "实际金价（按今天的购买力）", "unit": " 美元"},
    {"key": "spx_ratio", "label": "标普500 ÷ 金价", "kpi": "一份标普换几盎司黄金", "unit": " 盎司"},
    {"key": "nominal", "label": "名义金价", "kpi": "名义金价", "unit": " 美元"},
]


def build_gold():
    prices = read_prices("GOLD")
    if not prices:
        return None, "拿不到金价（yfinance GC=F）"
    cpi_pts = []
    cpi_path = f"{DATA}/cpi_monthly.csv"
    if os.path.exists(cpi_path):
        with open(cpi_path) as f:
            for r in csv.DictReader(f):
                try:
                    cpi_pts.append((datetime.date.fromisoformat(r["date"]), float(r["value"])))
                except (ValueError, KeyError):
                    pass
    if not cpi_pts:
        return None, "缺 data/cpi_monthly.csv"
    cpi_pts.sort()

    spx = {}
    spx_path = f"{DATA}/sp500_index.csv"
    if os.path.exists(spx_path):
        with open(spx_path) as f:
            for r in csv.DictReader(f):
                c = r.get("Close")
                if c:
                    spx[datetime.date.fromisoformat(r["Date"][:10])] = float(c)

    dates = sorted(prices)
    cpi = interp(cpi_pts, dates, extend=True)
    cpi_now = cpi_pts[-1][1]
    # CPI 只发布到上个月，之后的日子就按最后一个月的水平算，不外推趋势
    cpi_last = max(d for d, _ in cpi_pts)

    out = {"d": [d.isoformat() for d in dates],
           "px": [round(prices[d], 2) for d in dates]}
    nominal, real, ratio = [], [], []
    for i, d in enumerate(dates):
        px = prices[d]
        nominal.append(round(px, 2))
        c = cpi[i]
        real.append(round(px / c * cpi_now, 2) if c else None)
        sp = spx.get(d)
        ratio.append(round(sp / px, 4) if (sp and px) else None)
    out["nominal"], out["real"], out["spx_ratio"] = nominal, real, ratio

    pct10 = {}
    for key in ("real", "spx_ratio"):
        p, n, years = fixed_window_percentile(out[key], dates, days=3650)
        pct10[key] = {"pct": p, "n": n, "years": years, "neg": False,
                      "status": status_label(p)}
    # 名义金价长期单调上行，分位永远贴着 100%，给出来只会误导
    pct10["nominal"] = {"pct": None, "n": 0, "years": 0, "neg": False,
                        "status": "不适用"}

    y1 = dates[-1] - datetime.timedelta(days=365)
    i1 = next((i for i, d in enumerate(dates) if d >= y1), None)
    chg = (round(100.0 * (real[-1] / real[i1] - 1), 1)
           if (i1 is not None and real[-1] and real[i1]) else None)

    note = ("黄金没有盈利与净资产，市盈率、市净率不适用。这里用三把尺子："
            "实际金价（名义价按 CPI 折算到当月购买力，CPI 更新到 "
            f"{cpi_last.isoformat()}）、标普500÷金价、名义金价。"
            "名义金价长期单调上行，不参与高估/低估判断。"
            "金价用 COMEX 期货连续合约（GC=F），2000 年 8 月起。")
    return {"series": out, "extrap": {}, "pct10y": pct10, "pe_chg_1y": chg,
            "anchors": [], "px": round(prices[dates[-1]], 2),
            "px_date": dates[-1].isoformat(),
            "first": dates[0].isoformat(), "last": dates[-1].isoformat(),
            "note": note}, None


# ---------------------------------------------------------------- 板块分类
#
# 热力图按板块分组要用。数据来源按可靠性排：
#   1. data/holdings/sp500_mcap.csv —— 标普500 成分股的 GICS 板块，本地现成的
#   2. data/holdings/wishlist_info.csv —— 自选清单的板块
#   3. yfinance 的 info["sector"] —— 补上面两个都没有的（主要是外国 ADR，
#      像 TSM、SAP、NVO 这些不在标普500 里）。抓一次缓存到 _sectors.json，不重复请求。
SECTOR_CACHE = None


def load_sectors(tickers):
    global SECTOR_CACHE
    if SECTOR_CACHE is not None:
        return SECTOR_CACHE
    out = {}
    for path, tcol, scol in [(f"{DATA}/holdings/sp500_mcap.csv", "ticker", "sector"),
                             (f"{DATA}/holdings/wishlist_info.csv", "ticker", "sector")]:
        if not os.path.exists(path):
            continue
        with open(path) as f:
            for r in csv.DictReader(f):
                if r.get(scol):
                    out.setdefault(r[tcol], r[scol])

    cache_path = f"{VAL}/_sectors.json"
    cached = {}
    if os.path.exists(cache_path):
        try:
            with open(cache_path) as f:
                cached = json.load(f)
        except (json.JSONDecodeError, OSError):
            cached = {}
    out.update({k: v for k, v in cached.items() if v})

    missing = [t for t in tickers if t not in out]
    if missing:
        try:
            import yfinance as yf
        except ImportError:
            missing = []
        for t in missing:
            try:
                sec = (yf.Ticker(YF_ALIAS.get(t, t)).info or {}).get("sector")
            except Exception:
                sec = None
            if sec:
                out[t] = sec
                cached[t] = sec
        if cached:
            with open(cache_path, "w") as f:
                json.dump(cached, f, ensure_ascii=False, indent=1, sort_keys=True)
        print(f"  板块分类：补抓 {len(missing)} 只，命中 {sum(1 for t in missing if t in out)}")
    SECTOR_CACHE = out
    return out


# GICS 板块的中文名。翻译只影响显示，分组仍按英文原值。
SECTOR_ZH = {
    "Technology": "信息技术", "Information Technology": "信息技术",
    "Communication Services": "通信服务", "Consumer Cyclical": "可选消费",
    "Consumer Discretionary": "可选消费", "Consumer Defensive": "必需消费",
    "Consumer Staples": "必需消费", "Healthcare": "医疗保健", "Health Care": "医疗保健",
    "Financial Services": "金融", "Financials": "金融", "Industrials": "工业",
    "Energy": "能源", "Utilities": "公用事业", "Real Estate": "房地产",
    "Basic Materials": "原材料", "Materials": "原材料",
}


def load_etf_snapshot():
    path = f"{VAL}/_etf_snapshot.csv"
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return {r["ticker"]: r for r in csv.DictReader(f)}


def load_snapshot():
    path = f"{VAL}/_snapshot.csv"
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return {r["ticker"]: r for r in csv.DictReader(f)}


def main():
    targets = sys.argv[1:]
    if not targets:
        # 只输出自选清单（加验证用的 MSFT）。data/valuation/ 下还躺着 SMH 成分股
        # （AVGO、INTC、TXN 等）的 CSV，那是合成 ETF 用的原料，不该出现在页面上。
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from fetch_valuation import WISHLIST, EXTRA_STOCKS
        want = list(WISHLIST) + list(EXTRA_STOCKS)
        # 再加上美股市值前 100（清单由 fetch 阶段从 stockanalysis 的排行页抓下来存着）
        top_path = f"{VAL}/_top100.json"
        if os.path.exists(top_path):
            try:
                with open(top_path) as f:
                    want += json.load(f)
            except (json.JSONDecodeError, OSError):
                pass
        # 再加上 Seeking Alpha 半年榜的 10 只（名单与出处见 _sa_top10.json，
        # 注意那是「Top 10 Stocks」不是「Alpha Picks」，两个是不同的产品）
        sa_path = f"{VAL}/_sa_top10.json"
        if os.path.exists(sa_path):
            try:
                with open(sa_path) as f:
                    want += (json.load(f).get("tickers") or [])
            except (json.JSONDecodeError, OSError):
                pass
        # Alpha Picks 公开可核实的那几只。注意那份名单**不是完整持仓**——
        # 完整的 30 只在付费墙后面拿不到，_sa_alpha_picks.json 的 _重要 字段写明了。
        ap_path = f"{VAL}/_sa_alpha_picks.json"
        if os.path.exists(ap_path):
            try:
                with open(ap_path) as f:
                    want += [h["ticker"] for h in (json.load(f).get("holdings") or [])]
            except (json.JSONDecodeError, OSError, KeyError, TypeError):
                pass
        seen, targets = set(), []
        for t in want:                       # 去重且保持顺序
            if t not in seen and os.path.exists(f"{VAL}/{t}.csv"):
                seen.add(t)
                targets.append(t)
    snap = load_snapshot()
    sectors = load_sectors(targets)
    payload = {"built": datetime.date.today().isoformat(), "meta": {}, "data": {}}

    # 指数型 ETF 先处理，数据来自 site/data.json（scripts/build_dataset.py 的产物）
    ds_path = f"{SITE}/data.json"
    if os.path.exists(ds_path):
        ds = json.load(open(ds_path))
        for t, cfg in INDEX_ETF.items():
            r = build_index_etf(t, cfg, ds)
            if r is None:
                continue
            payload["meta"][t] = {"name": cfg["name"], "peg": "", "mcap": "",
                                  "kind": "index_etf", "note": cfg["note"],
                                  "px": r.get("px"), "px_date": r.get("px_date"),
                                  "first": r["first"], "last": r["last"]}
            payload["data"][t] = {k: r.get(k) for k in
                                  ("series", "extrap", "pct10y", "pe_chg_1y", "anchors")}
            p10 = r["pct10y"]["pe"]
            print(f"{t:6} {r['first']}~{r['last']}  PE={r['series']['pe'][-1]}  "
                  f"十年分位={p10.get('pct')}({p10.get('years')}年,{p10.get('n')}点) "
                  f"{p10.get('status')}  [指数口径]")
    else:
        print("警告：site/data.json 不存在，QQQ / VOO 跳过（先跑 scripts/build_dataset.py）")

    # 持仓加权合成的 ETF
    esnap = load_etf_snapshot()
    for t, cfg in WEIGHTED_ETF.items():
        r, err = build_weighted_etf(t, cfg)
        if r is None:
            print(f"{t:6} 合成失败：{err}")
            continue
        es = esnap.get(t, {})
        payload["meta"][t] = {"name": cfg["name"], "peg": "", "mcap": es.get("aum", ""),
                              "kind": "weighted_etf", "note": r["note"],
                              "px": r.get("px"), "px_date": r.get("px_date"),
                              "first": r["first"], "last": r["last"]}
        payload["data"][t] = {k: r.get(k) for k in
                              ("series", "extrap", "pct10y", "pe_chg_1y", "anchors")}
        p10 = r["pct10y"]["pe"]
        cur = next((v for v in reversed(r["series"]["pe"]) if v is not None), None)
        print(f"{t:6} {r['first']}~{r['last']}  PE={cur}  "
              f"十年分位={p10.get('pct')}({p10.get('years')}年,{p10.get('n')}点) "
              f"{p10.get('status')}  [持仓合成] 对照 stockanalysis {es.get('pe', '?')}")

    # 黄金
    g, gerr = build_gold()
    if g is None:
        print(f"GOLD   跳过：{gerr}")
    else:
        payload["meta"]["GOLD"] = {
            "name": "黄金（COMEX）", "peg": "", "mcap": "", "kind": "macro",
            "note": g["note"], "metrics": GOLD_METRICS,
            "px": g["px"], "px_date": g["px_date"],
            "first": g["first"], "last": g["last"]}
        payload["data"]["GOLD"] = {k: g.get(k) for k in
                                   ("series", "extrap", "pct10y", "pe_chg_1y", "anchors")}
        p10 = g["pct10y"]["real"]
        print(f"GOLD   {g['first']}~{g['last']}  名义 ${g['px']}  "
              f"实际金价十年分位={p10.get('pct')}({p10.get('years')}年) {p10.get('status')}")

    # 只给当前值的 ETF
    for t, why in SNAPSHOT_ONLY_ETF.items():
        es = esnap.get(t)
        if not es:
            continue
        payload["meta"][t] = {"name": SNAPSHOT_ONLY_NAME.get(t, t), "peg": "",
                              "mcap": es.get("aum", ""),
                              "kind": "snapshot_etf", "note": why,
                              "cur_pe": es.get("pe", ""), "cur_pb": es.get("pb", ""),
                              "inception": es.get("inception", ""),
                              "holdings": es.get("holdings", ""),
                              "first": "", "last": ""}
        print(f"{t:6} 只给当前值 PE={es.get('pe')} PB={es.get('pb')} "
              f"成立于 {es.get('inception')}")

    for t in targets:
        if t in payload["data"]:
            continue
        r = build_one(t)
        if r is None:
            # 历史太短或压根没有估值数据（刚 IPO 的、OTC 粉单的），仍然在页面上列一张
            # 「仅当前值」的卡，把原因写清楚，比让它凭空消失好——否则用户会以为漏抓了。
            sn = snap.get(t, {})
            anchors = read_anchors(t)
            if sn or anchors:
                why = ("历史太短，做不出估值序列"
                       if anchors else "免费数据源没有这只标的的估值数据")
                if anchors:
                    why += f"（只有 {len(anchors)} 个季度锚点，最早 {min(a['d'] for a in anchors)}）"
                def _clean(v):
                    # macrotrends 用 0 表示「亏损，这个比率没意义」，直接显示成 0.0 会误导
                    try:
                        return "" if v in ("", None) or float(v) == 0 else str(v)
                    except (TypeError, ValueError):
                        return "" if v in ("n/a", "N/A", None) else str(v)
                payload["meta"][t] = {
                    "name": sn.get("name", t), "peg": sn.get("peg", ""),
                    "mcap": sn.get("mcap", ""), "kind": "stock", "has_series": False,
                    "cur_pe": _clean(sn.get("pe")), "cur_pb": _clean(sn.get("pb")),
                    "note": why, "first": "", "last": "",
                }
                print(f"{t:6} 只给当前值：{why}")
            else:
                print(f"{t:6} 跳过（既没有锚点也没有快照）")
            continue
        s = snap.get(t, {})
        sec = sectors.get(t, "")
        payload["meta"][t] = {
            "name": s.get("name", t), "peg": s.get("peg", ""),
            "mcap": s.get("mcap", ""), "kind": "stock",
            "sector": sec, "sector_zh": SECTOR_ZH.get(sec, sec or "未分类"),
            "px": r.get("px"), "px_date": r.get("px_date"),
            "first": r["first"], "last": r["last"],
        }
        payload["data"][t] = {k: r.get(k) for k in
                              ("series", "extrap", "pct10y", "pe_chg_1y", "anchors")}
        p10 = r["pct10y"].get("pe", {})
        print(f"{t:6} {r['first']}~{r['last']}  PE={r['series']['pe'][-1]}  "
              f"十年分位={p10.get('pct')}({p10.get('years')}年,{p10.get('n')}点) "
              f"{p10.get('status')}  1YΔ={r['pe_chg_1y']}%")

    attach_sa_analysis(payload)
    write_payload(payload)


def attach_sa_analysis(payload):
    """给两份 Seeking Alpha 名单算「加入时的估值分位 → 现在的估值分位」。

    这一栏想回答的是：这些量化选股买进去的那一刻，标的到底是便宜还是已经涨上去了。
    光看名单和涨幅看不出这个——涨得多既可能是「买得便宜后来涨回去」，
    也可能是「买在动量上一路追」。把加入时分位和当时到现在的股价涨幅并排放才分得清。

    分位用固定十年窗口、截止到加入那天算（`fixed_window_percentile` 的 asof 参数），
    只看那天之前的十年，不掺后来的数据。
    """
    out = {}
    for fname, key, label in [("_sa_top10.json", "tickers", "Top 10 半年榜"),
                              ("_sa_alpha_picks.json", "holdings", "Alpha Picks")]:
        path = f"{VAL}/{fname}"
        if not os.path.exists(path):
            continue
        try:
            with open(path) as f:
                doc = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        items = doc.get(key) or []
        # 半年榜是一次性发布的一份名单，没有逐只的加入日，就用发布日当加入日
        list_as_of = (doc.get("as_of") or "")[:7]
        rows = []
        for it in items:
            t = it if isinstance(it, str) else it.get("ticker")
            added = (list_as_of if isinstance(it, str)
                     else (it.get("added") or ""))
            note = "" if isinstance(it, str) else (it.get("note") or "")
            d = payload["data"].get(t)
            if not d:
                rows.append({"t": t, "added": added, "note": note, "no_data": True})
                continue
            ser = d["series"]
            dates = [datetime.date.fromisoformat(x) for x in ser["d"]]
            pe = ser.get("pe") or []
            px = ser.get("px") or []
            cur_pe = next((v for v in reversed(pe) if v is not None), None)
            cur_pct = ((d.get("pct10y") or {}).get("pe") or {}).get("pct")
            row = {"t": t, "added": added, "note": note,
                   "cur_pe": cur_pe, "cur_pct": cur_pct,
                   "cur_px": next((v for v in reversed(px) if v is not None), None)}
            if added:
                # 加入日取该月 15 号当天或之后最近的一个交易日（Alpha Picks 月中那次买入）
                try:
                    y, mth = [int(x) for x in added.split("-")[:2]]
                    want = datetime.date(y, mth, 15)
                except ValueError:
                    want = None
                idx = next((i for i, dd in enumerate(dates) if want and dd >= want), None)
                if idx is not None:
                    p_at, n_at, yr_at = fixed_window_percentile(pe, dates, days=3650,
                                                                asof=dates[idx])
                    row.update({"at_date": dates[idx].isoformat(),
                                "at_pe": pe[idx], "at_pct": p_at, "at_years": yr_at,
                                "at_px": px[idx] if idx < len(px) else None})
                    if row.get("at_px") and row.get("cur_px"):
                        row["px_chg"] = round((row["cur_px"] / row["at_px"] - 1) * 100, 1)
            rows.append(row)
        out[fname.replace("_sa_", "").replace(".json", "")] = {"label": label, "rows": rows}
    if out:
        payload["sa"] = out
        for k, v in out.items():
            withp = [r for r in v["rows"] if r.get("at_pct") is not None]
            if withp:
                avg = sum(r["at_pct"] for r in withp) / len(withp)
                print(f"{v['label']}：{len(withp)} 只算得出加入时分位，平均 {avg:.1f}%")


def _compact_dates(iso_dates):
    """日期数组压缩成「起始日 + 逐日增量」。

    5000 个 "2006-03-31" 要 60 KB，换成相对前一天的天数差（多数是 1 或 3）只要 10 KB 出头。
    前端在 valuation.js 的 expandDates() 里还原。
    """
    if not iso_dates:
        return "", []
    prev = datetime.date.fromisoformat(iso_dates[0])
    deltas = []
    for x in iso_dates[1:]:
        d = datetime.date.fromisoformat(x)
        deltas.append((d - prev).days)
        prev = d
    return iso_dates[0], deltas


def write_payload(payload):
    """拆成「一个索引 + 每只标的一个分片」，这样首屏不用等 4 MB。

    页面刚打开只需要卡片墙的那点摘要（索引约几十 KB），点进某只标的的详情页时
    才去取它自己的那份日频序列。原来是一个 4 MB 的 valuation_data.js 同步加载，
    跨境访问 GitHub Pages 要等很久，页面在那之前是空白的。
    """
    os.makedirs(SITE, exist_ok=True)
    part_dir = f"{SITE}/v"
    os.makedirs(part_dir, exist_ok=True)

    index = {"built": payload["built"], "meta": {}}
    # 除了 meta 和 data，payload 里其余的顶层内容（目前是 sa 那两份名单的分析）也带进索引
    for k, v in payload.items():
        if k not in ("built", "meta", "data"):
            index[k] = v
    total_part = 0
    for t, meta in payload["meta"].items():
        d = payload["data"].get(t)
        m = dict(meta)
        if d:
            s = d["series"]
            # 卡片墙要的就这几样：当前值、十年分位、一年变化
            keys = [x["key"] for x in (meta.get("metrics") or [])] or ["pe", "fwd_pe", "pb"]
            m["cur"] = {k: next((v for v in reversed(s.get(k) or []) if v is not None), None)
                        for k in keys}
            m["pct10y"] = d["pct10y"]
            m["pe_chg_1y"] = d["pe_chg_1y"]
            m["has_series"] = True

            d0, dd = _compact_dates(s["d"])
            part = {"d0": d0, "dd": dd,
                    "pe": _r2(s.get("pe")), "fwd_pe": _r2(s.get("fwd_pe")),
                    "pb": _r2(s.get("pb")), "px": _r2(s.get("px")),
                    "anchors": d.get("anchors") or [],
                    "extrap": {k: _rle(v) for k, v in (d.get("extrap") or {}).items()}}
            # 自定义指标（目前只有黄金那三条）也要进分片
            for mk in [x["key"] for x in (meta.get("metrics") or [])]:
                if mk in s:
                    part[mk] = _r2(s[mk])
            pp = f"{part_dir}/{t}.js"
            with open(pp, "w") as f:
                f.write("window.__valPart(" + json.dumps(t) + ",")
                json.dump(part, f, separators=(",", ":"), ensure_ascii=False)
                f.write(");")
            total_part += os.path.getsize(pp)
        else:
            m["has_series"] = False
        index["meta"][t] = m

    ip = f"{SITE}/valuation_index.js"
    with open(ip, "w") as f:
        f.write("window.VAL_INDEX=")
        json.dump(index, f, separators=(",", ":"), ensure_ascii=False)
        f.write(";")

    # 旧的单体文件不再需要，留着会让人以为还在用
    legacy = f"{SITE}/valuation_data.js"
    if os.path.exists(legacy):
        os.remove(legacy)

    n = sum(1 for m in index["meta"].values() if m.get("has_series"))
    print(f"\n写出 {ip}  {os.path.getsize(ip)/1024:.0f} KB（首屏只加载这个）")
    print(f"     {part_dir}/  {n} 个分片，合计 {total_part/1024:.0f} KB（点开标的时才加载）")


def _r2(arr):
    """数值留两位小数就够画图了，三位白白多占约 8% 体积。"""
    if not arr:
        return arr
    return [None if v is None else round(v, 2) for v in arr]


def _rle(flags):
    """外推标记是一长串 false 末尾几个 true，游程编码后只剩两三个数字。"""
    if not flags:
        return []
    out = []
    cur, n = flags[0], 0
    for v in flags:
        if v == cur:
            n += 1
        else:
            out.append(n)
            cur, n = v, 1
    out.append(n)
    return [1 if flags[0] else 0] + out


if __name__ == "__main__":
    main()
