# -*- coding: utf-8 -*-
"""抓历史估值比率，落盘成 data/valuation/<TICKER>.csv。

两个数据源，各补各的短板（2026-09-15 实测）
------------------------------------------
1. macrotrends.net —— 长历史，但没有前瞻市盈率
   /stocks/charts/<T>/<slug>/pe-ratio     81 个季度行，最早回到 2006-10-31（约 20 年）
   /stocks/charts/<T>/<slug>/price-book   同结构
   /stocks/charts/<T>/<slug>/price-sales  同结构
   表格四列分别是「期末日期 / 当期股价 / 每股指标 / 比率」，**每股收益是现成的**，
   不需要像 build_dataset.py 那样用价格反推。
   slug 写错会自动 302 到正确地址，所以统一填 "x"。
   限流较严，实测连续快抓会返回 429，因此本脚本默认间隔 2.5 秒并做指数退避，
   同时把原始 HTML 缓存到 data/valuation/_raw/，重跑时不再重复请求。

2. stockanalysis.com —— 只有约 5 年，但**有前瞻市盈率**
   /stocks/<t>/financials/ratios/?p=quarterly  21 个季度行（约 5 年），含 peForward
   页面是服务端渲染，带桌面 User-Agent 即可，无需 cookie。
   注意：必须按 <tr> 边界切行再取 <td>，否则会把下一行（peForward）的数值
   误当成 pe 行的延续，得到「33 期」这种假深度。

所以最终每只标的的锚点里：pe / eps / pb / ps 来自 macrotrends（约 20 年），
fwd_pe 来自 stockanalysis（约 5 年）。前瞻市盈率只能做到 5 年分位，做不了十年分位。

用法
----
    python3 scripts/fetch_valuation.py             # 抓全部
    python3 scripts/fetch_valuation.py NVDA AMZN   # 只抓这几个
    FORCE=1 python3 scripts/fetch_valuation.py     # 忽略缓存重抓
"""
import csv
import datetime
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = os.environ.get("SP500_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("SP500_VAL_DIR") or f"{ROOT}/data/valuation"
RAW = f"{OUT}/_raw"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")

# 自选清单，与 analysis/etf_cover/data.py 的 WISHLIST 一致（TradingView "Red list"）
WISHLIST = ["NVDA", "AAPL", "GOOG", "AMZN", "TSM", "MU", "AMD", "ASML", "SNDK", "ANET",
            "GEV", "ARM", "STX", "WDC", "GLW", "NOW", "BE", "LITE", "SKHY", "KXIAY"]

# 自选清单之外另加的：
#   MSFT  截图对比表给了它的实测值（PE 28.17 / 分位 28.7%），留作验证锚点，本身也是七巨头之一
#   META / TSLA  补全「七巨头」——其余五只（AAPL MSFT GOOG AMZN NVDA）自选清单里已有
#   SPCX  SpaceX，2026-06-12 在纳斯达克 IPO（2026-09-14 报 151.21 美元、市值约 2.05 万亿）。
#         上市才三个月，历史序列极短、市盈率还是 n/a，页面上会落到「仅当前值」那类卡片
EXTRA_STOCKS = ["MSFT", "META", "TSLA", "SPCX"]

MT_PAGES = {"pe-ratio": ("eps", "pe"),
            "price-book": ("bvps", "pb"),
            "price-sales": ("sps", "ps")}

# macrotrends 的表格行：日期 / 股价 / 每股指标（可能带 $、可能为空）/ 比率（可能为负）
MT_ROW = re.compile(
    r'<td[^>]*>(\d{4}-\d{2}-\d{2})</td>\s*'
    r'<td[^>]*>\$?\s*([\d.,-]*)\s*</td>\s*'
    r'<td[^>]*>\$?\s*([\d.,-]*)\s*</td>\s*'
    r'<td[^>]*>\s*([\d.,-]*)\s*</td>')

SLEEP = 2.5


def _cache_path(url):
    return f"{RAW}/{hashlib.md5(url.encode()).hexdigest()}.html"


def fetch(url, tries=4, use_cache=True):
    """抓页面，带本地缓存与指数退避。404 返回 None（不重试），彻底失败抛异常。"""
    cp = _cache_path(url)
    if use_cache and not os.environ.get("FORCE") and os.path.exists(cp):
        with open(cp, encoding="utf-8") as f:
            return f.read()
    last = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            html = urllib.request.urlopen(req, timeout=40).read().decode("utf-8", "ignore")
            os.makedirs(RAW, exist_ok=True)
            with open(cp, "w", encoding="utf-8") as f:
                f.write(html)
            time.sleep(SLEEP)
            return html
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last = e
            time.sleep(SLEEP * (2 ** k))      # 429 要退得狠一点
        except Exception as e:
            last = e
            time.sleep(SLEEP * (k + 1))
    raise RuntimeError(f"{url} 抓取失败: {last!r}")


def num(s):
    s = (s or "").strip().replace(",", "").replace("$", "")
    if s in ("", "-", "--", "n/a", "N/A"):
        return None
    neg = s.startswith("(") and s.endswith(")")
    if neg:
        s = s[1:-1]
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


# ---------------------------------------------------------------- macrotrends

def mt_scrape(ticker):
    """返回 {date: {eps,pe,bvps,pb,sps,ps,price}}，约 20 年季度锚点。"""
    rec = {}
    for page, (per_share, ratio) in MT_PAGES.items():
        url = f"https://www.macrotrends.net/stocks/charts/{ticker}/x/{page}"
        try:
            html = fetch(url)
        except RuntimeError as e:
            print(f"    {page} 抓取失败：{e}")
            continue
        if html is None:
            continue
        rows = MT_ROW.findall(html)
        for d, price, ps_val, ratio_val in rows:
            day = datetime.date.fromisoformat(d)
            e = rec.setdefault(day, {})
            e[per_share] = num(ps_val)
            e[ratio] = num(ratio_val)
            if num(price) is not None:
                e["price"] = num(price)
    return rec


# ------------------------------------------------------------- stockanalysis

def _tr_of(html, needle):
    """取包含 needle 的那一整个 <tr>。必须按行切，否则会串到下一行的数据。"""
    i = html.find(needle)
    if i < 0:
        return ""
    s = html.rfind("<tr", 0, i)
    e = html.find("</tr>", i)
    return html[s:e] if s >= 0 and e > 0 else ""


def sa_forward_pe(ticker):
    """返回 {date: fwd_pe}，约 5 年季度锚点。拿不到就返回空 dict。"""
    url = f"https://stockanalysis.com/stocks/{ticker.lower()}/financials/ratios/?p=quarterly"
    try:
        html = fetch(url)
    except RuntimeError:
        return {}
    if html is None:
        return {}
    head = _tr_of(html, "Period Ending")
    keys = re.findall(r'<th id="(TTM|\d{4}-\d{2}-\d{2})"', head)
    # TTM 列的实际日期写在同一个 th 里，例如 "Sep 14, 2026"
    ttm_date = None
    m = re.search(r'<th id="TTM"[^>]*>.*?([A-Z][a-z]{2}) (\d{1,2}), (\d{4})', head, re.S)
    if m:
        mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].index(m.group(1)) + 1
        ttm_date = datetime.date(int(m.group(3)), mon, int(m.group(2)))
    vals = re.findall(r'<td class="svelte-\w+">([^<]*)</td>', _tr_of(html, 'id="peForward"'))
    out = {}
    for key, raw in zip(keys, vals):
        d = ttm_date if key == "TTM" else datetime.date.fromisoformat(key)
        if d is None:
            continue
        v = num(raw)
        if v is not None:
            out[d] = v
    return out


