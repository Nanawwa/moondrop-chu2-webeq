/* EQ 数学：RBJ biquad 系数 + 幅频响应
   与设备端 libnative-peq.so 同一套公式（alpha = sin(w0)/(2Q)，
   架式滤波在 Q = 0.7071 时即 RBJ 的 S = 1），预览曲线和实际听到的一致。 */

export let FS = 48000; // 当前机型的采样率；SPV 家族是 96 kHz

export const BAND_DEFS = [
  { id: 0, type: 'LS', freq: 60, gain: 0, q: 0.7, name: '低频架' },
  { id: 1, type: 'PK', freq: 200, gain: 0, q: 1.0, name: '低中' },
  { id: 2, type: 'PK', freq: 1000, gain: 0, q: 1.0, name: '中频' },
  { id: 3, type: 'PK', freq: 3000, gain: 0, q: 1.0, name: '高中' },
  { id: 4, type: 'HS', freq: 8000, gain: 0, q: 0.7, name: '高频架' },
];

// 当前机型的能力范围。切换机型时用 setLimits() 原地改这三个数组，
// 所有模块（图表、量化、导入拟合）都读同一份，避免出现“UI 允许但协议截断”。
export const LIMITS = {
  gain: [-12, 12],
  q: [0.1, 10],
  freq: [20, 20000],
  bands: 5,
};

export function setLimits(profile = {}) {
  FS = profile.fs || 48000;
  if (profile.bands) LIMITS.bands = profile.bands;
  if (profile.gain) LIMITS.gain = [...profile.gain];
  if (profile.q) LIMITS.q = [...profile.q];
  if (profile.freq) LIMITS.freq = [...profile.freq];
}

/** 按当前范围生成 count 段默认曲线（首段 LS、末段 HS，中间 PK） */
export function defaultBands(count = LIMITS.bands) {
  if (count === BAND_DEFS.length) return BAND_DEFS.map((b) => ({ ...b }));
  const lo = Math.log(LIMITS.freq[0]);
  const hi = Math.log(LIMITS.freq[1]);
  return Array.from({ length: count }, (_, i) => {
    const freq = Math.round(Math.exp(lo + ((hi - lo) * i) / Math.max(1, count - 1)));
    const edge = i === 0 || i === count - 1;
    return {
      id: i,
      type: i === 0 ? 'LS' : i === count - 1 ? 'HS' : 'PK',
      freq,
      gain: 0,
      q: edge ? 0.7 : 1.0,
      name: '',
    };
  });
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round = (v, d) => {
  const p = 10 ** d;
  return Math.round(v * p) / p;
};

/** 设备按 0.1 dB / 0.001 Q / 1 Hz 存量化值 */
export const quantize = (b) => ({
  ...b,
  freq: clamp(Math.round(b.freq), LIMITS.freq[0], LIMITS.freq[1]),
  gain: round(clamp(b.gain, LIMITS.gain[0], LIMITS.gain[1]), 1),
  q: round(clamp(b.q, LIMITS.q[0], LIMITS.q[1]), 3),
});

export function coeffs(type, freq, gainDb, q) {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * clamp(freq, 10, FS / 2 - 100)) / FS;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Math.max(q, 0.0001));
  const tsa = 2 * Math.sqrt(A) * alpha;
  let b0, b1, b2, a0, a1, a2;

  if (type === 'LS') {
    b0 = A * (A + 1 - (A - 1) * cos + tsa);
    b1 = 2 * A * (A - 1 - (A + 1) * cos);
    b2 = A * (A + 1 - (A - 1) * cos - tsa);
    a0 = A + 1 + (A - 1) * cos + tsa;
    a1 = -2 * (A - 1 + (A + 1) * cos);
    a2 = A + 1 + (A - 1) * cos - tsa;
  } else if (type === 'HS') {
    b0 = A * (A + 1 + (A - 1) * cos + tsa);
    b1 = -2 * A * (A - 1 + (A + 1) * cos);
    b2 = A * (A + 1 + (A - 1) * cos - tsa);
    a0 = A + 1 - (A - 1) * cos + tsa;
    a1 = 2 * (A - 1 - (A + 1) * cos);
    a2 = A + 1 - (A - 1) * cos - tsa;
  } else {
    b0 = 1 + alpha * A;
    b1 = -2 * cos;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cos;
    a2 = 1 - alpha / A;
  }

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** 单个 biquad 在 freq 处的幅度（dB） */
export function magnitudeDb(c, freq) {
  const w = (2 * Math.PI * freq) / FS;
  const cw = Math.cos(w), sw = Math.sin(w);
  const cw2 = Math.cos(2 * w), sw2 = Math.sin(2 * w);
  const numRe = c.b0 + c.b1 * cw + c.b2 * cw2;
  const numIm = -(c.b1 * sw + c.b2 * sw2);
  const denRe = 1 + c.a1 * cw + c.a2 * cw2;
  const denIm = -(c.a1 * sw + c.a2 * sw2);
  const num = Math.hypot(numRe, numIm);
  const den = Math.hypot(denRe, denIm);
  return 20 * Math.log10(Math.max(num / Math.max(den, 1e-12), 1e-9));
}

/** 对数频响网格 */
export function makeGrid(points = 320) {
  const lo = Math.log10(LIMITS.freq[0]);
  const hi = Math.log10(LIMITS.freq[1]);
  const out = new Float64Array(points);
  for (let i = 0; i < points; i++) out[i] = 10 ** (lo + ((hi - lo) * i) / (points - 1));
  return out;
}

