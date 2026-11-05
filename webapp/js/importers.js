/* 导入各种来源的 EQ：分享链接 / uuid / 社区 JSON / EqualizerAPO 文本 */

import { defaultBands, LIMITS, clamp, quantize, fitBands, response, makeGrid } from './eqmath.js';
import { rowsToBands, getProduct } from './community.js';

const API_BASE = 'https://cdn-service.moondroplab.tech/api/v1';
const CDN_BASE = 'https://cdn.moondroplab.tech';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;


function blank() {
  return defaultBands(LIMITS.bands);
}

/** 社区文件同构：数组 [{frequency,q,gain,filter}] */
function fromRows(rows) {
  return rowsToBands(rows);
}

/** 本站导出的 JSON：{bands:[...]} 或裸数组 */
function fromOwnJson(data) {
  if (Array.isArray(data) && data.length && data[0].bands === undefined && 'type' in data[0]) {
    return data.map((b) => quantize({ ...b })).slice(0, LIMITS.bands);
  }
  if (Array.isArray(data.bands)) {
    const out = data.bands.map((b) => quantize({ ...b })).slice(0, LIMITS.bands);
    const defs = defaultBands(LIMITS.bands);
    while (out.length < LIMITS.bands) out.push(quantize({ ...defs[out.length] }));
    return out;
  }
  return null;
}

/** EqualizerAPO / AutoEq 文本 */
export function parseApo(text) {
  const lines = text.split(/\r?\n/);
  const filters = [];
  let preamp = null;

  for (const raw of lines) {
    const line = raw.trim();
    const pm = line.match(/^Preamp\s*:\s*(-?[\d.]+)\s*dB/i);
    if (pm) { preamp = Number(pm[1]); continue; }

    const m = line.match(/^Filter\s*\d+\s*:\s*(ON|OFF)\s+([A-Za-z]+)\s+(.*)$/i);
    if (!m) continue;
    if (m[1].toUpperCase() === 'OFF') continue;

    const kind = m[2].toUpperCase();
    const rest = m[3];
    const freq = Number((rest.match(/Fc\s+(-?[\d.]+)\s*Hz/i) || [])[1]);
    const gain = Number((rest.match(/Gain\s+(-?[\d.]+)\s*dB/i) || [])[1]);
    const q = Number((rest.match(/\bQ\s+(-?[\d.]+)/i) || [])[1]);
    const bw = Number((rest.match(/\bBW\s+Oct\s+(-?[\d.]+)/i) || [])[1]);
    if (!Number.isFinite(freq) || !Number.isFinite(gain)) continue;

    let type = 'PK';
    if (kind === 'LS' || kind === 'LSC' || kind === 'LSH') type = 'LS';
    if (kind === 'HS' || kind === 'HSC' || kind === 'HSH') type = 'HS';
    else if (kind === 'PK') type = 'PK';

    // 只给了 BW 的先按 Q = 1/(2*sinh(ln2/2*BW)) 近似（架子段不换算）
    const qq = Number.isFinite(q) && q > 0
      ? q
      : (Number.isFinite(bw) && bw > 0 ? 1 / (2 * Math.sinh((Math.LN2 / 2) * bw)) : 1);

    filters.push({ type, freq, gain, q: qq });
  }

  return { filters, preamp };
}

/** 段数超过 5 时用曲线拟合，而不是粗暴丢掉几段 */
function fit(filters) {
  const grid = makeGrid(140);
  const target = response(filters, grid);
  const { bands, rmse } = fitBands(target, LIMITS.bands);
  return { bands, rmse };
}

