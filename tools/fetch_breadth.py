# -*- coding: utf-8 -*-
"""市场广度：下载指数成分股日线收盘价，算各口径的「市场宽度」。

口径（TheMarketMemo 的市场宽度指标，YouTube 9_0RKCJjDSo 里讲的那套）：
  b20   —— 收盘价 > 20日均线 的成分股占比（20日市场宽度）
  b50   —— 收盘价 > 50日均线 的占比（50日市场宽度）
  b200  —— 收盘价 > 200日均线 的占比（200日市场宽度）
另存一条 ZP-Macro 口径备查，页面上不画：
  b1020 —— 10日均线 > 20日均线 的占比（短期趋势广度）

等权：每只可算的股票一票。分母是当日「数据足够算出该均线」的股票数。

已知限制：用的是**当前**成分股名单，被剔除出指数的公司不在内（幸存者偏差）。
两个指数的名单来源不同，见 members_*()。

用法：
  python3 scripts/fetch_breadth.py            # 重新下载并重算
  python3 scripts/fetch_breadth.py --reuse    # 用已下载的价格矩阵只重算
"""
import os, io, sys, time, json, pandas as pd, yfinance as yf, requests

# 公开仓库的每日任务用环境变量指到自己的目录；本机不设，和原来一样
ROOT = os.environ.get("SP500_ROOT") or "/home/d/260909_SP500"; DATA = os.environ.get("SP500_DATA") or f"{ROOT}/data"
START = "2010-01-01"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
CLOSE = f"{DATA}/members_close.csv.gz"
LISTS = f"{DATA}/members_lists.json"

def members_spx():
    """datasets/s-and-p-500-companies —— 和 ZP-Macro 图注同一个源。"""
    r = requests.get("https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv", timeout=30)
    r.raise_for_status()
    return sorted(s.replace(".", "-") for s in pd.read_csv(io.StringIO(r.text))["Symbol"])

def members_ndx():
    """Nasdaq 官方 API。维基已删成分股表、Invesco 官方 CSV 返回 406、slickcharts 403，只剩这条路。"""
    r = requests.get("https://api.nasdaq.com/api/quote/list-type/nasdaq100",
                     headers={"User-Agent": UA, "Accept": "application/json"}, timeout=30)
    r.raise_for_status()
    rows = r.json()["data"]["data"]["rows"]
    return sorted(x["symbol"].strip().replace(".", "-") for x in rows)

def download(syms, batch=25, rounds=4):
    """分批下载。Yahoo 会零星超时，所以缺哪只补哪只，最多补 rounds 轮。"""
    got = {}
    todo = list(syms)
    for rd in range(rounds):
        if not todo: break
        print(f"第 {rd+1} 轮，待抓 {len(todo)} 只", flush=True)
        nxt = []
        for i in range(0, len(todo), batch):
            chunk = todo[i:i+batch]
            try:
                df = yf.download(chunk, start=START, auto_adjust=False, progress=False, threads=True)["Close"]
            except Exception as e:
                print("  批次失败", chunk[0], e, flush=True); nxt += chunk; continue
            if len(chunk) == 1: df = df.to_frame(chunk[0])
            for c in chunk:
                if c in df.columns and df[c].notna().sum() > 200: got[c] = df[c]
                else: nxt.append(c)
            print(f"  {min(i+batch,len(todo))}/{len(todo)}  累计 {len(got)}", flush=True)
            time.sleep(2)
        todo = nxt
    if todo: print("最终仍缺：", " ".join(todo), flush=True)
    return pd.DataFrame(got).sort_index()

def breadth(px):
    px = px.dropna(axis=1, how="all")
    ma10, ma20 = px.rolling(10).mean(), px.rolling(20).mean()
    ma50, ma200 = px.rolling(50).mean(), px.rolling(200).mean()
    def pct(cond, valid):
        n = valid.sum(axis=1)
        # 分母太小时不出数：标普用 100，纳指100 只有 ~100 只，按其规模放宽到 60
        floor = 100 if px.shape[1] > 200 else 60
        return (cond.where(valid).sum(axis=1) / n.where(n > 0) * 100).where(n >= floor).round(2)
    out = pd.DataFrame({
        "b20":   pct(px > ma20,   ma20.notna()),
        "b50":   pct(px > ma50,   ma50.notna()),
        "b200":  pct(px > ma200,  ma200.notna()),
        "b1020": pct(ma10 > ma20, ma20.notna()),
    })
    return out.dropna(how="all")

if __name__ == "__main__":
    if "--reuse" in sys.argv:
        px = pd.read_csv(CLOSE, index_col=0, parse_dates=True)
        lists = json.load(open(LISTS))
    else:
        # 名单抓不到（Nasdaq 接口常挡云服务器，每日任务在 GitHub 上跑）就用上次存的那份；成分股一年才变几次
        try:
            lists = {"spx": members_spx(), "ndx": members_ndx()}
        except Exception as e:
            print("成分股名单抓取失败，改用上次的", LISTS, "：", str(e)[:80], flush=True)
            lists = json.load(open(LISTS))
        allsyms = sorted(set(lists["spx"]) | set(lists["ndx"]))
        print(f"标普500 {len(lists['spx'])} 只 + 纳指100 {len(lists['ndx'])} 只 = 去重后 {len(allsyms)} 只", flush=True)
        px = download(allsyms)
        # 覆盖率下限：Yahoo 限流时可能只抓到一部分成分股，用这部分重算整段历史会悄悄改掉过去的宽度。
        # 不足九成就不算，沿用 data/breadth*.csv 里上次的（每日任务里这一步失败不影响别的）
        cover = px.shape[1] / max(1, len(allsyms))
        if cover < 0.9:
            sys.exit(f"成分股只抓到 {px.shape[1]}/{len(allsyms)} 只（{cover:.0%}），不足九成，这次不重算市场宽度")
        px.to_csv(CLOSE)
        json.dump(lists, open(LISTS, "w"), indent=1)
    # 最后几天如果大多数成分股还没有收盘价（Yahoo 当天的 ETF/个股收盘价常晚到），先不算这几天，免得发布出空值
    while len(px) and px.iloc[-1].notna().mean() < 0.5:
        print("  最后一天", px.index[-1].date(), "只有", f"{px.iloc[-1].notna().mean():.0%}", "的成分股有价，先不算这一天", flush=True)
        px = px.iloc[:-1]

    for key, out in (("spx", f"{DATA}/breadth.csv"), ("ndx", f"{DATA}/breadth_ndx.csv")):
        cols = [c for c in lists[key] if c in px.columns]
        b = breadth(px[cols]); b.index.name = "date"
        b.to_csv(out, float_format="%.2f")
        print(f"{out}  成分 {len(cols)}/{len(lists[key])} 只  {len(b)} 行  {b.index[0].date()} → {b.index[-1].date()}")
        print(b.tail(2))
