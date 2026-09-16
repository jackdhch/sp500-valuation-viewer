# -*- coding: utf-8 -*-
"""抓美联储的政策利率，反推出每一次调息，写 data/fed_rate_changes.csv。

为什么不手抄 FOMC 日历
----------------------
手抄三十次会议的日期和幅度，抄错一个就是错的，而且以后每次开会都要补。
这里改成：抓 FRED 的 DFEDTARU（联邦基金目标利率区间上限，日频），
**相邻两天的值一变，就是一次调息，差值就是幅度**。日期和幅度都不用自己记，
以后开会也会自动跟上。

2026-09-16 实测反推结果，与公开资料完全对得上：
  2016 年以来加息 19 次、降息 11 次
  2022-2023 加息 11 次，累计 +525bp

一个口径差异要写清楚
--------------------
DFEDTARU 是**生效日**序列，而新闻和图表通常标 FOMC 的**公布日**，两者差一个工作日
（会议当天下午宣布，次日生效）。例如 2017 年 3 月那次，公布是 03-15，本表记 03-16。
页面上标的是生效日，并注明这一点——不去猜公布日，猜了反而可能错。

    python3 scripts/fetch_fed.py
"""
import csv
import datetime
import io
import os
import subprocess
import time
import urllib.request

ROOT = os.environ.get("SP500_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("SP500_DATA") or f"{ROOT}/data"
OUT = f"{DATA}/fed_rate_changes.csv"

SERIES = "DFEDTARU"      # 联邦基金目标利率区间上限，2008-12 起（此前是单一目标值）
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"


def fetch_series(sid, tries=4):
    """抓一条 FRED 序列。

    优先用 curl：这台机器上 Python 的 urllib 走 https 代理时会稳定超时，
    而同一个地址 curl 直接就能拿到（代理在 https_proxy 里配着）。
    没有 curl 的环境（比如 CI 的精简镜像）再退回 urllib。
    """
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"
    last = None
    for k in range(tries):
        try:
            r = subprocess.run(["curl", "-sL", "--max-time", "60", "-A", UA, url],
                               capture_output=True, text=True, timeout=90)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout
            last = RuntimeError(f"curl 退出码 {r.returncode}")
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            last = e
            if isinstance(e, FileNotFoundError):
                break               # 没装 curl，直接走下面的 urllib
        time.sleep(3 * (k + 1))

    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            return urllib.request.urlopen(req, timeout=90).read().decode()
        except Exception as e:
            last = e
            time.sleep(3 * (k + 1))
    raise RuntimeError(f"{sid} 抓取失败：{last!r}")


RAW_CACHE = f"{DATA}/fred_{SERIES}.csv"


def main():
    """抓不到就用上次的原始文件——政策利率一年动不了几次，
    隔几天的缓存完全够用，总比整条管线因为 FRED 一时连不上就断掉强。"""
    try:
        raw = fetch_series(SERIES)
        os.makedirs(DATA, exist_ok=True)
        with open(RAW_CACHE, "w") as f:
            f.write(raw)
    except RuntimeError as e:
        if not os.path.exists(RAW_CACHE):
            raise
        print(f"抓取失败（{e}），改用本地缓存 {RAW_CACHE}")
        raw = open(RAW_CACHE).read()
    rows = list(csv.DictReader(io.StringIO(raw)))
    if not rows:
        raise SystemExit("FRED 返回空数据")
    cols = list(rows[0].keys())
    dk, vk = cols[0], cols[1]

    pts = []
    for r in rows:
        v = r.get(vk, "")
        if v in (".", "", None):
            continue
        pts.append((datetime.date.fromisoformat(r[dk]), float(v)))
    pts.sort()

    events = []
    for i in range(1, len(pts)):
        delta = pts[i][1] - pts[i - 1][1]
        if abs(delta) < 1e-9:
            continue
        events.append({
            "effective_date": pts[i][0].isoformat(),
            "bp": round(delta * 100),
            "direction": "hike" if delta > 0 else "cut",
            "target_upper": round(pts[i][1], 2),
        })

    os.makedirs(DATA, exist_ok=True)
    with open(OUT, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["effective_date", "bp", "direction", "target_upper"])
        w.writeheader()
        w.writerows(events)

    since = datetime.date(2016, 1, 1)
    rec = [e for e in events if datetime.date.fromisoformat(e["effective_date"]) >= since]
    hikes = [e for e in rec if e["bp"] > 0]
    cuts = [e for e in rec if e["bp"] < 0]
    w2223 = [e for e in hikes
             if "2022" <= e["effective_date"][:4] <= "2023"]
    print(f"{SERIES} {pts[0][0]} ~ {pts[-1][0]}，当前目标上限 {pts[-1][1]}%")
    print(f"共 {len(events)} 次调息；2016 年以来 加息 {len(hikes)} 次、降息 {len(cuts)} 次")
    print(f"2022-2023 加息 {len(w2223)} 次，累计 {sum(e['bp'] for e in w2223):+d}bp")
    print(f"写出 {OUT}")


if __name__ == "__main__":
    main()
