# -*- coding: utf-8 -*-
"""计算「抄底分」并落盘。三个分项都是 point-in-time 百分位，只用当日及以前的数据。
   抄底分 = (2×超卖RSI + 1×跌破50日线 + 1×20日跌幅) / 4，越高越像底部。"""
import os, pandas as pd, numpy as np, json
# 公开仓库的每日任务用环境变量指到自己的目录；本机不设，和原来一样
D=os.environ.get("SP500_DATA") or "/home/d/260909_SP500/data"
spx=pd.read_csv(f"{D}/sp500_index.csv", parse_dates=["Date"]).set_index("Date")["Close"].rename("px")
vix=pd.read_csv(f"{D}/vix.csv", parse_dates=["Date"]).set_index("Date")["Close"].rename("vix")
df=pd.DataFrame(spx).join(vix, how="left"); df=df[df.index>="1990-01-02"]; df["vix"]=df["vix"].ffill()

d1=df.px.diff()
up=d1.clip(lower=0).ewm(alpha=1/14, adjust=False).mean()
dn=(-d1.clip(upper=0)).ewm(alpha=1/14, adjust=False).mean()
df["rsi14"]=100-100/(1+up/dn.replace(0,np.nan))
df["ma50"] =df.px/df.px.rolling(50, min_periods=30).mean()-1
df["ret20"]=df.px/df.px.shift(20)-1
df["dd"]   =1-df.px/df.px.rolling(250, min_periods=60).max()

def pit(s, win=750):
    return s.rolling(win, min_periods=250).apply(lambda a:(a<=a[-1]).mean()*100, raw=True)

df["f_rsi"]  =100-pit(df.rsi14)
df["f_ma50"] =100-pit(df.ma50)
df["f_ret20"]=100-pit(df.ret20)
df["vix_p"]  =pit(df.vix)
df["score"]  =(2*df.f_rsi + df.f_ma50 + df.f_ret20)/4

out=df[["score","f_rsi","f_ma50","f_ret20","vix_p","dd"]].dropna(subset=["score"]).round(2)
out.to_csv(f"{D}/bottom_score.csv")
meta={"threshold_major":97,"threshold_minor":91,
      "formula":"(2×超卖RSI百分位 + 跌破50日线百分位 + 20日跌幅百分位) ÷ 4",
      "current":float(out.score.iloc[-1]), "current_date":str(out.index[-1].date()),
      "marked_lows":["2020-03-23","2025-04-07","2025-11-21","2026-03-30","2026-07-29"]}
json.dump(meta, open(f"{D}/signal_meta.json","w"), ensure_ascii=False, indent=2)
print(f"bottom_score.csv {len(out)} 行 {out.index[0].date()} → {out.index[-1].date()}，当前 {out.score.iloc[-1]:.1f} 分")

# ---------- 客观局部低点：供操作者校准 ----------
def find_lows(p, look=40, fwd=60, rise=0.06, merge=30):
    rmin=p.rolling(look).min()
    fmax=p[::-1].rolling(fwd, min_periods=1).max()[::-1].shift(-1)
    cand=p.index[(p<=rmin)&(fmax/p-1>=rise)]
    out=[]
    for d in cand:
        if out and (d-out[-1]).days<merge:
            if p[d]<p[out[-1]]: out[-1]=d
        else: out.append(d)
    return pd.DatetimeIndex(out)

lows=find_lows(df.px)
last_confirmable=df.index[-61] if len(df)>61 else df.index[0]
rows=[]
for d in lows:
    fwd60=df.px.shift(-60).get(d, np.nan)/df.px[d]-1
    rows.append({"date":str(d.date()), "px":round(float(df.px[d]),2),
                 "dd":round(float(df.dd.get(d,np.nan))*100,1),
                 "score":round(float(df.score.get(d,np.nan)),1) if df.score.get(d,np.nan)==df.score.get(d,np.nan) else None,
                 "fwd60":round(float(fwd60)*100,1) if fwd60==fwd60 else None})
json.dump({"rule":"当日为过去 40 个交易日最低收盘，且其后 60 个交易日内反弹 ≥6%；相邻 30 天内合并取更低者",
           "confirmable_until":str(last_confirmable.date()),
           "n":len(rows), "lows":rows},
          open(f"{D}/local_lows.json","w"), ensure_ascii=False, indent=1)
print(f"局部低点 {len(rows)} 个，{rows[0]['date']} → {rows[-1]['date']}（{last_confirmable.date()} 之后的还无法确认）")
