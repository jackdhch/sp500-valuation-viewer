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
import html
import json
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


def load_index():
    path = f"{SITE}/valuation_index.js"
    if not os.path.exists(path):
        sys.exit(f"{path} 不存在，先跑 build_valuation.py")
    s = open(path).read()
    return json.loads(s[s.index("=") + 1:].rstrip().rstrip(";"))


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
            "ticker": t, "name": meta[t].get("name", t), "metric": m,
            "op": op, "threshold": th, "pct": pct, "cur": cur,
            "years": info.get("years"), "status": info.get("status"),
            "note": rule.get("note", ""),
        }))
    return out


def render_email(fired, built):
    """拼邮件正文。所有动态内容一律 escape，见模块开头第 1 条。"""
    e = html.escape
    rows = []
    for d in fired:
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
        "<th style='padding:6px 10px;text-align:right'>十年分位</th>"
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
    results = evaluate(index, rules)
    state = load_json(STATE, {})

    fired_now, newly = [], []
    for rid, hit, d in results:
        was = bool(state.get(rid))
        mark = "触发" if hit else "未触发"
        flag = "（新）" if (hit and not was) else ""
        print(f"  {d['ticker']:6} {METRIC_NAMES[d['metric']]:12} "
              f"分位 {d['pct']:6.2f}%  {mark}{flag}")
        if hit:
            fired_now.append(d)
            if not was:
                newly.append(d)
        state[rid] = hit

    with open(STATE, "w") as f:
        json.dump(state, f, ensure_ascii=False, indent=1, sort_keys=True)

    if not newly:
        print("没有新触发的规则，不发信"
              + (f"（仍在触发中的有 {len(fired_now)} 条）" if fired_now else ""))
        return
    subject = f"估值提醒：{len(newly)} 个标的越线（{index['built']}）"
    print(f"\n{len(newly)} 条新触发，准备发信：{subject}")
    if "--send" in sys.argv:
        send_via_resend(subject, render_email(newly, index["built"]))
    else:
        print("（没有加 --send，只检查不发信）")


if __name__ == "__main__":
    main()
