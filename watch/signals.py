"""10 个技术信号的 Python 实现，与 site/viewer.js 中的 JS 实现逐日对齐。

两份实现必须给出完全相同的触发日；tests/parity_check.py 会实际打开页面比对，
改动任何一边都要重跑它。参数默认值取自 yourtimetobuy.com 前端（2026-09-11 抓取）。
"""
import csv
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEFAULTS = {
    "nweek-low":       {"weeks": 8, "fluctuation": 0},
    "nweek-high":      {"weeks": 8, "fluctuation": 0},
    "ma-buy":          {"ma1": 50, "ma2": 200, "direction": "below", "distancePct": 0},
    "ma-sell":         {"ma1": 50, "ma2": 200, "direction": "cross-down", "distancePct": 0},
    "rsi-oversold":    {"threshold": 30, "period": 14},
    "rsi-overbought":  {"threshold": 70, "period": 14},
    "bb-lower":        {"distancePct": 0, "period": 20, "stdDev": 2},
    "bb-upper":        {"distancePct": 0, "period": 20, "stdDev": 2},
    "adx-trend-buy":   {"threshold": 25},
    "adx-trend-sell":  {"threshold": 25},
}
IS_BUY = {"nweek-low": True, "nweek-high": False, "ma-buy": True, "ma-sell": False,
          "rsi-oversold": True, "rsi-overbought": False, "bb-lower": True, "bb-upper": False,
          "adx-trend-buy": True, "adx-trend-sell": False}

DIR_ZH = {"below": "在下方", "above": "在上方", "cross-down": "向下穿越", "cross-up": "向上穿越"}


def label(kind, p):
    """与页面上显示的信号名一字不差。"""
    if kind in ("nweek-low", "nweek-high"):
        base = "%d周最%s" % (p["weeks"], "低" if kind == "nweek-low" else "高")
        return base + (" (±%g%%)" % p["fluctuation"] if p["fluctuation"] > 0 else "")
    if kind in ("ma-buy", "ma-sell"):
        return "均线%s点信号 (MA%d %s MA%d)" % (
            "低" if kind == "ma-buy" else "高", p["ma1"], DIR_ZH[p["direction"]], p["ma2"])
    if kind == "rsi-oversold":
        return "RSI超卖 (≤%g, 周期%d)" % (p["threshold"], p["period"])
    if kind == "rsi-overbought":
        return "RSI超买 (≥%g, 周期%d)" % (p["threshold"], p["period"])
    if kind == "bb-lower":
        return "BB下轨 (%d, %gσ)" % (p["period"], p["stdDev"])
    if kind == "bb-upper":
        return "BB上轨 (%d, %gσ)" % (p["period"], p["stdDev"])
    if kind == "adx-trend-buy":
        return "ADX上升趋势 (≥%g)" % p["threshold"]
    return "ADX下降趋势 (≥%g)" % p["threshold"]


# ---------- 读数据 ----------
BUILTIN_CSV = {
    "^GSPC": "data/sp500_index.csv", "^NDX": "data/ndx_index.csv",
    "VOO": "data/voo.csv", "QQQ": "data/qqq.csv",
}
START = "1990-01-01"


def load(ticker):
    rel = BUILTIN_CSV.get(ticker)
    path = os.path.join(ROOT, rel) if rel else os.path.join(
        ROOT, "data", "viewer", ticker.replace("^", "_") + ".csv")
    if not os.path.exists(path):
        raise SystemExit("找不到 %s 的数据：%s\n先跑 python3 scripts/build_viewer.py %s" % (ticker, path, ticker))
    d, o, h, l, c = [], [], [], [], []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["Date"][:10] < START:
                continue
            try:
                vo, vh, vl, vc = float(r["Open"]), float(r["High"]), float(r["Low"]), float(r["Close"])
            except (ValueError, KeyError, TypeError):
                continue
            if vc <= 0:
                continue
            d.append(r["Date"][:10]); o.append(vo); h.append(vh); l.append(vl); c.append(vc)
    return {"d": d, "o": o, "h": h, "l": l, "c": c, "n": len(d)}


