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
            df = yf.Ticker(ticker).history(period="max", auto_adjust=False)
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

    out = {"d": [d.isoformat() for d in dates]}
    extrap = {}
    pct10 = {}
    for ratio_key, per_share_key in METRICS:
        pts = per_share_anchors(anchors, prices, ratio_key, per_share_key)
        if not pts:
            out[ratio_key] = [None] * len(dates)
            continue
        vals = interp(pts, dates, extend=True)
        vals, flag = clip_extrap(vals, max(p[0] for p in pts), dates, MAX_EXTRAP)
        series = [round(prices[d] / v, 3) if (v not in (None, 0)) else None
                  for d, v in zip(dates, vals)]
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

    return {"series": out, "extrap": extrap, "pct10y": pct10, "pe_chg_1y": chg,
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
        targets = [t for t in WISHLIST + EXTRA_STOCKS
                   if os.path.exists(f"{VAL}/{t}.csv")]
    snap = load_snapshot()
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
            payload["data"][t] = {k: r[k] for k in ("series", "extrap", "pct10y", "pe_chg_1y")}
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
        payload["data"][t] = {k: r[k] for k in ("series", "extrap", "pct10y", "pe_chg_1y")}
        p10 = r["pct10y"]["pe"]
        cur = next((v for v in reversed(r["series"]["pe"]) if v is not None), None)
        print(f"{t:6} {r['first']}~{r['last']}  PE={cur}  "
              f"十年分位={p10.get('pct')}({p10.get('years')}年,{p10.get('n')}点) "
              f"{p10.get('status')}  [持仓合成] 对照 stockanalysis {es.get('pe', '?')}")

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
            print(f"{t:6} 跳过（锚点或价格不足）")
            continue
        s = snap.get(t, {})
        payload["meta"][t] = {
            "name": s.get("name", t), "peg": s.get("peg", ""),
            "mcap": s.get("mcap", ""), "kind": "stock",
            "px": r.get("px"), "px_date": r.get("px_date"),
            "first": r["first"], "last": r["last"],
        }
        payload["data"][t] = {k: r[k] for k in ("series", "extrap", "pct10y", "pe_chg_1y")}
        p10 = r["pct10y"].get("pe", {})
        print(f"{t:6} {r['first']}~{r['last']}  PE={r['series']['pe'][-1]}  "
              f"十年分位={p10.get('pct')}({p10.get('years')}年,{p10.get('n')}点) "
              f"{p10.get('status')}  1YΔ={r['pe_chg_1y']}%")

    os.makedirs(SITE, exist_ok=True)
    with open(f"{SITE}/valuation_data.js", "w") as f:
        f.write("window.VAL_DATA=")
        json.dump(payload, f, separators=(",", ":"), ensure_ascii=False)
        f.write(";")
    out_path = f"{SITE}/valuation_data.js"
    size = os.path.getsize(out_path)
    print(f"\n写出 {out_path}  {size/1024:.0f} KB，{len(payload['data'])} 个标的")


if __name__ == "__main__":
    main()
