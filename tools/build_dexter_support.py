# 小红书 @Dexter 支撑位 → 现价离支撑多远，给小程序用
# 输入：data/xhs_dexter/supports.json（人工从视频封面读的支撑，新视频只改这个文件）
# 输出：data/xhs_dexter/support.json（按「再跌多少到支撑」从近到远排好）
#       data/xhs_dexter/k/{代码}.json（supports.json 里带 chart_from 的代码：复权日 K 线，给详情页叠 Dexter 的画线用）
# 派生标的：和某个已有标的跟踪同一个东西（同一指数 / 同一金价），支撑按「同一时刻的价格比」换算，
#          所以派生标的的距离百分比和它的来源标的完全相同，只是换成了自己的价格。
#   python3 scripts/build_dexter_support.py            # 取价 + 输出
#   python3 scripts/build_dexter_support.py --selftest # 只跑自检，不联网
import json, os, sys, datetime
from pathlib import Path

# DEXTER_DIR：公开仓库的每日任务把支撑位从加密机密写到临时目录，用这个指过去（支撑位不进公开仓库）
D = Path(os.environ.get("DEXTER_DIR") or Path(__file__).resolve().parent.parent / "data" / "xhs_dexter")
# 派生标的：取价代码 → (来源代码, 页面上显示的代码, 中文名)。^GSPC、^NDX 是指数本身；GC=F 是 COMEX 黄金期货近月合约（比现货略高）
DERIVED = {
    "^GSPC": ("SPY", "SPX", "标普500指数"), "VOO": ("SPY", "VOO", "标普500ETF-先锋"),
    "^NDX": ("QQQ", "NDX", "纳斯达克100指数"), "QQQM": ("QQQ", "QQQM", "纳指100ETF-景顺"), "QNDX": ("QQQ", "QNDX", "纳指100ETF-道富"),
    "IAU": ("GLD", "IAU", "黄金ETF-iShares"), "GC=F": ("GLD", "GC", "纽约黄金期货"),
}

def build(sup, px, now):
    """sup: supports.json 的列表；px: {代码: (价格, 价格时间)}。返回输出字典。"""
    rows, missing = [], []
    for s in sup:
        t = s["ticker"]
        name = s.get("name") or t   # supports.json 里的中文名（人工补齐，腾讯行情的叫法为主）
        if s["support"] is None: missing.append({"ticker": t, "code": t, "name": name, "video": s["video"], "reason": s["method"]}); continue
        p = px.get(t)
        rows.append({"ticker": t, "code": t, "name": name, "chart": t if s.get("chart_from") else None, "support": s["support"], "price": p and round(p[0], 4), "price_time": p and p[1],
                     "video": s["video"], "method": s["method"], "note": s["note"], "derived_from": None})
    by = {r["ticker"]: r for r in rows}
    for t, (src, code, name) in DERIVED.items():
        a, b = by.get(src), px.get(t)
        if not (a and a["price"] and b): continue
        ratio = b[0] / a["price"]
        rows.append({"ticker": t, "code": code, "name": name, "chart": code if a["chart"] else None, "support": round(a["support"] * ratio, 3), "price": round(b[0], 4), "price_time": b[1],
                     "video": a["video"], "method": f"由 {src} 的支撑按价格比 {ratio:.4f} 换算", "note": "", "derived_from": src})
    for r in rows:   # 再跌多少（小数）到支撑；负数=已跌破。派生标的按定义等于来源的距离，直接沿用，免得舍入误差打乱排序
        r["dist"] = by[r["derived_from"]]["dist"] if r["derived_from"] else (
            round((r["price"] - r["support"]) / r["price"], 5) if r["price"] else None)
    rows.sort(key=lambda r: (r["dist"] is None, r["dist"] if r["dist"] is not None else 0, r["derived_from"] is not None))
    return {"updated_at": now, "source": "Yahoo Finance（yfinance），1 分钟线最新成交价；收盘后跑即为收盘价",
            "support_source": "小红书 @Dexter（DexterHu915）视频封面最下面那根水平线，人工读数，同一代码取最新一条视频",
            "rows": rows, "missing": missing}

