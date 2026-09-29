# -*- coding: utf-8 -*-
"""估值面板的回归测试。

对照基准来自 data/source_docs/wechat_valuation/valuation_numbers.csv ——
那是 2026-09-14 从公众号「一座独立屋」的会员估值平台截图里读出来的同日实测值。
那个平台不公开，我们无法逐日比对，但这几组数字足以判断本页的算法有没有跑偏。

容差说明：市盈率本身给 ±2%（抓取时点差一天、季度锚点对齐方式不同都会有零点几的差），
分位给 ±6 个百分点（对方的窗口口径没有完全公开，只能对到同一量级和同一档位）。

    python3 tests/test_valuation.py            # 数据层断言
    python3 tests/test_valuation.py --browser  # 再加一轮真实浏览器渲染检查
"""
import datetime
import json
import os
import subprocess
import sys

ROOT = "/home/d/260909_SP500"
SITE = f"{ROOT}/site"

# ticker, 指标, 期望值, 容差(相对), 说明
VALUE_CASES = [
    ("NVDA", "pe", 26.70, 0.02, "个股卡 PE TTM"),
    ("AMZN", "pe", 20.40, 0.02, "个股卡 PE TTM"),
    ("MSFT", "pe", 28.17, 0.02, "对比表 PE TTM"),
    ("AMZN", "pb", 4.97, 0.03, "个股卡 PB"),
    # QQQ 走的是纳指100 指数口径（Siblis），本项目的序列最新到 2026-09-08，
    # 而截图是 2026-09-14 的，中间隔了 4 个交易日、纳指本身在动，所以容差放宽到 4%。
    ("QQQ", "pe", 33.62, 0.04, "指数估值详情页 PE TTM"),
    ("QQQ", "fwd_pe", 24.36, 0.04, "指数估值详情页 Forward PE"),
]

# ticker, 期望十年分位, 容差(百分点)
PCT_CASES = [
    ("NVDA", 3.7, 6.0),
    ("AMZN", 0.1, 6.0),
]

fails = []


def check(name, ok, detail):
    print(f"  [{'通过' if ok else '失败'}] {name}  {detail}")
    if not ok:
        fails.append(f"{name}: {detail}")


def load():
    """把「索引 + 分片」拼回原来的 {meta, data} 形状，后面的断言就不用改了。

    页面为了首屏速度拆成了 valuation_index.js（摘要）加 v/<T>.js（日频序列），
    测试这边直接读文件拼一份完整的即可。
    """
    ip = f"{SITE}/valuation_index.js"
    if not os.path.exists(ip):
        sys.exit("site/valuation_index.js 不存在，先跑 scripts/build_valuation.py")
    s = open(ip).read()
    idx = json.loads(s[s.index("=") + 1:].rstrip().rstrip(";"))

    out = {"built": idx["built"], "meta": idx["meta"], "data": {}}
    for t, m in idx["meta"].items():
        pp = f"{SITE}/v/{t}.js"
        if not m.get("has_series") or not os.path.exists(pp):
            continue
        raw = open(pp).read()
        part = json.loads(raw[raw.index(",") + 1:raw.rstrip().rstrip(";").rindex(")")])
        # 日期是「起始日 + 逐日增量」，还原成字符串数组
        d0 = datetime.date.fromisoformat(part["d0"])
        dates = [part["d0"]]
        cur = d0
        for step in part["dd"]:
            cur += datetime.timedelta(days=step)
            dates.append(cur.isoformat())
        series = {"d": dates}
        for k in ("pe", "fwd_pe", "pb"):
            series[k] = part.get(k) or [None] * len(dates)
        out["data"][t] = {"series": series, "pct10y": m.get("pct10y", {}),
                          "pe_chg_1y": m.get("pe_chg_1y")}
    return out


SNAPSHOT_DAY = "2026-09-14"   # 截图那天


def last_valid(a):
    for v in reversed(a):
        if v is not None:
            return v
    return None


def value_on(series, day=SNAPSHOT_DAY):
    """取截图那一天的值，取不到就退回最新值。

    对照基准是 2026-09-14 的截图，而页面数据每个交易日都在更新。
    拿最新值去比截图，过几天必然因为股价正常波动而"失败"——那检验的是
    "今天价格没变"，不是算法有没有跑偏。所以按日期对齐着比。
    """
    dates = series.get("d") or []
    vals = series.get("_cur_key_vals")
    if vals is None:
        return None
    idx = None
    for i in range(len(dates) - 1, -1, -1):
        if dates[i] <= day:
            idx = i
            break
    if idx is None:
        return last_valid(vals)
    for i in range(idx, -1, -1):
        if vals[i] is not None:
            return vals[i]
    return last_valid(vals)


