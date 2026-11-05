/* 频响图：浅色纸面上的朱红曲线，节点可拖拽
   颜色全部从 CSS 变量读取，跟随系统明暗主题。 */

import { LIMITS, clamp, response, makeGrid } from './eqmath.js';

const GRID_FREQS = [20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000];
const LABELS = { 20: '20', 30: '30', 50: '50', 100: '100', 200: '200', 500: '500', 1000: '1k', 2000: '2k', 5000: '5k', 10000: '10k', 20000: '20k' };
const PAD = { l: 42, r: 16, t: 16, b: 26 };

const nodeFreqText = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)}k` : `${Math.round(f)}Hz`);

export class EqChart {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts; // { getBands, onChange }
    this.active = null;
    this.hover = null;
    this.dpr = 1;
    this.w = 0;
    this.h = 0;
    this.plot = { x: 0, y: 0, w: 0, h: 0 };
    this.bind();
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.plot = {
      x: PAD.l,
      y: PAD.t,
      w: Math.max(1, this.w - PAD.l - PAD.r),
      h: Math.max(1, this.h - PAD.t - PAD.b),
    };
    this.draw();
  }

  /* ---------- 坐标 ---------- */

  xOf(freq) {
    const lo = Math.log10(LIMITS.freq[0]);
    const hi = Math.log10(LIMITS.freq[1]);
    const t = (Math.log10(clamp(freq, LIMITS.freq[0], LIMITS.freq[1])) - lo) / (hi - lo);
    return this.plot.x + t * this.plot.w;
  }

  freqOf(x) {
    const lo = Math.log10(LIMITS.freq[0]);
    const hi = Math.log10(LIMITS.freq[1]);
    const t = clamp((x - this.plot.x) / this.plot.w, 0, 1);
    return 10 ** (lo + t * (hi - lo));
  }

  yBounds() {
    const [lo, hi] = LIMITS.gain;
    return { lo: lo - 1, hi: hi + 1 };
  }

  yOf(db) {
    const { lo, hi } = this.yBounds();
    const t = (db - lo) / (hi - lo);
    return this.plot.y + this.plot.h * (1 - t);
  }

  dbOf(y) {
    const { lo, hi } = this.yBounds();
    const t = 1 - (y - this.plot.y) / this.plot.h;
    return clamp(lo + t * (hi - lo), LIMITS.gain[0], LIMITS.gain[1]);
  }

  nodePos(b) {
    return { x: this.xOf(b.freq), y: this.yOf(b.gain) };
  }

  /* ---------- 交互 ---------- */

  bind() {
    const c = this.canvas;

    c.addEventListener('pointerdown', (e) => {
      const p = this.localPoint(e);
      const hit = this.hitTest(p);
      if (hit === null) return;
      this.active = hit;
      c.setPointerCapture(e.pointerId);
      e.preventDefault();
      this.draw();
    });

    c.addEventListener('pointermove', (e) => {
      const p = this.localPoint(e);
      if (this.active !== null) {
        const freq = Math.round(this.freqOf(p.x));
        const gain = Math.round(this.dbOf(p.y) * 10) / 10;
        this.opts.onChange(this.active, { freq: clamp(freq, LIMITS.freq[0], LIMITS.freq[1]), gain: clamp(gain, LIMITS.gain[0], LIMITS.gain[1]) });
        this.draw();
        return;
      }
      const hit = this.hitTest(p);
      if (hit !== this.hover) this.hover = hit;
      c.style.cursor = hit === null ? 'crosshair' : 'grab';
      this.draw();
    });

    c.addEventListener('pointerup', (e) => {
      if (this.active === null) return;
      this.active = null;
      try { c.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      this.draw();
    });

    c.addEventListener('pointercancel', () => {
      this.active = null;
      this.draw();
    });

    c.addEventListener('wheel', (e) => {
      const p = this.localPoint(e);
      const hit = this.hitTest(p);
      if (hit === null) return;
      e.preventDefault();
      const b = this.opts.getBands()[hit];
      if (!b) return;
      const factor = e.deltaY > 0 ? 1 / 1.12 : 1.12;
      const q = Math.round(clamp(b.q * factor, LIMITS.q[0], LIMITS.q[1]) * 100) / 100;
      this.opts.onChange(hit, { q });
    }, { passive: false });

    c.addEventListener('pointerleave', () => {
      if (this.active === null && this.hover !== null) {
        this.hover = null;
        this.draw();
      }
    });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(c);
  }

  localPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  hitTest(p) {
    const bands = this.opts.getBands();
    let best = null;
    let bestD = 22;
    bands.forEach((b, i) => {
      const n = this.nodePos(b);
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  /* ---------- 主题 ---------- */

  theme() {
    const cs = getComputedStyle(this.canvas);
    const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
    return {
      grid: v('--plot-grid', '#e7e2db'),
      gridStrong: v('--plot-grid-strong', '#d9d2ca'),
      label: v('--plot-label', '#9a928a'),
      zero: v('--plot-zero', '#c9c1b8'),
      fill: v('--plot-fill', 'rgba(217,83,59,.1)'),
      line: v('--plot-line', '#d9533b'),
      pointBg: v('--plot-point-bg', '#fff'),
      pointFg: v('--plot-point-fg', '#d9533b'),
      pointActive: v('--plot-point-active', '#d9533b'),
      pointActiveFg: v('--plot-point-active-fg', '#fff'),
      tipBg: v('--plot-tooltip-bg', '#1a1917'),
      tipFg: v('--plot-tooltip-fg', '#faf9f7'),
      halo: v('--plot-halo', 'rgba(217,83,59,.16)'),
    };
  }

  /* ---------- 绘制 ---------- */

  draw() {
    const { ctx } = this;
    const { x, y, w, h } = this.plot;
    if (!w || !h) return;
    const th = this.theme();
    ctx.clearRect(0, 0, this.w, this.h);

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (const f of GRID_FREQS) {
      const gx = Math.round(this.xOf(f)) + 0.5;
      ctx.strokeStyle = LABELS[f] ? th.gridStrong : th.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(gx, y);
      ctx.lineTo(gx, y + h);
      ctx.stroke();
      if (LABELS[f]) {
        ctx.fillStyle = th.label;
        ctx.fillText(LABELS[f], gx, y + h + 7);
      }
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const { lo: yLo, hi: yHi } = this.yBounds();
    for (let db = Math.ceil(yLo / 3) * 3; db <= yHi; db += 3) {
      if (db === 0) continue;
      const gy = Math.round(this.yOf(db)) + 0.5;
      ctx.strokeStyle = th.grid;
      ctx.beginPath();
      ctx.moveTo(x, gy);
      ctx.lineTo(x + w, gy);
      ctx.stroke();
      ctx.fillStyle = th.label;
      ctx.fillText(db > 0 ? `+${db}` : `${db}`, x - 9, gy);
    }

    const zero = Math.round(this.yOf(0)) + 0.5;
    ctx.strokeStyle = th.zero;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, zero);
    ctx.lineTo(x + w, zero);
    ctx.stroke();
    ctx.setLineDash([]);

    const bands = this.opts.getBands();
    const grid = makeGrid(360);
    const curve = response(bands, grid);
    const pts = [];
    for (let i = 0; i < grid.length; i++) pts.push([this.xOf(grid[i]), this.yOf(clamp(curve[i], yLo, yHi))]);

    ctx.beginPath();
    ctx.moveTo(pts[0][0], zero);
    for (const [px, py] of pts) ctx.lineTo(px, py);
    ctx.lineTo(pts[pts.length - 1][0], zero);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, th.fill);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.strokeStyle = th.line;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    bands.forEach((b, i) => {
      const n = this.nodePos(b);
      const on = this.active === i || this.hover === i;

      if (on) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 13, 0, Math.PI * 2);
        ctx.fillStyle = th.halo;
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, on ? 8.5 : 7, 0, Math.PI * 2);
      ctx.fillStyle = on ? th.pointActive : th.pointBg;
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = th.pointActive;
      ctx.stroke();

      ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = on ? th.pointActiveFg : th.pointFg;
      ctx.fillText(String(i + 1), n.x, n.y + 0.5);
    });

    const shown = this.active !== null ? this.active : this.hover;
    if (shown !== null && bands[shown]) this.tooltip(bands[shown], shown, th);
  }

  tooltip(b, i, th) {
    const { ctx } = this;
    const { x, y, w, h } = this.plot;
    const n = this.nodePos(b);
    const text = `#${i + 1}  ${nodeFreqText(b.freq)}  ${b.gain > 0 ? '+' : ''}${b.gain.toFixed(1)} dB  Q ${b.q.toFixed(2)}`;
    ctx.font = '10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    const tw = ctx.measureText(text).width;
    const bw = tw + 16;
    const bh = 22;
    const bx = clamp(n.x - bw / 2, x, x + w - bw);
    const by = clamp(n.y - 18 - bh, y, y + h - bh);

    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 6);
    else ctx.rect(bx, by, bw, bh);
    ctx.fillStyle = th.tipBg;
    ctx.fill();

    ctx.fillStyle = th.tipFg;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 8, by + bh / 2 + 0.5);
  }
}
