"""每周增量更新标普500 前瞻市盈率（FactSet Earnings Insight 周报），2026-09-28 加，给公开仓库的每日任务用。

只找 data/sp500_forward_pe_factset.csv 最后一期之后的周五（前后一天也试，节假日前后 FactSet 会挪到周四），
下载 PDF → 用 extract_factset.parse_pdf 读数（和本机全量重建同一套读法）→ 检查过了才追加一行。历史行一行都不动。

检查（有一条不过就不采用这一期，并推送告诉操作者）：
  - 前瞻 PE 在 8~40 之间，且和上一期比变动不超过 20%（2020 年 3 月两周里最大也就掉了两成出头）；
  - 5 年、10 年均值都读得出，且和上一期比变动不超过 1（这两个数一年才动零点几）；
  - PDF 下载下来了却读不出前瞻 PE，也推送（多半是 FactSet 改了版式，要来改读法）。
推送：环境变量 BARK_URL（公开仓库的加密机密，没配就只打印）。
没采用的那一期记进 data/factset_skip.json，以后不再抓、不再推（不然每天都推一遍）；人看过、改好读法后从里面删掉就会重试。
最新一期超过 17 天（连着错过两期：FactSet 改了地址、网站挡了服务器……）也推一次，之后每 7 天最多再推一次（记在同一个文件的 _stale_pushed）。

    python3 scripts/update_factset.py            # 本机：写 data/sp500_forward_pe_factset.csv
    python3 scripts/update_factset.py --selftest # 不联网的自检
"""
import csv, datetime, os, sys, tempfile, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ROOT = os.environ.get("SP500_ROOT") or "/home/d/260909_SP500"
CSV = os.environ.get("FACTSET_CSV") or f"{ROOT}/data/sp500_forward_pe_factset.csv"
SKIP = os.environ.get("FACTSET_SKIP") or f"{ROOT}/data/factset_skip.json"
BASE = "https://advantage.factset.com/hubfs/Website/Resources%20Section/Research%20Desk/Earnings%20Insight/EarningsInsight_"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"


def check(new, last):
    """new/last：(date, pe, a5, a10)。返回 None 表示可以采用，否则是不采用的原因。"""
    d, pe, a5, a10 = new
    if pe is None:
        return "读不出前瞻 PE（FactSet 可能改了版式）"
    if not 8 <= pe <= 40:
        return f"前瞻 PE {pe} 不在 8~40 之间"
    if last:
        if abs(pe / last[1] - 1) > 0.20:
            return f"前瞻 PE {pe} 比上一期（{last[0]} 的 {last[1]}）变了 {abs(pe / last[1] - 1) * 100:.0f}%，超过 20%"
        for name, v, v0 in (("5 年均值", a5, last[2]), ("10 年均值", a10, last[3])):
            if v is None:
                return f"读不出{name}"
            if v0 is not None and abs(v - v0) > 1.0:
                return f"{name} {v} 比上一期的 {v0} 变了 {abs(v - v0):.1f}，超过 1"
    return None


def candidates(last_date, today):
    """最后一期之后到今天为止的周五，外加前后一天（按时间排）。"""
    out, d = [], last_date + datetime.timedelta(days=1)
    while d <= today:
        if d.weekday() == 4:
            for k in (-1, 0, 1):
                x = d + datetime.timedelta(days=k)
                if last_date < x <= today:
                    out.append(x)
        d += datetime.timedelta(days=1)
    return sorted(set(out))


def push(title, body):
    url = os.environ.get("BARK_URL", "").rstrip("/")
    print(f"【提醒】{title}：{body}")
    if not url:
        print("（没配 BARK_URL，只打印）")
        return
    try:
        q = lambda s: urllib.parse.quote(s, safe="")
        urllib.request.urlopen(f"{url}/{q(title)}/{q(body)}?group={q('水位尺')}", timeout=15).read()
    except Exception as e:                     # 推不出去不影响数据更新；不打印地址
        print("推送失败：", type(e).__name__)


