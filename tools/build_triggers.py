# -*- coding: utf-8 -*-
"""反解：标普500 还要跌到多少点，抄底分才会触及 91 / 97。
抄底分只依赖价格（RSI14、距50日均线、20日跌幅的百分位），所以可以精确反解。
分别给「一天跌到位」和「未来 5 / 20 个交易日匀速跌到位」三种路径。"""
import os, pandas as pd, numpy as np, json

# 公开仓库的每日任务用环境变量指到自己的目录；本机不设，和原来一样
D=os.environ.get("SP500_DATA") or "/home/d/260909_SP500/data"
px=pd.read_csv(f"{D}/sp500_index.csv", parse_dates=["Date"]).set_index("Date")["Close"]
px=px[px.index>="1989-01-01"]
A=1/14; WIN=750

def rsi_state(series):
    """把 EWM 的 up/dn 状态推到序列末尾。"""
    d=series.diff()
    up=d.clip(lower=0).ewm(alpha=A, adjust=False).mean()
    dn=(-d.clip(upper=0)).ewm(alpha=A, adjust=False).mean()
    return float(up.iloc[-1]), float(dn.iloc[-1])

def simulate(path):
    """给定未来若干天的收盘价路径，返回最后一天的抄底分。"""
    p=px.copy()
    up,dn=rsi_state(p)
    # 历史三项的原始序列，用于算百分位
    d=p.diff()
    u=d.clip(lower=0).ewm(alpha=A, adjust=False).mean()
    v=(-d.clip(upper=0)).ewm(alpha=A, adjust=False).mean()
    rsi_hist=(100-100/(1+u/v.replace(0,np.nan))).dropna()
    ma50_hist=(p/p.rolling(50).mean()-1).dropna()
    ret20_hist=(p/p.shift(20)-1).dropna()
    vals=list(p.values)
    rl, ml, tl = list(rsi_hist.values), list(ma50_hist.values), list(ret20_hist.values)
    score=None
    for newp in path:
        diff=newp-vals[-1]
        up=(1-A)*up + A*max(diff,0.0)
        dn=(1-A)*dn + A*max(-diff,0.0)
        rsi=100-100/(1+up/dn) if dn>0 else 100.0
        vals.append(newp)
        ma50=np.mean(vals[-50:]); mdev=newp/ma50-1
        r20=newp/vals[-21]-1
        def pit(hist, x):
            w=hist[-(WIN-1):]+[x]
            return sum(1 for a in w if a<=x)/len(w)*100
        f_rsi  =100-pit(rl, rsi)
        f_ma50 =100-pit(ml, mdev)
        f_ret20=100-pit(tl, r20)
        score=(2*f_rsi + f_ma50 + f_ret20)/4
        rl.append(rsi); ml.append(mdev); tl.append(r20)
    return score

cur=float(px.iloc[-1]); curd=px.index[-1].date()
def solve(days, target):
    """二分找出：在 days 个交易日内匀速跌到 P 时，抄底分刚好达到 target 的那个 P。"""
    lo, hi = cur*0.55, cur*1.001
    if simulate([cur*(1+(lo/cur-1)*k/days) for k in range(1,days+1)]) < target:
        return None                      # 跌到 45% 都触发不了
    for _ in range(40):
        mid=(lo+hi)/2
        s=simulate([cur*(1+(mid/cur-1)*k/days) for k in range(1,days+1)])
        if s>=target: lo=mid
        else: hi=mid
        if hi-lo<0.5: break
    return lo

out={"as_of":str(curd),"spx":round(cur,2),"paths":[]}
for days,label in [(1,"一天之内跌到"),(5,"5 个交易日匀速跌到"),(20,"20 个交易日匀速跌到")]:
    row={"days":days,"label":label,"levels":{}}
    for th in [91,97]:
        p=solve(days,th)
        row["levels"][str(th)]= None if p is None else {
            "spx": round(p,0), "drop_pct": round((p/cur-1)*100,2),
            "voo": None, "qqq": None}
    out["paths"].append(row)
    print(f"{label:22s} 91分→{row['levels']['91']}  97分→{row['levels']['97']}")

# 换算成 VOO / QQQ 的近似价位（用最近 60 个交易日的平均比价）
voo=pd.read_csv(f"{D}/voo.csv", parse_dates=["Date"]).set_index("Date")["Close"]
r_voo=float((voo/px.reindex(voo.index)).dropna().iloc[-60:].mean())
for row in out["paths"]:
    for th,v in row["levels"].items():
        if v: v["voo"]=round(v["spx"]*r_voo,2)
out["voo_ratio"]=round(r_voo,6)
out["current_score"]=round(simulate([cur]),2)   # 校验：原地不动应约等于当前分
json.dump(out, open(f"{D}/trigger_levels.json","w"), ensure_ascii=False, indent=2)
print(f"\n当前 {curd} 标普500 = {cur:.2f}；校验（价格不变时算出的分）= {out['current_score']}")
print("已存 data/trigger_levels.json")
