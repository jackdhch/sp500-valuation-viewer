# -*- coding: utf-8 -*-
"""检查估值提醒规则，需要时通过 Resend 发一封邮件。

在 GitHub Actions 里跟在 build_valuation.py 后面跑：数据刚更新完，拿最新的分位
对一遍 alerts.json 里的规则，只有「上次没触发、这次触发了」才发信——
否则一只股票便宜了会天天发，很快就没人看了。

安全上的几条硬规矩（公开仓库 + 自动发信，这些不能省）：

1. **邮件正文里所有动态内容都做 HTML 转义**。标的名、说明文字这些虽然目前都来自
   本仓库自己生成的数据，但只要哪天数据源换成抓来的，未转义的 `<script>` 就会
   直接进邮件正文。转义是一行的事，不值得赌。
2. **规则字段全部做白名单校验**：ticker 必须在数据里存在，metric 只能是 pe/fwd_pe/pb，
   op 只能是 below/above，threshold 必须是 0-100 的数。不认识的规则直接跳过并报告，
   不做「尽量理解」。
3. **密钥只从环境变量读，绝不打印**。发送失败时只打印 HTTP 状态码，不打印请求体
   （请求头里有 Bearer token）。
4. **收件地址也放 Secrets**，不写进仓库——仓库是公开的，写进去等于公开挂邮箱。
5. 不用 shell 拼接命令发信，直接用标准库发 HTTPS 请求。

    python3 scripts/check_alerts.py            # 只检查并打印，不发信
    python3 scripts/check_alerts.py --send     # 有新触发就发信
"""
import datetime
import html
import json
import math
import os
import sys
import urllib.error
import urllib.request

ROOT = os.environ.get("SP500_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.environ.get("SP500_SITE") or f"{ROOT}/site"
ALERTS = os.environ.get("SP500_ALERTS") or f"{ROOT}/alerts.json"
STATE = os.environ.get("SP500_ALERT_STATE") or f"{ROOT}/alerts_state.json"

METRIC_NAMES = {"pe": "PE (TTM)", "fwd_pe": "Forward PE", "pb": "PB"}
VALID_OPS = {"below", "above"}
ENTRY = os.environ.get("SP500_ENTRY") or f"{SITE}/entry/data.js"
SIGMA_RANGE = (-4.0, 4.0)


def load_index():
    path = f"{SITE}/valuation_index.js"
    if not os.path.exists(path):
        sys.exit(f"{path} 不存在，先跑 build_valuation.py")
    s = open(path).read()
    return json.loads(s[s.index("=") + 1:].rstrip().rstrip(";"))


def load_entry():
    """买点位置研究的数据（site/entry/data.js）。没有就返回 None，σ 规则整体跳过。"""
    if not os.path.exists(ENTRY):
        return None
    s = open(ENTRY).read()
    return json.loads(s[s.index("=") + 1:].rstrip().rstrip(";"))


def spx_now(entry, index):
    """当前指数点位与它的日期。

    优先用本地的 ^GSPC 日线；公开仓库的每日任务不抓它，那时退回用 VOO 收盘价
    乘以参考日的 指数/VOO 比值来估算——两者同步度很高，日内换算误差远小于
    一档 σ（0.25σ 约合 8%）。
    """
    path = f"{ROOT}/data/sp500_index.csv"
    if os.path.exists(path):
        last = open(path).read().rstrip().rsplit("\n", 1)[-1].split(",")
        try:
            return float(last[4]), last[0], "^GSPC 收盘"
        except (IndexError, ValueError):
            pass
    v = (index.get("meta") or {}).get("VOO") or {}
    if v.get("px") and entry["meta"].get("spx_per_voo"):
        return float(v["px"]) * entry["meta"]["spx_per_voo"], v.get("px_date", ""), "VOO 换算"
    return None, "", ""


def validate_sigma(rule):
    op = rule.get("op", "below")
    if op not in VALID_OPS:
        return f"op {op!r} 只能是 below / above"
    th = rule.get("threshold")
    if not isinstance(th, (int, float)) or not SIGMA_RANGE[0] <= th <= SIGMA_RANGE[1]:
        return f"threshold {th!r} 要是 {SIGMA_RANGE[0]}~{SIGMA_RANGE[1]} 之间的 σ 值"
    return None


def evaluate_sigma(entry, index, rules):
    """σ 规则：把目标 σ 反解成今天的指数点位，再和当前点位比。

    为什么要按天重算：趋势线本身一直在往上走（实际口径每月约 0.54%，
    加通胀后名义每月约 0.75%），同一条 σ 线昨天和今天不是一个数。
    """
    out = []
    if not rules:
        return out
    if entry is None:
        print(f"  {ENTRY} 不存在，σ 规则全部跳过（先跑 analysis/entry_sigma/calc.py）")
        return out
    m = entry["meta"]
    cur_px, cur_date, src = spx_now(entry, index)
    if cur_px is None:
        print("  拿不到当前指数点位，σ 规则全部跳过")
        return out
    try:
        days = (datetime.date.fromisoformat(cur_date) - datetime.date.fromisoformat(m["spx_date"])).days
    except ValueError:
        days = 0
    drift = math.exp(m["daily_rate"] * max(days, 0))
    for i, rule in enumerate(rules):
        why = validate_sigma(rule)
        if why:
            print(f"  跳过第 {i + 1} 条 σ 规则：{why}")
            continue
        op, th = rule.get("op", "below"), rule["threshold"]
        line = m["spx"] * math.exp((th - m["z_now"]) * m["sd_now"]) * drift
        hit = (cur_px < line) if op == "below" else (cur_px > line)
        out.append((f"SIGMA|{op}|{th}", hit, {
            "kind": "sigma", "threshold": th, "op": op,
            "line": round(line), "cur": round(cur_px), "cur_date": cur_date, "src": src,
            "gap": round((cur_px / line - 1) * 100, 1),
            "z_ref": m["z_now"], "ref_date": m["spx_date"],
            "note": rule.get("note", ""),
        }))
    return out


def load_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"读 {path} 失败（{e}），当成空的处理")
        return default


