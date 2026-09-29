# -*- coding: utf-8 -*-
"""把下载的原始数据合成前端用的 site/data.json（列式紧凑格式）。"""
import csv, json, os, datetime, math, bisect

# 公开仓库的每日任务用环境变量指到自己的目录；本机不设，和原来一样
ROOT=os.environ.get("SP500_ROOT") or "/home/d/260909_SP500"; DATA=os.environ.get("SP500_DATA") or f"{ROOT}/data"; SITE=os.environ.get("SP500_SITE") or f"{ROOT}/site"
START=datetime.date(1985,10,1)          # 纳指100 起点

def read_price(name):
    out={}
    with open(f"{DATA}/{name}.csv") as f:
        for r in csv.DictReader(f):
            d=datetime.date.fromisoformat(r["Date"][:10])
            c=r["Close"]
            if c and c!="": out[d]=float(c)
    return out

spx=read_price("sp500_index"); ndx=read_price("ndx_index")
voo=read_price("voo");         qqq=read_price("qqq")

# 交易日轴：以标普500为准（NYSE 日历），从 START 起
dates=sorted(d for d in spx if d>=START)

def read_kv(path, dcol="date", vcol="value"):
    out=[]
    with open(path) as f:
        for r in csv.DictReader(f):
            try: out.append((datetime.date.fromisoformat(r[dcol]), float(r[vcol])))
            except (ValueError, KeyError, TypeError): pass
    return sorted(out)

def interp(series, dates, extend=True):
    """把稀疏 (date,value) 线性插值到日频；区间外按最近端点延展（extend）或留空。"""
    if not series: return [None]*len(dates)
    xs=[s[0].toordinal() for s in series]; ys=[s[1] for s in series]
    res=[]
    for d in dates:
        x=d.toordinal()
        if x<=xs[0]:  res.append(ys[0] if extend else None); continue
        if x>=xs[-1]: res.append(ys[-1] if extend else None); continue
        i=bisect.bisect_left(xs,x)
        x0,x1,y0,y1=xs[i-1],xs[i],ys[i-1],ys[i]
        res.append(y0 + (y1-y0)*(x-x0)/(x1-x0))
    return res

# ---------- 标普500 TTM 每股收益 ----------
# 注意：multpl 的 s-p-500-earnings 表是「通胀调整后的实际每股收益」（1985年给 46.15，
# 而当年真实名义值约 14.6），直接用会把早年市盈率压到 4 倍这种荒谬水平。
# 它的 s-p-500-pe-ratio 表才是名义口径（1985-10 = 12.39，正确），
# 所以改用 P/E 表反推名义每股收益：名义EPS = 该月指数点位 / 该月名义P/E。
_spx_dates=sorted(spx)
def px_at(d):
    i=bisect.bisect_left(_spx_dates,d)
    if i>=len(_spx_dates): i=len(_spx_dates)-1
    return spx[_spx_dates[i]]
spx_eps_pts=[(d, px_at(d)/pe) for d,pe in read_kv(f"{DATA}/sp500_pe_ttm_monthly.csv") if pe>0]
spx_eps=interp(spx_eps_pts, dates)

# ---------- 标普500 前瞻12个月每股收益：由 FactSet 的前瞻市盈率反推 ----------
fwd_pts=[]
p=f"{DATA}/sp500_forward_pe_factset.csv"
if os.path.exists(p):
    for d,pe in read_kv(p, "date", "fwd_pe_12m"):
        # 用报告日（或最近交易日）的标普收盘价反推前瞻EPS
        dd=d
        for _ in range(7):
            if dd in spx: break
            dd-=datetime.timedelta(days=1)
        if dd in spx and pe>0: fwd_pts.append((d, spx[dd]/pe))
fwd_pts.sort()
spx_fwd_eps=interp(fwd_pts, dates, extend=True) if fwd_pts else [None]*len(dates)
SPX_F_FIRST=min(d for d,_ in fwd_pts) if fwd_pts else None
SPX_F_LAST =max(d for d,_ in fwd_pts) if fwd_pts else None
if SPX_F_FIRST:
    for i,d in enumerate(dates):
        if d < SPX_F_FIRST: spx_fwd_eps[i]=None

# ---------- 纳指100：Siblis 季度 TTM / 前瞻每股收益 ----------
# Siblis 的 EPS 列是「2023-12-31 = 100」的归一化指数，需乘换算系数才是指数点口径。
# 系数由表内 price/(PE*EPS) 反推，18 个独立测算一致（5.5622 +- 0.0005）。
rows_sib=list(csv.DictReader(open(f"{DATA}/ndx_valuation_siblis.csv")))
ks=[]
for r in rows_sib:
    ks.append(float(r["ndx_price"])/(float(r["pe_ttm"])*float(r["eps_ttm"])))
    ks.append(float(r["ndx_price"])/(float(r["pe_fwd"])*float(r["eps_fwd"])))
