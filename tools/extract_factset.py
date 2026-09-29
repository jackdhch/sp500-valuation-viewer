"""从 FactSet Earnings Insight 周报 PDF 里读出标普500 前瞻 12 个月市盈率及其 5 年、10 年均值。

本机全量重建：python3 scripts/extract_factset.py（读 data/factset_pdf/ 下全部 PDF，重写 data/sp500_forward_pe_factset.csv）。
parse_pdf() 也给 scripts/update_factset.py 用（公开仓库每日任务每周增量追加新一期，2026-09-28 加）。
"""
import re,os,csv,subprocess,datetime,sys
ROOT=os.environ.get("SP500_ROOT") or "/home/d/260909_SP500"
D=os.environ.get("FACTSET_PDF") or f"{ROOT}/data/factset_pdf"

def parse_pdf(path):
    """返回 (前瞻PE, 5年均值, 10年均值)，读不出的是 None。只看前两页（结论都在第一页的 Key Metrics 里）。"""
    txt=subprocess.run(["pdftotext","-layout","-f","1","-l","2",path,"-"],
                       capture_output=True,text=True,timeout=60).stdout
    t=" ".join(txt.split())
    pe=None
    m=re.search(r"forward 12-month P/E ratio for the S&P 500 is (\d+\.\d+)",t) or \
      re.search(r"forward 12-month P/E ratio is (\d+\.\d+)",t)
    if m: pe=float(m.group(1))
    a5=a10=None
    m=re.search(r"(?<!1)0?5-year average (?:of )?\((\d+\.\d+)\)",t) or re.search(r"(?<!1)5-year average of (\d+\.\d+)",t)
    if m: a5=float(m.group(1))
    m=re.search(r"10-year average (?:of )?\((\d+\.\d+)\)",t) or re.search(r"10-year average of (\d+\.\d+)",t)
    if m: a10=float(m.group(1))
    return pe,a5,a10

if __name__ == "__main__":
    rows=[]
    files=sorted(os.listdir(D))
    for i,f in enumerate(files):
        if not f.endswith(".pdf"): continue
        mm,dd,yy=f[16:18],f[18:20],f[20:22]
        try: dt=datetime.date(2000+int(yy),int(mm),int(dd))
        except ValueError: continue
        try:
            pe,a5,a10=parse_pdf(os.path.join(D,f))
        except Exception as e:
            print("FAIL",f,e); continue
        if pe: rows.append((dt,pe,a5,a10))
        if i%50==0: print(i,len(files),f,pe,file=sys.stderr)
    rows.sort()
    out=f"{ROOT}/data/sp500_forward_pe_factset.csv"
    with open(out,"w",newline="") as fh:
        w=csv.writer(fh); w.writerow(["date","fwd_pe_12m","avg_5y","avg_10y"])
        for r in rows: w.writerow(r)
    print("rows",len(rows), rows[0] if rows else None, rows[-1] if rows else None)
