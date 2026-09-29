import yfinance as yf, pandas as pd, os, json, datetime
OUT=os.environ.get("SP500_DATA") or "/home/d/260909_SP500/data"   # 公开仓库每日任务用环境变量指到自己的 data/
# ^VIX 给抄底分（build_signal.py 的恐慌指数百分位）用，2026-09-28 加：旧版单页的数据改由每日任务重算
tickers={"^GSPC":"sp500_index","^NDX":"ndx_index","VOO":"voo","QQQ":"qqq","^VIX":"vix"}
meta={}
frames={}
for t,name in tickers.items():
    tk=yf.Ticker(t)
    df=tk.history(period="max", interval="1d", auto_adjust=False)
    if df.empty:
        print("EMPTY",t); continue
    df.index=pd.to_datetime(df.index).tz_localize(None).normalize()
    # Yahoo 常给「今天」一行空收盘价（盘中，有时收盘后几个小时也这样），写进去会让下游对不齐或崩，直接丢掉
    frames[t]=df[["Open","High","Low","Close","Volume"]].dropna(subset=["Close"])
# 四条价格的最后一天对齐：Yahoo 常常指数先给出当天价、ETF 晚一点。对不齐时都截到共有的最后一天，
# 不然同一页上指数到今天、VOO/QQQ 到上周五；下一个定时点（或第二天）再补上。^VIX 只给抄底分用，不参与
core=[t for t in ("^GSPC","^NDX","VOO","QQQ") if t in frames]
if core:
    end=min(frames[t].index[-1] for t in core)
    for t in core:
        if frames[t].index[-1]>end:
            print("  %s 最后一天 %s 晚于共有的 %s，先截掉"%(t,frames[t].index[-1].date(),end.date()))
            frames[t]=frames[t][frames[t].index<=end]
for t,name in tickers.items():
    if t not in frames: continue
    df=frames[t]
    p=os.path.join(OUT,f"{name}.csv")
    df.to_csv(p, float_format="%.4f")
    meta[t]={"file":os.path.basename(p),"rows":len(df),"start":str(df.index[0].date()),"end":str(df.index[-1].date()),"last_close":float(df["Close"].iloc[-1])}
    print(t,name,len(df),df.index[0].date(),df.index[-1].date(),round(float(df['Close'].iloc[-1]),2))
meta["fetched_at"]=datetime.datetime.now().isoformat(timespec="seconds")
json.dump(meta,open(os.path.join(OUT,"prices_meta.json"),"w"),indent=2)
