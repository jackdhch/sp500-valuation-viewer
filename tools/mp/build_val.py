"""把估值面板的数据转成 JSON，放到 mp/cloud_data/val/，再由 upload_data.js 传到云存储。

数据源优先用公开站仓库的本地克隆（~/.cache/sp500-viewer-deploy，每日任务在那边更新），
没有克隆就用 site/。网页那边是 `window.VAL_INDEX={...}` 和 `window.__valPart("T",{...});`
两种 JS 外壳，这里剥掉外壳只留 JSON，内容一个字不改。
"""
import shutil, json, os, glob

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.expanduser(os.environ.get("DEPLOY_REPO", "~/.cache/sp500-viewer-deploy"))
if not os.path.exists(os.path.join(SRC, "valuation_index.js")):
    SRC = os.path.join(ROOT, "site")
CLOUD = os.environ.get("MP_DATA_OUT") or os.path.join(ROOT, "mp", "cloud_data")   # 公开仓库每日任务里另指目录
OUT = os.path.join(CLOUD, "val")
os.makedirs(os.path.join(OUT, "v"), exist_ok=True)

def body(path):
    s = open(path, encoding="utf-8").read()
    return json.loads(s[s.index("{"):s.rindex("}") + 1])

idx = body(os.path.join(SRC, "valuation_index.js"))
json.dump(idx, open(os.path.join(OUT, "index.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
n = 0
for p in glob.glob(os.path.join(SRC, "v", "*.js")):
    t = os.path.basename(p)[:-3]
    json.dump(body(p), open(os.path.join(OUT, "v", t + ".json"), "w", encoding="utf-8"), separators=(",", ":"))
    n += 1
# 事件图用的完整价格（VOO/QQQ/GOLD/BTC 自 2015 年起）。分片里的价格被裁到估值序列的起点，
# 纳指估值只有 2024-01 起，拿分片画事件图会把 2016-2023 的加息全甩在区间外，所以另用这份
json.dump(body(os.path.join(SRC, "poster_px.js")), open(os.path.join(OUT, "poster_px.json"), "w", encoding="utf-8"), separators=(",", ":"))
# 策略回测页（网页 backtest_ui.js）的数据：38 KB，一份就够（不是每天更新，本地重跑 scripts/backtest.py 再发布才变）
json.dump(body(os.path.join(SRC, "backtest.js")), open(os.path.join(OUT, "backtest.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
# 研究页的数据（网页 breadth/、entry/、compound/ 各自的 data.js），放 lab/ 下。不是每天更新，本地重算再发布才变
LAB = os.path.join(CLOUD, "lab")
os.makedirs(LAB, exist_ok=True)
for name in ["breadth", "entry", "compound"]:
    src = os.path.join(SRC, name, "data.js")
    if os.path.exists(src):
        raw = json.dumps(body(src), ensure_ascii=False, separators=(",", ":"))
        assert len(raw.encode()) < 1_000_000, f"{name} 有 {len(raw.encode())} 字节，超过云函数 1 MB 上限"
        open(os.path.join(LAB, name + ".json"), "w", encoding="utf-8").write(raw)
# 网站的估值提醒规则（公开仓库根目录 alerts.json），小程序「通知」页的「导入网站那几条」用（云函数 notify 直接读，不走 getData）
if os.path.exists(os.path.join(SRC, "alerts.json")):
    json.dump(json.load(open(os.path.join(SRC, "alerts.json"), encoding="utf-8")), open(os.path.join(OUT, "alerts.json"), "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
# 旧版单页（宽基指数估值台，pages/index）的数据：原来打包在代码里（utils/data.js，1.37 MB，停在本机最后一次构建那天），
# 2026-09-28 起改放云存储 old/a.json + old/b.json，页面进来时取。完整的 data.json 由 scripts/build_dataset.py 生成：
# 本机是 site/data.json；每日任务把那几个脚本原样重跑一遍，写到临时目录、用 FULL_DATA_JSON 指过来（数据和本机逐日一致）。
# 字段裁剪照原来的 build_data.py：去掉主页不画的（各种 EPS、纳指滚动 PE、滚动 PE 的百分位、b1020 宽度），
# 外推标记从逐日布尔数组压成「从第几天开始外推」，抄底分分项只留最新一天。云函数一次最多回 1 MB，拆两份（约 630 KB + 730 KB）
FULL = os.environ.get("FULL_DATA_JSON") or os.path.join(ROOT, "site", "data.json")
_old_a = os.path.join(CLOUD, "old", "a.json")
_have = json.load(open(_old_a, encoding="utf-8"))["dates"][-1] if os.path.exists(_old_a) else ""
fd = json.load(open(FULL, encoding="utf-8")) if os.path.exists(FULL) else None
if fd and fd["dates"][-1] < _have:
    # 本机 site/data.json 比已经放好的旧（本机没重跑脚本）就不覆盖，免得把每日任务算好的新数据倒回去
    print(f"旧版单页数据：{FULL} 只到 {fd['dates'][-1]}，比现有的 {_have} 旧，不覆盖")
    fd = None
if fd:
    def ex_from(flags):
        idx = [i for i, x in enumerate(flags) if x]
        assert not idx or idx[-1] - idx[0] + 1 == len(idx), "外推段不连续，不能压成一个起点"
        return idx[0] if idx else None
    last = max(i for i, v in enumerate(fd["score"]) if v is not None)
    oa = {k: fd[k] for k in ["generated_at", "dates", "spx", "ndx", "voo", "qqq", "spx_pe", "spx_fpe", "ndx_fpe",
                             "score", "signal", "lows", "triggers", "coverage", "extrapolated_after", "factset_latest"]}
    oa["extrap_from"] = {k: ex_from(fd["extrap_flags"][k]) for k in ["spx_pe", "spx_fpe", "ndx_fpe"]}
    oa["score_parts_last"] = {k: fd["score_parts"][k][last] for k in ["rsi", "ma50", "ret20"]}
    ob = {"generated_at": fd["generated_at"], "pct": {k: fd["pct"][k] for k in ["spx_fpe", "ndx_fpe"]},
          "breadth": {k: fd["breadth"][k] for k in ["b20", "b50", "b200"]},
          "breadth_ndx": {k: fd["breadth_ndx"][k] for k in ["b20", "b50", "b200"]}}
    OLD = os.path.join(CLOUD, "old"); os.makedirs(OLD, exist_ok=True)
    for name, obj in (("a", oa), ("b", ob)):
        raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
        assert len(raw.encode()) < 950_000, f"旧版单页数据 {name} 有 {len(raw.encode())} 字节，快到云函数 1 MB 上限了"
        open(os.path.join(OLD, name + ".json"), "w", encoding="utf-8").write(raw)
    print(f"旧版单页数据：{fd['dates'][-1]}（生成于 {fd['generated_at']}）→ {OLD}")
# 标注低点的只读查看页（网页 site/marker/，线上 /marker/）：行情 spx.js 958 KB 贴着云函数 1 MB 的上限，
# 日期改存「跟前一天差几天」、开高低价跟收盘一样的记 null（1962 年前多是这样），压到约 670 KB
import datetime
if os.path.exists(os.path.join(SRC, "marker", "spx.js")):
    mk = body(os.path.join(SRC, "marker", "spx.js"))
    days = [datetime.date.fromisoformat(x) for x in mk["d"]]
    out = {"n": mk["n"], "d0": mk["d"][0], "dd": [0] + [(days[i] - days[i - 1]).days for i in range(1, len(days))], "c": mk["c"]}
    for k in "ohl":
        out[k] = [None if mk[k][i] == mk["c"][i] else mk[k][i] for i in range(mk["n"])]
    raw = json.dumps(out, separators=(",", ":"))
    assert len(raw.encode()) < 950_000, f"标注器行情 {len(raw.encode())} 字节，快到云函数 1 MB 上限了，要拆成两份"
    open(os.path.join(LAB, "marker.json"), "w").write(raw)
    json.dump(body(os.path.join(SRC, "marker", "marks.js")), open(os.path.join(LAB, "marks.json"), "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
# Dexter 支撑位（小红书 @Dexter 视频封面上人工读的支撑 + 现价，scripts/build_dexter_support.py 生成）。
# 这是别人视频里的内容、也是个人研究，不进公开仓库：本机读 data/xhs_dexter/support.json，
# 每日任务从加密机密写到临时目录、用 DEXTER_JSON 指过来。两边都没有就不动云端那份
DEX = os.environ.get("DEXTER_JSON") or os.path.join(ROOT, "data", "xhs_dexter", "support.json")
if os.path.exists(DEX):
    dex = json.load(open(DEX, encoding="utf-8"))
    assert dex.get("rows"), f"{DEX} 里没有 rows"
    json.dump(dex, open(os.path.join(LAB, "dexter.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    # 详情页用的复权日 K 线（build_dexter_support.py 写在 support.json 旁边的 k/ 里），原样拷成 lab/dxk/{代码}.json
    KD = os.path.join(os.path.dirname(DEX), "k")
    if os.path.isdir(KD):
        os.makedirs(os.path.join(LAB, "dxk"), exist_ok=True)
        for f in os.listdir(KD):
            if f.endswith(".json"): shutil.copy(os.path.join(KD, f), os.path.join(LAB, "dxk", f))
# 低点信号（网页 viewer.js）的数据：按标的拆，云函数一次最多返回 1 MB，整份 viewer_data.js 有 2.8 MB。
# 开盘价 o 没有任何计算用到，去掉；文件名里的 ^ 换成 IDX_（^GSPC → IDX_GSPC），存储路径里别带怪字符
vd = body(os.path.join(SRC, "viewer_data.js"))
SIG = os.path.join(CLOUD, "sig")
os.makedirs(os.path.join(SIG, "s"), exist_ok=True)
fname = lambda tk: tk.replace("^", "IDX_")
json.dump({"built": vd["built"], "meta": vd["meta"], "pctNames": vd["pctNames"], "markedLows": vd.get("markedLows", {}),
           "envelope": vd.get("envelope", {}), "files": {tk: fname(tk) for tk in vd["series"]}},
          open(os.path.join(SIG, "common.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
for tk, s in vd["series"].items():
    one = {"d": s["d"], "h": s["h"], "l": s["l"], "c": s["c"], "pct": vd.get("pct", {}).get(tk, {})}
    raw = json.dumps(one, separators=(",", ":"))
    assert len(raw) < 1_000_000, f"{tk} 拆完还有 {len(raw)} 字节，超过云函数 1 MB 上限"
    open(os.path.join(SIG, "s", fname(tk) + ".json"), "w").write(raw)
print(f"低点信号：{len(vd['series'])} 个标的（生成于 {vd['built']}）→ {SIG}")
missing = [t for t, m in idx["meta"].items() if m.get("has_series") and not os.path.exists(os.path.join(OUT, "v", t + ".json"))]
assert not missing, f"索引里有序列、却没有分片：{missing}"
print(f"来源 {SRC}：索引 {len(idx['meta'])} 个标的（生成于 {idx['built']}），分片 {n} 个 → {OUT}")