def validate(rule, meta):
    """白名单校验。返回 None 表示这条规则不合法，调用方跳过它。"""
    t = rule.get("ticker")
    if not isinstance(t, str) or t not in meta:
        return f"ticker {t!r} 不在数据里"
    m = rule.get("metric", "pe")
    if m not in METRIC_NAMES:
        return f"metric {m!r} 只能是 {sorted(METRIC_NAMES)}"
    op = rule.get("op", "below")
    if op not in VALID_OPS:
        return f"op {op!r} 只能是 below / above"
    th = rule.get("threshold")
    if not isinstance(th, (int, float)) or not 0 <= th <= 100:
        return f"threshold {th!r} 要是 0-100 的数"
    return None


def evaluate(index, rules):
    """返回 [(rule_id, 是否触发, 详情)]。"""
    meta = index["meta"]
    out = []
    for i, rule in enumerate(rules):
        if rule.get("kind") == "sigma":
            continue
        why = validate(rule, meta)
        if why:
            print(f"  跳过第 {i + 1} 条规则：{why}")
            continue
        t, m = rule["ticker"], rule.get("metric", "pe")
        op, th = rule.get("op", "below"), rule["threshold"]
        info = (meta[t].get("pct10y") or {}).get(m) or {}
        pct = info.get("pct")
        cur = (meta[t].get("cur") or {}).get(m)
        rid = f"{t}|{m}|{op}|{th}"
        if pct is None:
            print(f"  {t} {m}：分位为空（{info.get('status', '无数据')}），跳过")
            continue
        hit = (pct < th) if op == "below" else (pct > th)
        out.append((rid, hit, {
            "kind": "valuation", "ticker": t, "name": meta[t].get("name", t), "metric": m,
            "op": op, "threshold": th, "pct": pct, "cur": cur,
            "years": info.get("years"), "status": info.get("status"),
            "note": rule.get("note", ""),
        }))
    return out


def render_email(fired, built):
    """拼邮件正文。所有动态内容一律 escape，见模块开头第 1 条。"""
    e = html.escape
    rows = []
    for d in [x for x in fired if x.get("kind") == "sigma"]:
        cmp_txt = "跌破" if d["op"] == "below" else "升破"
        rows.append(
            "<tr>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #eee'><b>标普500 买点位置</b>"
            f"<br><span style='color:#888;font-size:12px'>{e(str(d['threshold']))}σ 线</span></td>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #eee'>{e(cmp_txt)}趋势线偏离</td>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #eee;text-align:right'>"
            f"{e(str(d['cur']))}<br><span style='color:#888;font-size:12px'>{e(d['src'])} "
            f"{e(d['cur_date'])}</span></td>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #eee;text-align:right'>"
            f"<b>{e(str(d['line']))}</b><br><span style='color:#888;font-size:12px'>"
            f"当日这条线的位置</span></td>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #eee;color:#666;font-size:12px'>"
            f"{e(d.get('note') or '')}</td>"
            "</tr>")
    for d in [x for x in fired if x.get("kind") != "sigma"]:
        cmp_txt = "跌破" if d["op"] == "below" else "升破"
        rows.append(
            "<tr>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #eee'><b>{e(d['name'])}</b>"
            f"<br><span style='color:#888;font-size:12px'>{e(d['ticker'])}</span></td>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #eee'>{e(METRIC_NAMES[d['metric']])}</td>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #eee;text-align:right'>"
            f"{e(str(d['cur']))}</td>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #eee;text-align:right'>"
            f"<b>{e(str(d['pct']))}%</b><br><span style='color:#888;font-size:12px'>"
            f"{e(cmp_txt)} {e(str(d['threshold']))}%</span></td>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #eee;color:#666;font-size:12px'>"
            f"{e(d.get('note') or '')}</td>"
            "</tr>")
    return (
        "<div style=\"font:14px/1.6 -apple-system,'Segoe UI',sans-serif;color:#222\">"
        f"<h2 style='margin:0 0 4px'>估值提醒 · {e(built)}</h2>"
        "<p style='margin:0 0 14px;color:#666;font-size:13px'>"
        "下面这些标的的估值分位越过了你设的线。分位口径是<b>固定十年窗口</b>，"
        "上市不足十年的按实际年限算。</p>"
        "<table style='border-collapse:collapse;width:100%;max-width:640px'>"
        "<tr style='text-align:left;color:#666;font-size:12px'>"
        "<th style='padding:6px 10px'>标的</th><th style='padding:6px 10px'>指标</th>"
        "<th style='padding:6px 10px;text-align:right'>当前值</th>"
        "<th style='padding:6px 10px;text-align:right'>分位 / 触发线</th>"
        "<th style='padding:6px 10px'>备注</th></tr>"
        + "".join(rows) +
        "</table>"
        "<p style='margin:16px 0 0;font-size:12px;color:#888'>"
        "本邮件由仓库的定时任务自动发出，只呈现公开市场数据及其历史分布位置，不构成投资建议。<br>"
        "页面：https://jackdhch.github.io/sp500-valuation-viewer/</p></div>")


