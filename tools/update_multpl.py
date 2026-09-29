"""每天更新标普500 滚动市盈率（multpl.com 按月的表），2026-09-28 加，给公开仓库的每日任务用。

multpl 那张表（https://www.multpl.com/s-p-500-pe-ratio/table/by-month）不是一个月才变一次：
  - 最上面一行是「当天」的估算值，随股价每天变；
  - 最近两三个月标着「† Estimate」，公司陆续公布财报后还会被改；multpl 按季度成批定稿，去掉估算标记那次数值也会跟着改；
  - 再往前的月份定下来就不变（2026-09-28 核对：本机 data/sp500_pe_ttm_monthly.csv 和网站 1869 个共同日子一个数都没差）。
所以每天把整张表重抓一遍：定下来的月份必须和已有的一样；估算月份和当天那一行用网站最新值；当天那行只留最新一行
（本机原来的文件就是这样：月初各一行 + 抓取当天一行）。

检查（有一条不过就整张不更新、沿用已有数据，并推送告诉操作者，记在 data/multpl_alert.json）：
  - 表格读得出来、至少 1800 行、最早是 1871 年；
  - 两年以前的月份在网站上都还在，而且数值一样（差 0.01 以内）——这些早就定稿了，变了说明网站改了历史或改了版式；
  - 最近两年的月份（估算、刚定稿的都在里面）和当天那行在 5~100 倍之间，和已有的同一个月比变动不超过 25%；
    当月 1 号那一行 multpl 要到月中才补上，网页上暂时没有不算错（我们存的那行其实是上次抓的当天行）。
  同一个原因第一次推一次，拖到第 7 天还没好再推一次；网站打不开连续 3 天以上才推（偶尔打不开很正常）。
推送：环境变量 BARK_URL（公开仓库的加密机密，没配就只打印）。

    python3 scripts/update_multpl.py            # 写 data/sp500_pe_ttm_monthly.csv
    python3 scripts/update_multpl.py --selftest # 不联网的自检
"""
import csv, datetime, json, os, re, sys, urllib.parse, urllib.request

ROOT = os.environ.get("SP500_ROOT") or "/home/d/260909_SP500"
CSV = os.environ.get("MULTPL_CSV") or f"{ROOT}/data/sp500_pe_ttm_monthly.csv"
ALERT = os.environ.get("MULTPL_ALERT") or f"{ROOT}/data/multpl_alert.json"
URL = "https://www.multpl.com/s-p-500-pe-ratio/table/by-month"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"


def parse(html):
    """返回 [(date, pe, 是否估算)]，从新到旧（网页上的顺序）。"""
    i = html.find('<table id="datatable">')
    if i < 0:
        return []
    tb = html[i:html.find("</table>", i)]
    out = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", tb, re.S):
        td = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
        if len(td) != 2:
            continue
        try:
            d = datetime.datetime.strptime(td[0].strip(), "%b %d, %Y").date()
            v = float(re.findall(r"(\d+(?:\.\d+)?)", re.sub(r"<[^>]+>", "", td[1]).replace(",", ""))[-1])
        except (ValueError, IndexError):
            continue
        out.append((d, v, "Estimate" in td[1]))
    return out


def merge(old, web):
    """old：{日期字符串: 值}；web：parse() 的结果。返回 (新的 {日期: 值}, None) 或 (None, 不更新的原因)。"""
    if len(web) < 1800 or min(d for d, _, _ in web).year != 1871:
        return None, f"表格只读出 {len(web)} 行（网站可能改了版式）"
    wmap = {d.isoformat(): (v, est) for d, v, est in web}
    today_row = max(d for d, _, _ in web)
    this_month = today_row.replace(day=1).isoformat()
    recent = today_row.replace(year=today_row.year - 2, day=1).isoformat()    # 最近两年：估算和刚定稿的都在里面
    for d, v in old.items():
        if datetime.date.fromisoformat(d).day != 1:
            continue                                   # 旧的「当天」那一行，换成新的
        if d not in wmap:
            if d >= this_month:
                continue                               # 上次恰好在 1 号抓的当天行；当月 1 号那行 multpl 月中才补
            return None, f"已有的 {d} 在网站上找不到了"
        wv, est = wmap[d]
        if est or d >= recent:
            if not 5 <= wv <= 100 or abs(wv / v - 1) > 0.25:
                return None, f"最近的月份 {d} 从 {v} 变成 {wv}，超出 5~100 倍或变动超过 25%"
        elif abs(wv - v) > 0.01:
            return None, f"两年前就定下来的月份 {d} 在网站上从 {v} 变成了 {wv}"
    for d, v, est in web:
        if (est or d == today_row) and not 5 <= v <= 100:
            return None, f"{d} 的值 {v} 不在 5~100 之间"
    new = {d.isoformat(): v for d, v, _ in web if d.day == 1}
    new[today_row.isoformat()] = dict((dd, vv) for dd, vv, _ in web)[today_row]
    return new, None


