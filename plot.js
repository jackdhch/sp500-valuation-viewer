/* 估值面板的画图引擎。
 *
 * 这个 Plot 类是从 site/template.html 第 431-661 行**原样复制**过来的（生成 index.html 的
 * 那个模板）。之所以复制而不是抽取共用，是为了不动 template.html —— 它由
 * scripts/render_site.py 内联生成 site/index.html，改动它会牵连那个已经在用的页面。
 * 两边将来若要同步改，记得一起改。
 *
 * 相对原版只做了两处必要改动，都是为了让它能画在暗色新页签里：
 *   1. cssv() 原本固定从 document.documentElement 读 CSS 变量，现在改成从 VPlot.root 读，
 *      因为估值面板的暗色变量定义在 #view-val 这个容器上，不在 :root（避免污染亮色的信号页）。
 *   2. state 原本是模板里的全局量，现在收进本模块并由 VPlot.state 暴露，供 valuation.js 设置
 *      可视区间 r0/r1。
 */
window.VPlot = (function () {
"use strict";

// 从当前主题容器读 CSS 变量；VPlot.root 由 valuation.js 指到 #view-val
const cssv = n => getComputedStyle(API.root || document.documentElement)
                    .getPropertyValue(n).trim();

// 可视区间与十字准星位置，由 valuation.js 在切换标的/区间时改写
let state = { r0: 0, r1: 0, win: "10y", cur: 0, pinned: false };

// 日期字符串数组，render() 画 X 轴刻度要用。原版模板里它是全局的 const D = DATA.dates，
// 这里因为要在不同标的之间切换（每只股票的交易日轴长度不同），改成由 setDates() 注入。
let D = [];

// 双层 canvas：底层画数据，上层只画十字准线，移动时不用重绘上万个点。
class Plot {
  constructor(el, opts) {
    this.el = el; this.o = opts;
    this.base = document.createElement("canvas");
    this.over = document.createElement("canvas");
    el.append(this.base, this.over);
    el.style.height = (opts.height || 190) + "px";
    this.pad = { l: 56, r: 12, t: 10, b: 22 };
  }
  size() {
    const r = this.el.getBoundingClientRect();
    this.w = Math.max(120, r.width); this.h = Math.max(80, r.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [this.base, this.over]) {
      c.width = Math.round(this.w * dpr); c.height = Math.round(this.h * dpr);
      c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }
  // 屏幕 x ↔ 数据索引
  xOf(i) {
    const { l, r } = this.pad, span = Math.max(1, state.r1 - state.r0);
    return l + (this.w - l - r) * (i - state.r0) / span;
  }
  iOf(px) {
    const { l, r } = this.pad, span = Math.max(1, state.r1 - state.r0);
    const t = (px - l) / Math.max(1, this.w - l - r);
    return Math.max(state.r0, Math.min(state.r1, Math.round(state.r0 + t * span)));
  }
  yOf(v) {
    const { t, b } = this.pad;
    let f;
    if (this.o.log) {
      const L = Math.log10;
      f = (L(Math.max(v, 1e-6)) - L(this.lo)) / Math.max(1e-9, L(this.hi) - L(this.lo));
    } else {
      f = (v - this.lo) / Math.max(1e-9, this.hi - this.lo);
    }
    return t + (this.h - t - b) * (1 - f);
  }
  domain() {
    if (this.o.fixed) { [this.lo, this.hi] = this.o.fixed; return; }
    let lo = Infinity, hi = -Infinity;
    for (const s of this.o.series)
      for (let i = state.r0; i <= state.r1; i++) {
        const v = s.data[i];
        if (v == null) continue;
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (this.o.log) { this.lo = Math.max(0.1, lo * .92); this.hi = hi * 1.08; return; }
    const p = (hi - lo) * .10 || Math.abs(hi) * .05 || 1;
    this.lo = lo - p; this.hi = hi + p;
  }
  ticks() {
    if (this.o.log) {
      const out = [];
      for (let k = -2; k <= 6; k++)
        for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8]) {
          const v = m * Math.pow(10, k);
          if (v >= this.lo && v <= this.hi) out.push(v);
        }
      return out.length > 1 ? out : [this.lo, this.hi];
    }
    const target = Math.max(2, Math.floor((this.h - this.pad.t - this.pad.b) / 44));
    const raw = (this.hi - this.lo) / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(this.lo / step) * step; v <= this.hi; v += step) out.push(v);
    return out;
  }
  // min/max 降采样：每个像素列保留极值，保住形状又不画上万段
  path(ctx, data, extrap, wantExtrap) {
    const { l, r } = this.pad, cols = Math.max(1, Math.round(this.w - l - r));
    const span = state.r1 - state.r0 + 1, per = span / cols;
    ctx.beginPath();
    let started = false;
    const put = (x, y) => { started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true); };
    if (per <= 1.5) {
      for (let i = state.r0; i <= state.r1; i++) {
        const v = data[i];
        if (v == null || (!!extrap?.[i] !== wantExtrap)) { started = false; continue; }
        put(this.xOf(i), this.yOf(v));
      }
    } else {
      for (let c = 0; c < cols; c++) {
        const a = state.r0 + Math.floor(c * per), b = Math.min(state.r1, state.r0 + Math.floor((c + 1) * per) - 1);
        let mn = Infinity, mx = -Infinity, ok = false;
        for (let i = a; i <= b; i++) {
          const v = data[i];
          if (v == null || (!!extrap?.[i] !== wantExtrap)) continue;
          ok = true; if (v < mn) mn = v; if (v > mx) mx = v;
        }
        if (!ok) { started = false; continue; }
        const x = this.xOf(a);
        put(x, this.yOf(mn)); ctx.lineTo(x, this.yOf(mx));
      }
    }
    ctx.stroke();
  }
  render() {
    this.size(); this.domain();
    const g = this.base.getContext("2d");
    g.clearRect(0, 0, this.w, this.h);
    const { l, r, t, b } = this.pad;
    const ink3 = cssv("--ink-3"), grid = cssv("--grid");

    // 参考带（百分位图的 30/70/90）
    if (this.o.bands) {
      for (const bd of this.o.bands) {
        g.fillStyle = cssv(bd.color) + bd.alpha;
        g.fillRect(l, this.yOf(bd.hi), this.w - l - r, this.yOf(bd.lo) - this.yOf(bd.hi));
      }
    }
    // 水平网格 + y 轴标签
    g.font = '11px "IBM Plex Mono", monospace'; g.textAlign = "right"; g.textBaseline = "middle";
    for (const v of this.ticks()) {
      const y = Math.round(this.yOf(v)) + .5;
      if (y < t - 1 || y > this.h - b + 1) continue;
      g.strokeStyle = grid; g.lineWidth = 1;
      g.beginPath(); g.moveTo(l, y); g.lineTo(this.w - r, y); g.stroke();
      g.fillStyle = ink3; g.fillText(this.o.yfmt(v), l - 8, y);
    }
    // 参考线（如 FactSet 的 5年 / 10年均值）
    for (const rl of (this.o.rules || [])) {
      const y = Math.round(this.yOf(rl.v)) + .5;
      if (y < t || y > this.h - b) continue;
      const rc = cssv(rl.color) || rl.color;
      g.save(); g.setLineDash([3, 3]); g.strokeStyle = rc; g.lineWidth = 1;
      g.beginPath(); g.moveTo(l, y); g.lineTo(this.w - r, y); g.stroke(); g.restore();
      g.fillStyle = rc; g.textAlign = "left"; g.font = '10.5px "IBM Plex Mono", monospace';
      g.fillText(rl.label, l + 5, y - 7); g.textAlign = "right"; g.font = '11px "IBM Plex Mono", monospace';
    }
    // x 轴日期
    g.fillStyle = ink3; g.textBaseline = "top"; g.textAlign = "center";
    const nx = Math.max(2, Math.floor((this.w - l - r) / 92));
    for (let k = 0; k <= nx; k++) {
      const i = Math.round(state.r0 + (state.r1 - state.r0) * k / nx);
      const x = this.xOf(i);
      const lbl = (state.r1 - state.r0) > 400 ? D[i].slice(0, 7) : D[i].slice(5);
      g.fillText(lbl, Math.min(this.w - r - 16, Math.max(l + 16, x)), this.h - b + 5);
    }
    // 轴线
    g.strokeStyle = cssv("--line-strong"); g.lineWidth = 1;
    g.beginPath(); g.moveTo(l, this.h - b + .5); g.lineTo(this.w - r, this.h - b + .5); g.stroke();

    // 操作者标注的低点：竖线
    if (this.o.vmarks) {
      const vis = this.o.vmarks.map(ds => ({ ds, i: D.indexOf(ds) }))
        .filter(o => o.i >= state.r0 && o.i <= state.r1).sort((a, c) => a.i - c.i);
      g.font = '10px "IBM Plex Mono", monospace'; g.textAlign = "center"; g.textBaseline = "bottom";
      const showLabels = (state.r1 - state.r0) <= 1500;   // 区间太长时标签会挤成一团
      vis.forEach((o, k) => {
        const x = Math.round(this.xOf(o.i)) + .5;
        g.save(); g.setLineDash([2, 3]); g.strokeStyle = cssv("--ink-3"); g.lineWidth = 1;
        g.beginPath(); g.moveTo(x, t); g.lineTo(x, this.h - b); g.stroke(); g.restore();
        if (!showLabels) return;
        // 相邻标签交替两行，避免挤在一起
        const ly = this.h - b - 2 - (k % 2) * 12;
        const lbl = o.ds.slice(2);
        const w = g.measureText(lbl).width + 6;
        g.fillStyle = cssv("--surface"); g.fillRect(x - w / 2, ly - 10, w, 11);
        g.fillStyle = cssv("--ink-3"); g.fillText(lbl, x, ly);
      });
      g.textAlign = "right"; g.textBaseline = "middle"; g.font = '11px "IBM Plex Mono", monospace';
    }

    // 数据线：实测段实线，外推段虚线
    g.lineJoin = "round"; g.lineCap = "round";
    for (const s of this.o.series) {
      g.save();
      if (s.alpha != null) g.globalAlpha = s.alpha;
      g.strokeStyle = cssv(s.color); g.lineWidth = s.width || 2;
      g.setLineDash([]); this.path(g, s.data, s.extrap, false);
      if (s.extrap) { g.setLineDash([4, 3]); this.path(g, s.data, s.extrap, true); g.setLineDash([]); }
      g.restore();
    }
    // 触发点强调（抄底分图专用）
    if (this.o.highlightAbove != null) {
      const dat = this.o.series[0].data, lim = this.o.highlightAbove;
      g.fillStyle = cssv("--good");
      for (let i = state.r0; i <= state.r1; i++) {
        const v = dat[i]; if (v == null || v < lim) continue;
        g.beginPath(); g.arc(this.xOf(i), this.yOf(v), 1.9, 0, 7); g.fill();
      }
    }
    // 散点标记（局部低点校准图）
    for (const pt of (this.o.points || [])) {
      if (pt.i < state.r0 || pt.i > state.r1) continue;
      const v = this.o.series[0].data[pt.i]; if (v == null) continue;
      const x = this.xOf(pt.i), y = this.yOf(v);
      g.save();
      if (pt.kind === "mark") {                    // 操作者标注：菱形
        g.translate(x, y); g.rotate(Math.PI / 4);
        g.fillStyle = cssv("--surface"); g.fillRect(-4.6, -4.6, 9.2, 9.2);
        g.fillStyle = cssv("--ndx"); g.fillRect(-3.3, -3.3, 6.6, 6.6);
      } else {                                     // 规则识别：圆点
        g.fillStyle = cssv("--surface"); g.beginPath(); g.arc(x, y, 4.2, 0, 7); g.fill();
        g.fillStyle = cssv("--good"); g.beginPath(); g.arc(x, y, 2.7, 0, 7); g.fill();
      }
      g.restore();
    }
    // 末端强调点
    for (const s of this.o.series) {
      let i = state.r1; while (i >= state.r0 && s.data[i] == null) i--;
      if (i < state.r0) continue;
      const x = this.xOf(i), y = this.yOf(s.data[i]);
      g.fillStyle = cssv("--surface"); g.beginPath(); g.arc(x, y, 4.5, 0, 7); g.fill();
      g.fillStyle = cssv(s.color); g.beginPath(); g.arc(x, y, 2.8, 0, 7); g.fill();
    }
    this.cursor();
  }
  cursor() {
    const g = this.over.getContext("2d");
    g.clearRect(0, 0, this.w, this.h);
    const i = state.cur;
    if (i < state.r0 || i > state.r1) return;
    const x = Math.round(this.xOf(i)) + .5, { t, b } = this.pad;
    g.strokeStyle = cssv("--cursor"); g.lineWidth = 1; g.setLineDash([2, 2]);
    g.beginPath(); g.moveTo(x, t); g.lineTo(x, this.h - b); g.stroke(); g.setLineDash([]);
    for (const s of this.o.series) {
      const v = s.data[i]; if (v == null) continue;
      const y = this.yOf(v);
      g.fillStyle = cssv("--surface"); g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill();
      g.strokeStyle = cssv(s.color); g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 3.4, 0, 7); g.stroke();
    }
  }
}


const API = { Plot, cssv, state, root: null,
              setDates(arr) { D = arr || []; },
              setRange(r0, r1) { state.r0 = r0; state.r1 = r1; state.cur = r1; } };
return API;
})();