def send_via_resend(subject, body_html):
    key = os.environ.get("RESEND_API_KEY")
    to = os.environ.get("ALERT_TO")
    sender = os.environ.get("ALERT_FROM", "onboarding@resend.dev")
    if not key or not to:
        print("没有 RESEND_API_KEY 或 ALERT_TO，跳过发信（本地检查时这是正常的）")
        return False
    payload = json.dumps({"from": sender, "to": [to],
                          "subject": subject, "html": body_html}).encode()
    req = urllib.request.Request(
        "https://api.resend.com/emails", data=payload,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print(f"邮件已发出（HTTP {r.status}）")
            return True
    except urllib.error.HTTPError as ex:
        # 只打状态码和 Resend 返回的错误描述，不打请求体——请求头里有密钥
        try:
            msg = json.loads(ex.read().decode()).get("message", "")
        except Exception:
            msg = ""
        print(f"发信失败：HTTP {ex.code} {msg}")
        return False
    except Exception as ex:
        print(f"发信失败：{type(ex).__name__}")
        return False


def main():
    index = load_index()
    cfg = load_json(ALERTS, {"rules": []})
    rules = cfg.get("rules") or []
    if not rules:
        print("alerts.json 里没有规则，什么都不做")
        return

    print(f"数据生成于 {index['built']}，检查 {len(rules)} 条规则")
    entry = load_entry()
    results = evaluate(index, rules)
    results += evaluate_sigma(entry, index, [r for r in rules if r.get("kind") == "sigma"])
    state = load_json(STATE, {})

    fired_now, newly, newly_ids = [], [], []
    for rid, hit, d in results:
        was = bool(state.get(rid))
        mark = "触发" if hit else "未触发"
        flag = "（新）" if (hit and not was) else ""
        if d.get("kind") == "sigma":
            print(f"  {'σ线':6} {str(d['threshold']) + 'σ':12} "
                  f"触发点位 {d['line']:>6}　现价 {d['cur']}（{d['src']}，{d['cur_date']}）"
                  f" 差 {d['gap']:+.1f}%  {mark}{flag}")
        else:
            print(f"  {d['ticker']:6} {METRIC_NAMES[d['metric']]:12} "
                  f"分位 {d['pct']:6.2f}%  {mark}{flag}")
        if hit:
            fired_now.append(d)
            if not was:
                newly.append(d)
                newly_ids.append(rid)
        state[rid] = hit

    def save_state():
        with open(STATE, "w") as f:
            json.dump(state, f, ensure_ascii=False, indent=1, sort_keys=True)

    if not newly:
        save_state()
        print("没有新触发的规则，不发信"
              + (f"（仍在触发中的有 {len(fired_now)} 条）" if fired_now else ""))
        return
    subject = f"估值提醒：{len(newly)} 个标的越线（{index['built']}）"
    print(f"\n{len(newly)} 条新触发，准备发信：{subject}")
    sent = False
    if "--send" in sys.argv:
        sent = send_via_resend(subject, render_email(newly, index["built"]))
    else:
        print("（没有加 --send，只检查不发信）")
    # 信没发出去（没配密钥、发信失败、只检查不发）时，新触发的这几条不记成「已提醒」，下次还会再发
    # （2026-09-28 以前是先记状态再发信，密钥一直没配，状态里却全记成已提醒，配上密钥也补不回来）
    if not sent:
        for rid in newly_ids:
            state[rid] = False
    save_state()


if __name__ == "__main__":
    main()