def push(title, body):
    url = os.environ.get("BARK_URL", "").rstrip("/")
    print(f"【提醒】{title}：{body}")
    if not url:
        print("（没配 BARK_URL，只打印）")
        return
    try:
        q = lambda s: urllib.parse.quote(s, safe="")
        urllib.request.urlopen(f"{url}/{q(title)}/{q(body)}?group={q('水位尺')}", timeout=15).read()
    except Exception as e:                             # 推不出去不影响别的；不打印地址
        print("推送失败：", type(e).__name__)


def main():
    old = {r["date"]: float(r["value"]) for r in csv.DictReader(open(CSV))}
    try:
        req = urllib.request.Request(URL, headers={"User-Agent": UA})
        html = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "ignore")
        new, why = merge(old, parse(html))
    except Exception as e:
        new, why = None, f"网站打不开（{type(e).__name__}）"
    st = json.load(open(ALERT)) if os.path.exists(ALERT) else {}
    if why:
        print("multpl 滚动市盈率：这次不更新，" + why)
        today = datetime.date.today()
        kind = "网站打不开" if why.startswith("网站打不开") else why
        if st.get("kind") != kind:
            st = {"kind": kind, "since": today.isoformat(), "pushed": ""}
        days = (today - datetime.date.fromisoformat(st["since"])).days
        last = datetime.date.fromisoformat(st["pushed"]) if st.get("pushed") else None
        # 打不开：连续 3 天以上才推；别的原因：第一次就推。之后每拖 7 天再推一次，免得推一次就被忽略、数据悄悄停着
        due = (days >= 3 if kind == "网站打不开" else True) and (last is None or (today - last).days >= 7)
        if due:
            push("水位尺：multpl 滚动市盈率没更新", f"{why}（从 {st['since']} 起）。滚动市盈率继续沿用已有数据，要人看一下。")
            st["pushed"] = today.isoformat()
        json.dump(st, open(ALERT, "w"), ensure_ascii=False)
        return
    last_alert = st
    if last_alert:
        os.remove(ALERT)                               # 恢复正常了，下次再出问题会重新推
    changed = [d for d in new if old.get(d) != new[d]]
    with open(CSV, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["date", "value"])
        for d in sorted(new):
            w.writerow([d, new[d]])
    print(f"multpl 滚动市盈率：{len(new)} 行，最新 {max(new)} = {new[max(new)]}；有变化的 {len(changed)} 行 {changed[-5:]}")


def selftest():
    D = datetime.date
    web = [(D(2026, 9, 28), 26.2, True), (D(2026, 9, 1), 26.04, True), (D(2026, 8, 1), 26.11, True)] + \
          [(D(1871 + k // 12, k % 12 + 1, 1), 15.0, False) for k in range(1860)]
    old = {"1871-01-01": 15.0, "2026-08-01": 26.0, "2026-09-01": 26.04, "2026-09-08": 26.22}
    new, why = merge(old, web)
    assert why is None and new["2026-08-01"] == 26.11 and new["2026-09-28"] == 26.2 and "2026-09-08" not in new, why
    assert "两年前就定下来" in merge(dict(old, **{"1871-01-01": 16.0}), web)[1]
    assert "25%" in merge(dict(old, **{"2026-08-01": 10.0}), web)[1]
    # 估算月份定稿、数值同时改了（没有估算标记了，变动 5%）：放行
    web2 = [(D(2026, 9, 28), 26.2, True), (D(2026, 9, 1), 26.04, True), (D(2026, 8, 1), 27.3, False)] + web[3:]
    n2, w2 = merge(old, web2)
    assert w2 is None and n2["2026-08-01"] == 27.3, w2
    # 上次正好 1 号抓（当天行存成了 2026-10-01），今天 10-02 网页上还没有 10-01 那行：放行
    web3 = [(D(2026, 10, 2), 26.5, True)] + web
    old3 = dict(old, **{"2026-10-01": 26.3}); del old3["2026-09-08"]
    n3, w3 = merge(old3, web3)
    assert w3 is None and "2026-10-01" not in n3 and n3["2026-10-02"] == 26.5, w3
    assert "只读出" in merge(old, web[:100])[1]
    assert "找不到" in merge(dict(old, **{"1870-06-01": 1.0}), web)[1]
    html = '<table id="datatable"><tr><th>Date</th></tr><tr class="odd"><td>Sep 28, 2026</td><td>\n<abbr title="Estimate">†</abbr>\n26.20\n</td></tr>' \
           '<tr><td>Jun 1, 2026</td><td>\n&#x2002;\n25.22\n</td></tr></table>'
    assert parse(html) == [(D(2026, 9, 28), 26.2, True), (D(2026, 6, 1), 25.22, False)]
    print("selftest ok")


if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else main()