def main():
    D = load()
    print(f"数据生成于 {D['built']}，{len(D['data'])} 个标的\n")

    print("一、当前值对照截图（2026-09-14）")
    for t, key, want, tol, note in VALUE_CASES:
        if t not in D["data"]:
            check(f"{t} {key}", False, f"{note}：数据里没有这个标的")
            continue
        ser = D["data"][t]["series"]
        ser["_cur_key_vals"] = ser[key]
        got = value_on(ser)
        ok = got is not None and abs(got - want) / want <= tol
        check(f"{t} {key}", ok,
              f"{note} 期望 {want} 实得 {got}（按 {SNAPSHOT_DAY} 对齐）")

    print("\n二、十年分位对照截图")
    for t, want, tol in PCT_CASES:
        if t not in D["data"]:
            check(f"{t} 十年分位", False, "数据里没有这个标的")
            continue
        p = D["data"][t]["pct10y"].get("pe", {})
        got = p.get("pct")
        ok = got is not None and abs(got - want) <= tol
        check(f"{t} 十年分位", ok,
              f"期望 {want}% 实得 {got}%（覆盖 {p.get('years')} 年，{p.get('n')} 个点）")

    print("\n三、数据结构自查")
    for t, d in D["data"].items():
        s = d["series"]
        dates = s["d"]
        check(f"{t} 日期轴单调", dates == sorted(dates) and len(set(dates)) == len(dates),
              f"{len(dates)} 个交易日 {dates[0]}~{dates[-1]}")
        for key in ("pe", "fwd_pe", "pb"):
            arr = s.get(key) or []
            if len(arr) not in (0, len(dates)):
                check(f"{t} {key} 长度", False, f"{len(arr)} != {len(dates)}")
        p = d["pct10y"].get("pe", {}).get("pct")
        if p is not None:
            check(f"{t} 分位落在 0-100", 0 <= p <= 100, f"{p}")

    print("\n四、样本不足的标的必须显式标注，不能给假数字")
    for t, d in D["data"].items():
        p = d["pct10y"].get("pe", {})
        if p.get("years") is not None and p["years"] < 9.5:
            check(f"{t} 年限标注", p.get("pct") is None or p.get("n", 0) >= 250,
                  f"只有 {p['years']} 年数据，分位 {p.get('pct')}（{p.get('n')} 点）")

    if "--browser" in sys.argv:
        browser_check()

    print()
    if fails:
        print(f"共 {len(fails)} 项未通过：")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("全部通过")


def browser_check():
    """用 playwright 真开一次页面，确认两个页签都能渲染、图有东西画出来。"""
    print("\n五、浏览器渲染检查")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        check("playwright", False, "未安装，跳过")
        return
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", SITE],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # 等服务真的起来再开浏览器，否则 goto 拿到的是连接失败页，后面每个 click 都会超时
    import socket
    import time as _t
    for _ in range(40):
        try:
            socket.create_connection(("127.0.0.1", 8765), 0.2).close()
            break
        except OSError:
            _t.sleep(0.15)
    else:
        check("本地静态服务", False, "8765 端口起不来")
        srv.terminate()
        return
    try:
        with sync_playwright() as pw:
            b = pw.chromium.launch(args=["--no-proxy-server"])
            pg = b.new_page(viewport={"width": 1400, "height": 950})
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
            pg.goto(f"file://{SITE}/viewer.html", wait_until="load")
            pg.wait_for_timeout(600)
            check("信号页无报错", not errs, str(errs[:2]))

            pg.click("#tabVal")
            pg.wait_for_timeout(400)
            n = pg.eval_on_selector_all("#valCards .vc", "els => els.length")
            check("估值卡渲染", n > 0, f"{n} 张卡")
            pg.screenshot(path=f"{ROOT}/tests/shot_grid.png", full_page=True)

            pg.click("#valCards .vc")
            pg.wait_for_timeout(500)
            painted = pg.evaluate("""() => {
              const c = document.querySelector('#p-val canvas');
              if (!c) return -1;
              const g = c.getContext('2d');
              const d = g.getImageData(0, 0, c.width, c.height).data;
              let n = 0;
              for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
              return n;
            }""")
            check("走势图有像素", painted > 500, f"{painted} 个非透明像素")
            pg.screenshot(path=f"{ROOT}/tests/shot_detail.png", full_page=True)

            # 切到 1Y 再切回来，确认区间切换不崩
            pg.click("#valRanges button:last-child")
            pg.wait_for_timeout(300)
            kpi = pg.text_content("#kpi2v")
            check("切 1Y 后分位有值", kpi and kpi != "—", f"分位显示 {kpi}")
            check("切换过程无报错", not errs, str(errs[:2]))
            b.close()
    finally:
        srv.terminate()
    print(f"  截图：tests/shot_grid.png、tests/shot_detail.png")


if __name__ == "__main__":
    main()