/** 合成曲线 */
export function response(bands, grid) {
  const cs = bands
    .filter((b) => b && Math.abs(b.gain) > 1e-4)
    .map((b) => coeffs(b.type, b.freq, b.gain, b.q));
  const out = new Float64Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    let sum = 0;
    for (const c of cs) sum += magnitudeDb(c, grid[i]);
    out[i] = sum;
  }
  return out;
}

/** 峰值提升量（dB） */
export function peakBoost(bands) {
  const curve = response(bands, makeGrid(800));
  let max = 0;
  for (let i = 0; i < curve.length; i++) if (curve[i] > max) max = curve[i];
  return round(max, 1);
}

/** 整体下移，让峰值落在 target 上（设备没有预增益，只能让步） */
export function applyHeadroom(bands, target = -0.5) {
  const peak = peakBoost(bands);
  if (peak <= 0.05) return bands.map((b) => ({ ...b }));
  const drop = round(peak - target, 1);
  return bands.map((b) => quantize({ ...b, gain: b.gain - drop }));
}

/* ---------------- 把任意条曲线拟合成 5 段 PEQ ---------------- */

const FIT_GRID = makeGrid(140);

/** 单段在网格上的响应 */
function oneBand(b) {
  return response([b], FIT_GRID);
}

function rmse(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / a.length);
}

/**
 * 用 count 段 PK 去拟合目标曲线（dB 数组，长度同 FIT_GRID）。
 * 先按残差峰值贪心取种子，再做坐标下降微调。
 */
export function fitBands(targetDb, count = LIMITS.bands) {
  const target = Float64Array.from(targetDb);
  const model = new Float64Array(FIT_GRID.length);
  const bands = [];

  // 1) 贪心种子
  for (let k = 0; k < count; k++) {
    let best = 0;
    let bestVal = 0;
    for (let i = 0; i < target.length; i++) {
      const r = target[i] - model[i];
      if (Math.abs(r) > Math.abs(bestVal)) { bestVal = r; best = i; }
    }
    const seed = {
      type: 'PK',
      freq: FIT_GRID[best],
      gain: round(clamp(bestVal, LIMITS.gain[0], LIMITS.gain[1]), 1),
      q: 1,
    };
    bands.push(seed);
    const r = oneBand(seed);
    for (let i = 0; i < model.length; i++) model[i] += r[i];
  }

  // 2) 坐标下降：逐段逐参数扫，保留让整体 RMSE 变小的值
  const score = () => rmse(model, target);
  let bestScore = score();

  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (let bi = 0; bi < bands.length; bi++) {
      const b = bands[bi];
      const cur = oneBand(b);
      const others = new Float64Array(model.length);
      for (let i = 0; i < model.length; i++) others[i] = model[i] - cur[i];

      const tryBand = (cand) => {
        const q = quantize({ ...cand });
        const r = oneBand(q);
        const m = new Float64Array(others.length);
        for (let i = 0; i < m.length; i++) m[i] = others[i] + r[i];
        const s = rmse(m, target);
        if (s < bestScore - 1e-4) {
          bestScore = s;
          bands[bi] = q;
          for (let i = 0; i < model.length; i++) model[i] = m[i];
          improved = true;
          return true;
        }
        return false;
      };

      // 增益：±(1,2,4,8) dB 台阶
      for (const d of [1, -1, 2, -2, 4, -4, 8, -8, 0.5, -0.5]) {
        tryBand({ ...b, gain: clamp(b.gain + d, LIMITS.gain[0], LIMITS.gain[1]) });
      }
      // 频率：×/÷ 1.08 / 1.2 / 1.5
      for (const f of [1.08, 1 / 1.08, 1.2, 1 / 1.2, 1.5, 1 / 1.5]) {
        tryBand({ ...b, freq: clamp(b.freq * f, LIMITS.freq[0], LIMITS.freq[1]) });
      }
      // Q：×/÷ 1.15 / 1.4 / 2
      for (const f of [1.15, 1 / 1.15, 1.4, 1 / 1.4, 2, 0.5]) {
        tryBand({ ...b, q: clamp(b.q * f, LIMITS.q[0], LIMITS.q[1]) });
      }
    }
    if (!improved) break;
  }

  // 3) 两端的段允许换成架子型（芯片支持 LS/HS，拟合 10k 以上更准）
  const tryType = (bi, type) => {
    const b = bands[bi];
    const cur = oneBand(b);
    const others = new Float64Array(model.length);
    for (let i = 0; i < model.length; i++) others[i] = model[i] - cur[i];
    const cand = quantize({ ...b, type });
    const r = oneBand(cand);
    const m = new Float64Array(others.length);
    for (let i = 0; i < m.length; i++) m[i] = others[i] + r[i];
    const sc = rmse(m, target);
    if (sc < bestScore - 1e-4) {
      bestScore = sc;
      bands[bi] = cand;
      for (let i = 0; i < model.length; i++) model[i] = m[i];
    }
  };
  const byFreq = bands.map((b, i) => [b.freq, i]).sort((x, y) => x[0] - y[0]);
  const lowIdx = byFreq[0][1];
  const highIdx = byFreq[byFreq.length - 1][1];
  tryType(lowIdx, 'LS');
  tryType(highIdx, 'HS');

  const sorted = bands.slice().sort((a, b) => a.freq - b.freq);
  return { bands: sorted.map((b) => quantize(b)), rmse: round(bestScore, 2), grid: FIT_GRID };
}

export { FIT_GRID };