def _pick(html, label):
    """从 stockanalysis 的两列指标表里取一个值。

    标签的包法有好几种（裸 <td>、包 <a>、包 <span>），而且 Svelte 会在中间插一堆
    <!--[0--> 这样的水合注释，所以不去死磕标签结构，只做一件事：
    从标签出现的位置往后找最近的一个 <td>，取它里面第一段非标签文本。
    """
    if not html:
        return ""
    i = html.find(">" + label + "<")
    if i < 0:
        return ""
    m = re.search(r'<td[^>]*>\s*(?:<[^>]+>\s*)*([^<\s][^<]*?)\s*<', html[i:i + 400], re.S)
    return m.group(1).strip() if m else ""


def sa_snapshot(ticker):
    """个股卡要的 PEG / 市值 / 公司名。市值在概览页，PEG 只在 statistics 页。"""
    try:
        home = fetch(f"https://stockanalysis.com/stocks/{ticker.lower()}/")
        stats = fetch(f"https://stockanalysis.com/stocks/{ticker.lower()}/statistics/")
    except RuntimeError:
        return None
    if home is None and stats is None:
        return None
    name = ""
    m = re.search(r'<title>([^(<]*)', home or "")
    if m:
        name = m.group(1).strip()
    return {"ticker": ticker, "name": name,
            "peg": _pick(stats, "PEG Ratio") or _pick(home, "PEG Ratio"),
            "mcap": _pick(home, "Market Cap") or _pick(stats, "Market Cap")}


# --------------------------------------------------------------------- 落盘

FIELDS = ["period_end", "price", "eps", "pe", "bvps", "pb", "sps", "ps", "fwd_pe"]