def download(d, folder):
    tag = d.strftime("%m%d%y")
    f = os.path.join(folder, f"EarningsInsight_{tag}.pdf")
    req = urllib.request.Request(f"{BASE}{tag}.pdf", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
    except Exception:
        return None                            # 404：这天没有周报，正常
    if len(data) < 50000:
        return None
    open(f, "wb").write(data)
    return f


def main():
    import json
    from extract_factset import parse_pdf
    skip = json.load(open(SKIP)) if os.path.exists(SKIP) else {}
    rows = list(csv.reader(open(CSV)))
    head, body = rows[0], [r for r in rows[1:] if r]
    last = body[-1]
    lt = (datetime.date.fromisoformat(last[0]), float(last[1]),
          float(last[2]) if last[2] else None, float(last[3]) if last[3] else None)
    today = datetime.date.today()
    got, bad = [], []
    with tempfile.TemporaryDirectory() as tmp:
        for d in candidates(lt[0], today):
            if d.isoformat() in skip:
                continue
            f = download(d, tmp)
            if not f:
                continue
            pe, a5, a10 = parse_pdf(f)
            new = (d, pe, a5, a10)
            why = check(new, lt)
            if why:
                bad.append(f"{d}：{why}")
                skip[d.isoformat()] = why
                continue
            got.append(new)
            lt = new                           # 下一期和这一期比
    if got:
        with open(CSV, "a", newline="") as fh:
            w = csv.writer(fh)
            for r in got:
                w.writerow(r)
    newest = got[-1][0] if got else datetime.date.fromisoformat(last[0])
    age = (today - newest).days
    if age > 17:
        lastp = skip.get("_stale_pushed")
        if not lastp or (today - datetime.date.fromisoformat(lastp)).days >= 7:
            push("水位尺：FactSet 周报很久没更新", f"最新一期还是 {newest}（{age} 天前），前瞻市盈率一直按这一期外推。可能是 FactSet 改了下载地址或挡了服务器，要人看一下。")
            skip["_stale_pushed"] = today.isoformat()
            json.dump(skip, open(SKIP, "w"), ensure_ascii=False, indent=1)
    elif skip.pop("_stale_pushed", None):
        json.dump(skip, open(SKIP, "w"), ensure_ascii=False, indent=1)
    print(f"FactSet 周报：原来到 {last[0]}，新增 {len(got)} 期"
          + (f"（{', '.join(f'{r[0]} {r[1]}' for r in got)}）" if got else "") + (f"；不采用 {len(bad)} 期" if bad else ""))
    if bad:
        json.dump(skip, open(SKIP, "w"), ensure_ascii=False, indent=1)
        push("水位尺：FactSet 周报没采用", "；".join(bad) + "。前瞻市盈率继续沿用上一期，要人看一下（这几期记在 data/factset_skip.json，不会再推）。")


def selftest():
    D = datetime.date
    last = (D(2026, 9, 4), 19.5, 19.8, 19.0)
    assert check((D(2026, 9, 11), 19.1, 19.8, 19.0), last) is None
    assert "读不出前瞻" in check((D(2026, 9, 11), None, 19.8, 19.0), last)
    assert "8~40" in check((D(2026, 9, 11), 191.0, 19.8, 19.0), last)
    assert "20%" in check((D(2026, 9, 11), 14.0, 19.8, 19.0), last)
    assert "5 年均值" in check((D(2026, 9, 11), 19.1, 29.8, 19.0), last)
    assert "读不出10 年均值" in check((D(2026, 9, 11), 19.1, 19.8, None), last)
    c = candidates(D(2026, 9, 4), D(2026, 9, 28))
    assert c[0] == D(2026, 9, 10) and D(2026, 9, 25) in c and D(2026, 9, 26) in c and all(x > D(2026, 9, 4) for x in c)
    assert candidates(D(2026, 9, 25), D(2026, 9, 25)) == []
    print("selftest ok")


if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else main()