# ---------- 指标 ----------
def sma(a, n):
    out = [None] * len(a); s = 0.0
    for i, v in enumerate(a):
        s += v
        if i >= n:
            s -= a[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def roll_min(a, n):
    out = [None] * len(a)
    for i in range(n - 1, len(a)):
        out[i] = min(a[i - n + 1:i + 1])
    return out


def roll_max(a, n):
    out = [None] * len(a)
    for i in range(n - 1, len(a)):
        out[i] = max(a[i - n + 1:i + 1])
    return out


def rsi(c, n):
    out = [None] * len(c)
    if len(c) <= n:
        return out
    ag = al = 0.0
    for i in range(1, n + 1):
        dd = c[i] - c[i - 1]
        if dd >= 0: ag += dd
        else: al -= dd
    ag /= n; al /= n
    out[n] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    for i in range(n + 1, len(c)):
        dd = c[i] - c[i - 1]
        ag = (ag * (n - 1) + (dd if dd > 0 else 0)) / n
        al = (al * (n - 1) + (-dd if dd < 0 else 0)) / n
        out[i] = 100.0 if al == 0 else 100 - 100 / (1 + ag / al)
    return out


def boll(c, n, k):
    mid = sma(c, n)
    up = [None] * len(c); lo = [None] * len(c)
    for i in range(n - 1, len(c)):
        s = sum((c[j] - mid[i]) ** 2 for j in range(i - n + 1, i + 1))
        sd = math.sqrt(s / n)          # 总体标准差，与主流图表软件一致
        up[i] = mid[i] + k * sd; lo[i] = mid[i] - k * sd
    return mid, up, lo


def adx(s, n=14):
    N = s["n"]; h, l, c = s["h"], s["l"], s["c"]
    tr = [0.0] * N; pdm = [0.0] * N; mdm = [0.0] * N
    for i in range(1, N):
        up = h[i] - h[i - 1]; dn = l[i - 1] - l[i]
        pdm[i] = up if (up > dn and up > 0) else 0.0
        mdm[i] = dn if (dn > up and dn > 0) else 0.0
        tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
    A = [None] * N; P = [None] * N; M = [None] * N
    atr = ap = am = None; dxs = []; adxv = None
    for i in range(1, N):
        if i < n:
            continue
        if i == n:
            atr = sum(tr[1:n + 1]); ap = sum(pdm[1:n + 1]); am = sum(mdm[1:n + 1])
        else:
            atr = atr - atr / n + tr[i]; ap = ap - ap / n + pdm[i]; am = am - am / n + mdm[i]
        if atr == 0:
            continue
        pdi = 100 * ap / atr; mdi = 100 * am / atr
        P[i] = pdi; M[i] = mdi
        tot = pdi + mdi
        dx = 0.0 if tot == 0 else 100 * abs(pdi - mdi) / tot
        dxs.append(dx)
        if len(dxs) == n:
            adxv = sum(dxs) / n; A[i] = adxv
        elif len(dxs) > n:
            adxv = (adxv * (n - 1) + dx) / n; A[i] = adxv
    return A, P, M


# ---------- 信号 ----------
def fire(kind, s, p=None):
    """返回长度 = s['n'] 的布尔列表。"""
    p = dict(DEFAULTS[kind], **(p or {}))
    N = s["n"]; c = s["c"]
    out = [False] * N

    if kind in ("nweek-low", "nweek-high"):
        # fluctuation 是「窗口区间幅度的百分比」，不是「相对最低价的百分比」，
        # 与 yourtimetobuy.com 口径一致，也与 site/viewer.js 的 calc 一致。
        n = max(2, int(round(p["weeks"] * 5)))
        mn = roll_min(c, n)
        mx = roll_max(c, n)
        f = p["fluctuation"] / 100.0
        for i in range(N):
            if mn[i] is None or mx[i] is None:
                continue
            if kind == "nweek-low":
                out[i] = c[i] <= mn[i] + f * (mx[i] - mn[i])
            else:
                out[i] = c[i] >= mx[i] - f * (mx[i] - mn[i])

    elif kind in ("ma-buy", "ma-sell"):
        a = sma(c, p["ma1"]); b = sma(c, p["ma2"]); d = p["distancePct"] / 100.0
        for i in range(1, N):
            if a[i] is None or b[i] is None:
                continue
            if p["direction"] == "below":
                out[i] = a[i] <= b[i] * (1 - d)
            elif p["direction"] == "above":
                out[i] = a[i] >= b[i] * (1 + d)
            elif a[i - 1] is not None and b[i - 1] is not None:
                if p["direction"] == "cross-down":
                    out[i] = a[i - 1] > b[i - 1] and a[i] <= b[i]
                else:
                    out[i] = a[i - 1] < b[i - 1] and a[i] >= b[i]

    elif kind in ("rsi-oversold", "rsi-overbought"):
        r = rsi(c, p["period"])
        for i in range(N):
            if r[i] is None:
                continue
            out[i] = r[i] <= p["threshold"] if kind == "rsi-oversold" else r[i] >= p["threshold"]

    elif kind in ("bb-lower", "bb-upper"):
        _, up, lo = boll(c, p["period"], p["stdDev"])
        for i in range(N):
            if kind == "bb-lower":
                out[i] = lo[i] is not None and c[i] <= lo[i] * (1 + p["distancePct"] / 100.0)
            else:
                out[i] = up[i] is not None and c[i] >= up[i] * (1 - p["distancePct"] / 100.0)

    elif kind in ("adx-trend-buy", "adx-trend-sell"):
        A, P, M = adx(s)
        for i in range(N):
            if A[i] is None or A[i] < p["threshold"]:
                continue
            out[i] = P[i] > M[i] if kind == "adx-trend-buy" else M[i] > P[i]
    else:
        raise ValueError("未知信号类型 %s" % kind)
    return out


# ---------- 相对百分位指标 ----------
# 「当日读数相对自己过去 WIN 个交易日的位置」，越极端（越像底）分越高，满分 100。
# point-in-time：只用当日及以前的数据；窗口内有效样本不足 MIN_OBS 就不出数
# （与 README 抄底分一节的口径一致）。
PCT_WIN, PCT_MIN_OBS = 756, 250
PCT_NAMES = ["RSI14", "RSI7", "距MA50", "距MA200", "BB位置", "回撤深度", "20日跌幅", "60日跌幅"]


def pct_metrics(s):
    """返回 {指标名: [0-100 的浮点或 None]}，长度 = s['n']。"""
    import bisect
    c = s["c"]
    n = len(c)
    r14, r7 = rsi(c, 14), rsi(c, 7)
    m50, m200 = sma(c, 50), sma(c, 200)
    _, up, lo = boll(c, 20, 2)
    mx252 = roll_max(c, 252)

    def div(a, b):
        return [None if (a[i] is None or b[i] is None or b[i] == 0) else a[i] / b[i] - 1 for i in range(n)]

    def chg(k):
        return [None] * k + [c[i] / c[i - k] - 1 for i in range(k, n)]

    bbpos = [None if (lo[i] is None or up[i] is None or up[i] == lo[i])
             else (c[i] - lo[i]) / (up[i] - lo[i]) for i in range(n)]
    raw = {"RSI14": r14, "RSI7": r7, "距MA50": div(c, m50), "距MA200": div(c, m200),
           "BB位置": bbpos, "回撤深度": div(c, mx252), "20日跌幅": chg(20), "60日跌幅": chg(60)}

    out = {}
    for nm in PCT_NAMES:
        v = raw[nm]
        col = [None] * n
        win = []
        for i in range(n):
            if i >= PCT_WIN and v[i - PCT_WIN] is not None:
                j = bisect.bisect_left(win, v[i - PCT_WIN])
                if j < len(win) and win[j] == v[i - PCT_WIN]:
                    win.pop(j)
            if v[i] is not None:
                bisect.insort(win, v[i])
            if v[i] is None or len(win) < PCT_MIN_OBS:
                continue
            col[i] = 100.0 * (1.0 - bisect.bisect_right(win, v[i]) / len(win))
        out[nm] = col
    return out