function collate(filters) {
  const bands = blank();
  const kept = filters
    .filter((f) => Math.abs(f.gain) > 0.05 && f.freq >= LIMITS.freq[0] && f.freq <= LIMITS.freq[1])
    .sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain))
    .slice(0, LIMITS.bands)
    .sort((a, b) => a.freq - b.freq);

  kept.forEach((f, i) => {
    bands[i] = quantize({
      ...bands[i],
      type: f.type,
      freq: clamp(f.freq, LIMITS.freq[0], LIMITS.freq[1]),
      gain: clamp(f.gain, LIMITS.gain[0], LIMITS.gain[1]),
      q: clamp(f.q || 1, LIMITS.q[0], LIMITS.q[1]),
    });
  });
  return { bands, dropped: filters.length - kept.length };
}

async function fromUuid(uuid) {
  const res = await fetch(`${API_BASE}/peq-configs/${uuid}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`社区接口 ${res.status}`);
  const body = await res.json();
  if (body.code !== 0 || !body.data) throw new Error(body.message || '找不到这条调音');
  const preset = body.data;
  const file = await fetch(`${CDN_BASE}/${preset.file}`, { headers: { accept: 'text/plain' } });
  if (!file.ok) throw new Error(`预设文件 ${file.status}`);
  const rows = await file.json();
  const active = getProduct();
  const mismatch = preset.productUuid && active.uuid && preset.productUuid !== active.uuid;
  const noActive = !active.uuid;
  return {
    bands: fromRows(rows),
    title: preset.title || '未命名调音',
    author: preset.username || '',
    note: mismatch
      ? `注意：这条调音属于其它型号，直接套到 ${active.model} 上未必好听`
      : (noActive ? `当前机型没有官方社区档案，曲线会按 ${active.model} 的段数转换` : ''),
  };
}

/**
 * 自动识别粘贴内容。
 * @returns {Promise<{bands:object[], source:string, title?:string, author?:string, note?:string}>}
 */
export async function parseImport(text) {
  const raw = (text || '').trim();
  if (!raw) throw new Error('先粘贴点东西');

  // 1) JSON
  if (raw.startsWith('[') || raw.startsWith('{')) {
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('JSON 解析失败，检查有没有多复制或少复制括号'); }

    if (Array.isArray(data)) {
      if (!data.length) throw new Error('这个数组是空的');
      if ('freq' in data[0] && 'type' in data[0]) {
        return { bands: fromOwnJson(data), source: 'JSON（本站 bands）' };
      }
      return { bands: fromRows(data), source: 'JSON（社区格式）' };
    }
    const own = fromOwnJson(data);
    if (own) {
      const active = getProduct();
      const note = data.productUuid && active.uuid && data.productUuid !== active.uuid
        ? `这个文件来自 ${data.product || '其它机型'}，已按 ${active.model} 的段数转换`
        : '';
      return { bands: own, source: 'JSON（本站导出文件）', note };
    }
    throw new Error('这个 JSON 里没有 bands 或调音数组');
  }

  // 2) 分享链接 / uuid
  const uuid = raw.match(UUID_RE);
  if (uuid) {
    const got = await fromUuid(uuid[0]);
    return { ...got, source: '社区调音' };
  }

  // 3) EqualizerAPO / AutoEq 文本
  if (/Filter\s*\d+\s*:/i.test(raw)) {
    const { filters, preamp } = parseApo(raw);
    if (!filters.length) throw new Error('没解析出任何 Filter 行，看看是不是 AutoEq 的 ParametricEQ.txt');
    const notes = [];

    let bands;
    if (filters.length > LIMITS.bands) {
      const fitted = fit(filters);
      bands = fitted.bands;
      notes.push(`原文 ${filters.length} 段，用 5 段拟合（RMSE ${fitted.rmse} dB）`);
    } else {
      bands = collate(filters).bands;
    }
    if (Number.isFinite(preamp) && preamp < 0) notes.push(`原文 Preamp ${preamp} dB —— 竹二没有预增益，靠各段自己让`);
    return { bands, source: 'EqualizerAPO 文本', note: notes.join('；') };
  }

  throw new Error('认不出来：支持社区链接/uuid、社区 JSON、本站导出 JSON、AutoEq 文本');
}
