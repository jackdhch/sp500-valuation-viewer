# -*- coding: utf-8 -*-
"""生成 site/breadth/data.js —— 市场宽度研究页用的数据（可公开，不含个人研究内容）。

只取 2010 年起（市场宽度的起点），列式紧凑格式。
"""
import json, os, csv, datetime

# 公开仓库的每日任务用环境变量指到自己的目录；本机不设，和原来一样
ROOT=os.environ.get("SP500_ROOT") or "/home/d/260909_SP500"; DATA=os.environ.get("SP500_DATA") or f"{ROOT}/data"; SITE=os.environ.get("SP500_SITE") or f"{ROOT}/site"
full=json.load(open(f"{SITE}/data.json"))
D=full["dates"]
i0=next(i for i,d in enumerate(D) if d>="2010-02-01")

def cut(v): return v[i0:]
spx=cut(full["spx"])

# 回撤用全历史最高价算，不能从 2010 截断后重算，否则 2010 年初会凭空出现 0%
peak=-1e18; dd=[]
for v in full["spx"]:
    if v is not None and v>peak: peak=v
    dd.append(None if v is None else round((v/peak-1)*100,2))
dd=cut(dd)

spx_b={k: cut(v) for k,v in full["breadth"].items() if k!="b1020"}
ndx_b={k: cut(v) for k,v in full["breadth_ndx"].items() if k!="b1020"}
dates=cut(D)

out={
 "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
 "dates": dates, "spx": spx, "dd": dd,
 "spx_b": spx_b, "ndx_b": ndx_b,
}
# 极值段不在这里算：阈值在页面上可调，事件清单由前端按当前阈值实时算出来，
# 免得同一套逻辑在两处各写一遍。
os.makedirs(f"{SITE}/breadth", exist_ok=True)
p=f"{SITE}/breadth/data.js"
with open(p,"w",encoding="utf-8") as f:
    f.write("window.BREADTH_DATA=")
    json.dump(out,f,separators=(",",":"),ensure_ascii=False)
    f.write(";\n")
print(p, round(os.path.getsize(p)/1024), "KB,", len(out["dates"]), "天,", out["dates"][0], "→", out["dates"][-1])
print("末日", {k:v[-1] for k,v in out["spx_b"].items()}, "| 纳指", {k:v[-1] for k,v in out["ndx_b"].items()}, "| 回撤", dd[-1])
