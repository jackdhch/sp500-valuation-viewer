#!/usr/bin/env python3
"""把本地价格 CSV 打包成 site/viewer_data.js，供 site/viewer.html 离线加载。

用法:
    python3 scripts/build_viewer.py                # 用内置的 4 个标的
    python3 scripts/build_viewer.py AAPL MSFT      # 额外用 yfinance 抓取代码并加入
抓来的新标的缓存在 data/viewer/<TICKER>.csv，下次无需联网。
"""
import csv
import math
import json
import os
import sys
from datetime import date, datetime

# 三个目录都可以用环境变量指定（同 build_valuation.py）：公开仓库的每日任务里站点文件在仓库根目录，
# 不在 site/ 下。不设环境变量时跟以前一样。
ROOT = os.environ.get("SP500_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("SP500_DATA") or os.path.join(ROOT, "data")
SITE = os.environ.get("SP500_SITE") or os.path.join(ROOT, "site")
CACHE = os.path.join(DATA, "viewer")

# 仓库里已有的四条序列：代码 -> (csv 路径, 中文名, 英文名)
BUILTIN = {
    "^GSPC": ("sp500_index.csv", "标普500指数", "S&P 500 Index"),
    "^NDX": ("ndx_index.csv", "纳斯达克100指数", "Nasdaq 100 Index"),
    "VOO": ("voo.csv", "先锋标普500 ETF", "Vanguard S&P 500 ETF"),
    "QQQ": ("qqq.csv", "景顺纳指100 ETF", "Invesco QQQ Trust"),
}

# 页面只需要 1990 年以后的数据：ADX/RSI/布林带都是短周期指标，更早的历史只会让
# 文件变大而不会改变任何一个信号的判定。^GSPC 的 1927-1989 段留在 data/ 里备查。
START = "1990-01-01"


def read_csv(path):
    """读价格 CSV。四个内置标的是完整 OHLCV；data/viewer/ 下有些缓存文件只有
    Date,Close 两列（别的流程写的），那种就用收盘价填充开高低——
    影响的只有「回撤深度」（252 日最高会用收盘价而不是最高价），对指数类标的无影响。"""
    rows = []
    only_close = False
    with open(path, newline="", encoding="utf-8") as f:
        rd = csv.DictReader(f)
        cols = rd.fieldnames or []
        only_close = not all(k in cols for k in ("Open", "High", "Low"))
        for r in rd:
            d = r["Date"][:10]
            if d < START:
                continue
            try:
                c = float(r["Close"])
                if only_close:
                    o = h = l = c
                else:
                    o, h, l = float(r["Open"]), float(r["High"]), float(r["Low"])
            except (ValueError, KeyError, TypeError):
                continue
            # 空值：盘中 Yahoo 给的「今天」那行常是 NaN，float("nan") 不报错，要自己挡掉（2026-09-28 每日任务因此失败过一次）
            if c <= 0 or not all(math.isfinite(x) for x in (o, h, l, c)):
                continue
            rows.append((d, o, h, l, c))
    rows.sort(key=lambda x: x[0])
    if only_close and rows:
        print("    （%s 只有收盘价，开高低按收盘价填充）" % os.path.basename(path))
    return rows


def fetch(ticker):
    """用 yfinance 抓一个新代码，带本地缓存。"""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, ticker.replace("^", "_") + ".csv")
    if os.path.exists(path):
        return path, None
    import yfinance as yf
    t = yf.Ticker(ticker)
    df = t.history(period="max", auto_adjust=False)
    if df.empty:
        raise SystemExit("抓不到 %s 的数据" % ticker)
    df = df[["Open", "High", "Low", "Close", "Volume"]]
    df.index.name = "Date"
    df.to_csv(path, float_format="%.4f")
    name = None
    try:
        info = t.info
        name = info.get("longName") or info.get("shortName")
    except Exception:
        pass
    return path, name


# 相对百分位指标：唯一实现在 watch/signals.py，这里只做取整压缩
sys.path.insert(0, os.path.join(ROOT, "watch"))
import signals as _sg  # noqa: E402
PCT_NAMES = _sg.PCT_NAMES


def pct_metrics(rows):
    """{指标名: [百分位×10 的整数或 None]}，×10 保留一位小数又省体积。"""
    s = {"d": [r[0] for r in rows], "o": [r[1] for r in rows], "h": [r[2] for r in rows],
         "l": [r[3] for r in rows], "c": [r[4] for r in rows], "n": len(rows)}
    m = _sg.pct_metrics(s)
    return {k: [None if x is None else int(round(x * 10)) for x in v] for k, v in m.items()}


def pack(rows):
    """列式压缩：日期存成相对首日的序号增量不划算（交易日不连续），
    直接存 YYYY-MM-DD 字符串数组；价格保留 4 位有效小数后去掉尾零。"""
    def num(x):
        v = round(x, 4)
        return int(v) if v == int(v) else v
    return {
        "d": [r[0] for r in rows],
        "o": [num(r[1]) for r in rows],
        "h": [num(r[2]) for r in rows],
        "l": [num(r[3]) for r in rows],
        "c": [num(r[4]) for r in rows],
    }


def main():
    extra = [a.upper() for a in sys.argv[1:]]
    out = {}
    meta = {}

    for tk, (rel, zh, en) in BUILTIN.items():
        rows = read_csv(os.path.join(DATA, rel))
        out[tk] = pack(rows)
        meta[tk] = {"zh": zh, "en": en, "n": len(rows),
                    "from": rows[0][0], "to": rows[-1][0]}
        print("%-8s %5d 行  %s .. %s" % (tk, len(rows), rows[0][0], rows[-1][0]))

    for tk in extra:
        if tk in out:
            continue
        path, name = fetch(tk)
        rows = read_csv(path)
        out[tk] = pack(rows)
        meta[tk] = {"zh": name or tk, "en": name or tk, "n": len(rows),
                    "from": rows[0][0], "to": rows[-1][0]}
        print("%-8s %5d 行  %s .. %s  (yfinance)" % (tk, len(rows), rows[0][0], rows[-1][0]))

    print("\n计算相对百分位指标（三年滚动，point-in-time）…")
    pcts = {}
    for tk in out:
        rowsx = list(zip(out[tk]["d"], out[tk]["o"], out[tk]["h"], out[tk]["l"], out[tk]["c"]))
        pcts[tk] = pct_metrics(rowsx)
        print("  %-8s 完成" % tk)

    lows_path = os.path.join(DATA, "marked_lows.json")
    lows = json.load(open(lows_path, encoding="utf-8")) if os.path.exists(lows_path) else []
    env_path = os.path.join(SITE, "envelope.json")
    env = json.load(open(env_path, encoding="utf-8")) if os.path.exists(env_path) else None

    payload = {"built": date.today().isoformat(), "gen": datetime.utcnow().isoformat(timespec="seconds"),   # 见 build_valuation.py 的 gen
               "meta": meta, "series": out,
               "pct": pcts, "pctNames": PCT_NAMES,
               "markedLows": {"^GSPC": lows},
               "envelope": {"^GSPC": env} if env else {}}
    dst = os.path.join(SITE, "viewer_data.js")
    with open(dst, "w", encoding="utf-8") as f:
        f.write("window.STOCK_DATA=")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print("\n写入 %s  (%.2f MB)" % (dst, os.path.getsize(dst) / 1e6))


if __name__ == "__main__":
    main()