def write_csv(ticker, mt, fwd):
    merged = {d: dict(v) for d, v in mt.items()}
    for d, v in fwd.items():
        merged.setdefault(d, {})["fwd_pe"] = v
    path = f"{OUT}/{ticker}.csv"
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(FIELDS)
        for d in sorted(merged):
            r = merged[d]
            w.writerow([d.isoformat()] + [r.get(k) for k in FIELDS[1:]])
    return merged


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(RAW, exist_ok=True)
    targets = sys.argv[1:] or (WISHLIST + EXTRA_STOCKS)
    missing, snaps = {}, []

    for t in targets:
        print(f"{t} ...", flush=True)
        mt = mt_scrape(t)
        fwd = sa_forward_pe(t)
        if not mt and not fwd:
            missing[t] = "macrotrends 与 stockanalysis 均无该标的数据（OTC 粉单/未收录）"
            write_csv(t, {}, {})
            print(f"  {t} 无数据，已写空文件")
            continue
        merged = write_csv(t, mt, fwd)
        s = sa_snapshot(t)
        if s:
            latest = max(merged)
            s.update(as_of=latest.isoformat(),
                     pe=merged[latest].get("pe"), pb=merged[latest].get("pb"),
                     fwd_pe=merged[latest].get("fwd_pe"))
            snaps.append(s)
        span = f"{min(merged)} ~ {max(merged)}" if merged else "-"
        n_pe = sum(1 for v in merged.values() if v.get("pe") is not None)
        n_fwd = sum(1 for v in merged.values() if v.get("fwd_pe") is not None)
        print(f"  {t} 锚点 {len(merged)}（PE {n_pe}，前瞻PE {n_fwd}） 跨度 {span}")

    if snaps:
        # 合并而不是覆盖：只抓几个标的时（比如补 SMH 的成分股），不能把之前
        # 自选清单那批的快照冲掉——否则页面上的市值和 PEG 会整列变成「—」。
        keys = ["ticker", "name", "as_of", "pe", "fwd_pe", "pb", "peg", "mcap"]
        path = f"{OUT}/_snapshot.csv"
        merged = {}
        if os.path.exists(path):
            with open(path) as f:
                for r in csv.DictReader(f):
                    merged[r["ticker"]] = r
        for r in snaps:
            merged[r["ticker"]] = r
        with open(path, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
            w.writeheader()
            w.writerows([merged[k] for k in sorted(merged)])
    with open(f"{OUT}/_missing.json", "w") as f:
        json.dump({"built": datetime.date.today().isoformat(), "missing": missing},
                  f, ensure_ascii=False, indent=1)
    print(f"\n完成：{len(targets) - len(missing)}/{len(targets)} 个标的有数据，"
          f"缺失 {list(missing) or '无'}")





# ------------------------------------------------------------------ ETF 持仓
#
# 持仓表在 stockanalysis 的 /etf/<t>/holdings/ 页，行结构长这样（Svelte 水合注释很多，
# 所以先按 <tr> 切行，再在行内找代码和百分比）：
#   <tr ...> ... <a href="/stocks/nvda/" >NVDA</a> ... <td ...>22.10%</td> ... </tr>
# 免费版只给前 25 行，成分多的 ETF 拿到的是**权重前 25 名**，不是全表——
# 合成出来的市盈率因此是「已覆盖部分」的结果，必须在页面上标成下界，不能当完整值。

HOLD_ROW = re.compile(r'<a href="/stocks/([^/"]+)/"[^>]*>([A-Z.\-]+)</a>.*?<td[^>]*>\s*([\d.]+)%',
                      re.S)


def fetch_holdings(etf):
    """返回 [(ticker, weight%)]，按权重降序。"""
    try:
        html = fetch(f"https://stockanalysis.com/etf/{etf.lower()}/holdings/")
    except RuntimeError as e:
        print(f"  {etf} 持仓抓取失败：{e}")
        return []
    if html is None:
        return []
    out = []
    for tr in re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.S):
        m = HOLD_ROW.search(tr)
        if m:
            out.append((m.group(2), float(m.group(3))))
    return out


def etf_snapshot(etf):
    """ETF 概览页上的当前市盈率、市净率、规模。ETF 没有历史比率表，只有这一个当前值。"""
    try:
        html = fetch(f"https://stockanalysis.com/etf/{etf.lower()}/")
    except RuntimeError:
        return None
    if html is None:
        return None
    name = ""
    m = re.search(r'<title>([^(<]*)', html)
    if m:
        name = m.group(1).strip()
    return {"ticker": etf, "name": name,
            "pe": _pick(html, "PE Ratio"), "pb": _pick(html, "PB Ratio"),
            "aum": _pick(html, "Assets"), "expense": _pick(html, "Expense Ratio"),
            "inception": _pick(html, "Inception Date"), "holdings": _pick(html, "Holdings")}


def main_etf():
    """抓 ETF 持仓清单与当前快照。"""
    os.makedirs(OUT, exist_ok=True)
    snaps = []
    for etf in (sys.argv[2:] or ["SMH", "AIS", "DRAM", "QQQ", "VOO"]):
        s = etf_snapshot(etf)
        if s:
            snaps.append(s)
        rows = fetch_holdings(etf)
        path = f"{OUT}/_holdings_{etf.upper()}.csv"
        with open(path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["ticker", "weight_pct"])
            w.writerows(rows)
        tot = sum(r[1] for r in rows)
        print(f"{etf:6} {len(rows):3d} 只，权重合计 {tot:.1f}%  → {os.path.basename(path)}"
              + (f"  当前PE={s.get('pe')} 规模={s.get('aum')} 成立={s.get('inception')}" if s else ""))
    if snaps:
        keys = ["ticker", "name", "pe", "pb", "aum", "expense", "inception", "holdings"]
        with open(f"{OUT}/_etf_snapshot.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
            w.writeheader()
            w.writerows(snaps)
        print(f"\n写出 {OUT}/_etf_snapshot.csv")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--etf":
        main_etf()
    else:
        main()
