# -*- coding: utf-8 -*-
"""估值序列的公共工具：稀疏锚点插值、末端外推裁剪、两种百分位。

本模块只用标准库，可被 build_dataset.py / build_valuation.py 共同 import。
其中 interp / clip_extrap / percentiles 是从 scripts/build_dataset.py 原样搬出来的
（分别对应改动前的第 31-43、96-105、129-142 行），行为保持一致，只是把原来依赖
全局变量 dates / MAX_EXTRAP_DAYS / MIN_OBS 的地方改成了显式参数。

range_percentile / fixed_window_percentile 是本轮新增的，用来复刻
「一座独立屋」估值平台的两套分位口径，差别见 README「两种百分位」一节。
"""
import bisect
import datetime

MAX_EXTRAP_DAYS = 120   # 最后一个锚点之后最多外推 120 个日历天，再远就置空
MIN_OBS = 500           # 滚动百分位至少要这么多个有效观测才出数


def interp(series, dates, extend=True):
    """把稀疏 (date,value) 线性插值到日频；区间外按最近端点延展（extend）或留空。"""
    if not series:
        return [None] * len(dates)
    xs = [s[0].toordinal() for s in series]
    ys = [s[1] for s in series]
    res = []
    for d in dates:
        x = d.toordinal()
        if x <= xs[0]:
            res.append(ys[0] if extend else None)
            continue
        if x >= xs[-1]:
            res.append(ys[-1] if extend else None)
            continue
        i = bisect.bisect_left(xs, x)
        x0, x1, y0, y1 = xs[i - 1], xs[i], ys[i - 1], ys[i]
        res.append(y0 + (y1 - y0) * (x - x0) / (x1 - x0))
    return res


def clip_extrap(vals, last_anchor, dates, max_days=MAX_EXTRAP_DAYS):
    """最后一个锚点之后的外推段：超过 max_days 置空，未超过的标记出来供前端画虚线。"""
    flag = [False] * len(dates)
    if last_anchor is None:
        return vals, flag
    for i, d in enumerate(dates):
        if vals[i] is None:
            continue
        if d > last_anchor:
            if (d - last_anchor).days > max_days:
                vals[i] = None
            else:
                flag[i] = True
    return vals, flag


def _rank_pct(sorted_vals, v):
    """v 在已排序序列中的「小于等于的比例」，并列取中点，避免总是 100%。"""
    lo = bisect.bisect_left(sorted_vals, v)
    hi = bisect.bisect_right(sorted_vals, v)
    return round(100.0 * ((lo + hi) / 2) / len(sorted_vals), 2)


def percentiles(vals, win, min_obs=MIN_OBS):
    """point-in-time 滚动百分位：每个非空点在过去 win 个有效观测（含自身）里的排名。

    不使用未来数据。win=None 表示用全部历史。
    """
    out = [None] * len(vals)
    hist = []
    for i, v in enumerate(vals):
        if v is None:
            continue
        hist.append(v)
        w = hist if win is None else hist[-win:]
        if len(w) < min_obs:
            continue
        out[i] = _rank_pct(sorted(w), v)
    return out


# ---------------------------------------------------------------------------
# 下面两个是本轮新增，对应「一座独立屋」平台的两套分位口径。
#
# 它那个平台同一天同一只股票会给出两个不同的分位数（NVDA 个股卡 3.7%、对比表 0.1%），
# 原因就是这两套口径混用且页面上没写清楚窗口。本项目两套都实现，但每个数字
# 必须带窗口标注，见 site/valuation.js 的 fmtPct()。
# ---------------------------------------------------------------------------

def range_percentile(vals, i0, i1, min_obs=30):
    """区间相对分位：只在切片 vals[i0:i1+1] 内部排名，算的是「最后一个有效值」的位置。

    这是平台上「百分位（当前区间）」的口径——它随 1Y/3Y/5Y/10Y/20Y/全部 的切换而变，
    是区间内的相对量，不是全历史绝对分位。

    负值（盈利为负导致的负市盈率）不参与排名，见模块文档。
    返回 (百分位, 参与排名的有效观测数)；样本不足 min_obs 时返回 (None, n)。
    """
    seg = [v for v in vals[i0:i1 + 1] if v is not None and v > 0]
    if not seg:
        return None, 0
    cur = seg[-1]
    if len(seg) < min_obs:
        return None, len(seg)
    return _rank_pct(sorted(seg), cur), len(seg)


def fixed_window_percentile(vals, dates, days=3650, asof=None, min_obs=250):
    """固定时间窗口分位：个股卡上「PE 分位 · 近十年」的口径（days=3650）。

    与 range_percentile 的差别是窗口按**日历天数**截取而不是按数组下标，
    所以标的上市时间不足时会自然退化成「可用年限内的分位」，此时 n 会明显偏小，
    调用方应据此在页面上写明实际年限，而不是仍然显示「近十年」。

    返回 (百分位, 有效观测数, 实际覆盖年数)。
    """
    if asof is None:
        asof = dates[-1]
    lo = asof - datetime.timedelta(days=days)
    seg = [v for d, v in zip(dates, vals)
           if v is not None and v > 0 and lo <= d <= asof]
    if not seg:
        return None, 0, 0.0
    first = next(d for d, v in zip(dates, vals)
                 if v is not None and v > 0 and lo <= d <= asof)
    years = round((asof - first).days / 365.25, 1)
    cur = seg[-1]
    if len(seg) < min_obs:
        return None, len(seg), years
    return _rank_pct(sorted(seg), cur), len(seg), years


def status_label(pct):
    """把分位翻成平台上那三个状态词。阈值取自截图：NVDA 3.7%=低估、MSFT 28.7%=合理。"""
    if pct is None:
        return "样本不足"
    if pct < 20:
        return "低估"
    if pct < 80:
        return "合理"
    return "高估"