K=sum(ks)/len(ks)
ndx_eps_pts=[]; ndx_feps_pts=[]
for r in rows_sib:
    d=datetime.date.fromisoformat(r["date"])
    ndx_eps_pts.append((d,float(r["eps_ttm"])*K)); ndx_feps_pts.append((d,float(r["eps_fwd"])*K))
# 末端向后延展（最后一个锚点之后为外推，前端会标注）
ndx_eps =interp(sorted(ndx_eps_pts),  dates, extend=True)
ndx_feps=interp(sorted(ndx_feps_pts), dates, extend=True)
NDX_FIRST=min(d for d,_ in ndx_eps_pts); NDX_LAST=max(d for d,_ in ndx_eps_pts)
for i,d in enumerate(dates):
    if d < NDX_FIRST: ndx_eps[i]=None; ndx_feps[i]=None

MAX_EXTRAP_DAYS=120   # 最后一个锚点之后最多外推 120 个日历天，再远就置空
def clip_extrap(vals, last_anchor):
    flag=[False]*len(dates)
    if last_anchor is None: return vals, flag
    for i,d in enumerate(dates):
        if vals[i] is None: continue
        if d>last_anchor:
            if (d-last_anchor).days>MAX_EXTRAP_DAYS: vals[i]=None
            else: flag[i]=True
    return vals, flag

SPX_EPS_LAST=max(d for d,_ in spx_eps_pts)
spx_eps,  spx_eps_x  = clip_extrap(spx_eps,  SPX_EPS_LAST)
spx_fwd_eps, spx_f_x = clip_extrap(spx_fwd_eps, SPX_F_LAST)
ndx_eps,  ndx_eps_x  = clip_extrap(ndx_eps,  NDX_LAST)
ndx_feps, ndx_f_x    = clip_extrap(ndx_feps, NDX_LAST)

def ratio(px_map, eps_list):
    out=[]
    for d,e in zip(dates, eps_list):
        v=px_map.get(d)
        out.append(round(v/e,3) if (v is not None and e and e>0) else None)
    return out

spx_pe  = ratio(spx, spx_eps)
spx_fpe = ratio(spx, spx_fwd_eps)
ndx_pe  = ratio(ndx, ndx_eps)
ndx_fpe = ratio(ndx, ndx_feps)

# ---------- 百分位（point-in-time 滚动窗口，含当日；不使用未来数据） ----------
WINDOWS={"3y":756,"5y":1260,"10y":2520,"all":None}
MIN_OBS=500   # 至少 500 个交易日（约两年）才出百分位，否则排名会剧烈跳动
def percentiles(vals, win):
    """vals 中每个非空点在过去 win 个有效观测（含自身）里的百分位（0-100）。"""
    out=[None]*len(vals); hist=[]
    for i,v in enumerate(vals):
        if v is None: continue
        hist.append(v)
        w = hist if win is None else hist[-win:]
        if len(w)<MIN_OBS: continue
        s=sorted(w)
        # 「小于等于当前值的比例」，并列取中点，避免总在 100%
        lo=bisect.bisect_left(s,v); hi=bisect.bisect_right(s,v)
        out[i]=round(100.0*((lo+hi)/2)/len(s),2)
    return out

series={"spx_pe":spx_pe,"spx_fpe":spx_fpe,"ndx_pe":ndx_pe,"ndx_fpe":ndx_fpe}
pct={k:{w:percentiles(v,n) for w,n in WINDOWS.items()} for k,v in series.items()}

def col(m): return [round(m[d],2) if d in m else None for d in dates]
def r2(l,n=2): return [None if v is None else round(v,n) for v in l]

# ---------- 抄底分（见 scripts/build_signal.py）----------
score_map={}; feat_map={}
try:
    for r in csv.DictReader(open(f"{DATA}/bottom_score.csv")):
        d=datetime.date.fromisoformat(r["Date"][:10])
        score_map[d]=float(r["score"])
        feat_map[d]=(float(r["f_rsi"]),float(r["f_ma50"]),float(r["f_ret20"]),float(r["vix_p"]))
except FileNotFoundError:
    pass