def fetch(tickers):
    import yfinance as yf
    out = {}
    for t in tickers:
        try:
            h = yf.Ticker(t).history(period="5d", interval="1m")["Close"].dropna()
            out[t] = (float(h.iloc[-1]), h.index[-1].strftime("%Y-%m-%d %H:%M"))
        except Exception as e:
            print("取价失败", t, str(e)[:80], file=sys.stderr)
    return out

def kbars(t, start, bar="day"):
    """复权日 K 线，每根 [日期, 开, 高, 低, 收, r]。r = 当天复权收盘 / 原始收盘：
    Dexter 的画线存的是截图时的价格，详情页乘以截图那天的 r，就和今天的复权 K 线对齐（之后再除息也不用改画线）。"""
    import yfinance as yf
    iv = "1wk" if bar == "week" else "1d"   # 周线图（如 NOW 的封面）给周 K 线，日期是每周一
    adj = yf.Ticker(t).history(start=start, auto_adjust=True, interval=iv)
    raw = yf.Ticker(t).history(start=start, auto_adjust=False, interval=iv)["Close"]
    return {"code": t, "bar": bar, "bars": [[d.strftime("%Y-%m-%d"), *(round(float(x), 3) for x in a[["Open", "High", "Low", "Close"]]),
                                 round(float(a["Close"] / raw[d]), 5)] for d, a in adj.iterrows()]}

def selftest():
    sup = [{"ticker": "SPY", "name": "标普500ETF-SPDR", "support": 700.0, "video": "2026-09-16", "method": "x", "note": "", "chart_from": "2024-11-05"},
           {"ticker": "AAA", "support": 90.0, "video": "2026-09-01", "method": "x", "note": ""},
           {"ticker": "BBB", "support": None, "video": "2026-07-01", "method": "读不出", "note": ""}]
    px = {"SPY": (770.0, "t"), "AAA": (100.0, "t"), "^GSPC": (7700.0, "t")}
    o = build(sup, px, "now")
    r = {x["ticker"]: x for x in o["rows"]}
    assert abs(r["^GSPC"]["support"] - 7000) < 1e-6 and r["^GSPC"]["dist"] == r["SPY"]["dist"]   # 派生距离必须等于来源距离
    assert [x["ticker"] for x in o["rows"]] == ["SPY", "^GSPC", "AAA"]                           # 近→远，同距离时来源在前
    assert o["missing"][0]["ticker"] == "BBB" and "VOO" not in r                                   # 没取到价的派生不出
    assert (r["SPY"]["name"], r["^GSPC"]["code"], r["AAA"]["name"]) == ("标普500ETF-SPDR", "SPX", "AAA")  # 有中文名用中文名，没有就退回代码
    assert (r["SPY"]["chart"], r["^GSPC"]["chart"], r["AAA"]["chart"]) == ("SPY", "SPX", None)         # 派生标的看自己的图（线从来源换算）
    print("selftest ok")

if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest(); sys.exit()
    sup = json.load(open(D / "supports.json"))
    px = fetch([s["ticker"] for s in sup if s["support"] is not None] + list(DERIVED))
    now = datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec="seconds")
    o = build(sup, px, now)
    json.dump(o, open(D / "support.json", "w"), ensure_ascii=False, indent=1)
    (D / "k").mkdir(exist_ok=True)
    cf = {s["ticker"]: s["chart_from"] for s in sup if s.get("chart_from")}
    bars = {s["ticker"]: s.get("bar", "day") for s in sup}
    # 有图的标的，加上从它派生的标的（VOO、SPX…）：派生标的用自己的 K 线，文件里记下 src，详情页拿来源的画线按每天的价格比换算
    todo = [(t, t, None, f) for t, f in cf.items()] + [(t, code, src, cf[src]) for t, (src, code, _) in DERIVED.items() if src in cf]
    for t, code, src, start in todo:
        try:
            kb = kbars(t, start, bars.get(src or t, "day")); kb["code"] = code
            if src: kb["src"] = src
            json.dump(kb, open(D / "k" / f"{code}.json", "w"), separators=(",", ":"))
        except Exception as e: print("K 线失败", t, str(e)[:80], file=sys.stderr)
    print(len(o["rows"]), "行，缺支撑", len(o["missing"]), "，没取到价", sum(r["price"] is None for r in o["rows"]))