sig_meta={}
try: sig_meta=json.load(open(f"{DATA}/signal_meta.json"))
except FileNotFoundError: pass
lows_meta={}
try: lows_meta=json.load(open(f"{DATA}/local_lows.json"))
except FileNotFoundError: pass
trig={}
try: trig=json.load(open(f"{DATA}/trigger_levels.json"))
except FileNotFoundError: pass

# ---------- 市场广度（scripts/fetch_breadth.py 产出） ----------
# 四条曲线都是「成分股占比」，等权，缺数据的日子留空（不插值、不延展）。
def read_breadth(fname):
    got={"b20":{}, "b50":{}, "b200":{}, "b1020":{}}
    pb=f"{DATA}/{fname}"
    if os.path.exists(pb):
        for r in csv.DictReader(open(pb)):
            d=datetime.date.fromisoformat(r["date"][:10])
            for k in got:
                if r.get(k): got[k][d]=float(r[k])
    return {k:[round(v[d],2) if d in v else None for d in dates] for k,v in got.items()}
breadth=read_breadth("breadth.csv")
breadth_ndx=read_breadth("breadth_ndx.csv")

meta=json.load(open(f"{DATA}/prices_meta.json"))
payload={
 "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
 "dates":[d.isoformat() for d in dates],
 "spx":col(spx),"ndx":col(ndx),"voo":col(voo),"qqq":col(qqq),
 "spx_eps":r2(spx_eps),"spx_fwd_eps":r2(spx_fwd_eps),
 "ndx_eps":r2(ndx_eps),"ndx_fwd_eps":r2(ndx_feps),
 "spx_pe":spx_pe,"spx_fpe":spx_fpe,"ndx_pe":ndx_pe,"ndx_fpe":ndx_fpe,
 "pct":pct,
 "score":[round(score_map[d],1) if d in score_map else None for d in dates],
 "score_parts":{
   "rsi"  :[round(feat_map[d][0],1) if d in feat_map else None for d in dates],
   "ma50" :[round(feat_map[d][1],1) if d in feat_map else None for d in dates],
   "ret20":[round(feat_map[d][2],1) if d in feat_map else None for d in dates],
   "vix"  :[round(feat_map[d][3],1) if d in feat_map else None for d in dates]},
 "breadth":breadth,
 "breadth_ndx":breadth_ndx,
 "signal":sig_meta,
 "lows":lows_meta,
 "triggers":trig,
 "extrap_flags":{"spx_pe":spx_eps_x,"spx_fpe":spx_f_x,"ndx_pe":ndx_eps_x,"ndx_fpe":ndx_f_x},
 "coverage":{k:{"first":next((dates[i].isoformat() for i,v in enumerate(vv) if v is not None),None),
                "last": next((dates[i].isoformat() for i in range(len(vv)-1,-1,-1) if vv[i] is not None),None),
                "n":sum(1 for v in vv if v is not None)} for k,vv in series.items()},
 "sources":{
   "prices":"Yahoo Finance（yfinance），日频收盘价，抓取于 "+meta.get("fetched_at",""),
   "spx_eps":"multpl.com，标普500 名义滚动市盈率（月度，1871年起），反推出名义每股收益后使用",
   "spx_fwd":"FactSet Earnings Insight 周报 PDF，前瞻12个月市盈率，2017年起",
   "ndx":"Siblis Research 免费公开表，纳指100 季度 TTM/前瞻每股收益，2023-12-31 起"},
 "extrapolated_after":{"spx_fpe":SPX_F_LAST.isoformat() if fwd_pts else None,
                       "ndx_fpe":NDX_LAST.isoformat(),
                       "spx_pe": max(d for d,_ in spx_eps_pts).isoformat()},
 "factset_latest":{"date":None,"fwd_pe":None,"avg_5y":None,"avg_10y":None},
}
if os.path.exists(p):
    rows=list(csv.DictReader(open(p)))
    if rows:
        last=rows[-1]
        payload["factset_latest"]={"date":last["date"],"fwd_pe":float(last["fwd_pe_12m"]),
          "avg_5y":float(last["avg_5y"]) if last.get("avg_5y") else None,
          "avg_10y":float(last["avg_10y"]) if last.get("avg_10y") else None}

os.makedirs(SITE,exist_ok=True)
json.dump(payload, open(f"{SITE}/data.json","w"), separators=(",",":"), ensure_ascii=False)
print("dates",len(dates),dates[0],dates[-1])
for k,v in payload["coverage"].items(): print(" ",k,v)
print("size MB", round(os.path.getsize(f'{SITE}/data.json')/1e6,2))
print("factset_latest", payload["factset_latest"])
