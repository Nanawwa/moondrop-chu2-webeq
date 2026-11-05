/* 水月雨官方调音社区接口（公开 GET，CORS 允许任意来源）
 *
 * 列表：GET {API}/peq-configs/all?productUuid=&pageIndex=&pageSize=&title=&type=
 * 单条：GET {API}/peq-configs/{uuid}
 * 文件：GET {CDN}/{file}  →  [{"id":"1","frequency":"83","q":"0.3","gain":"-3.4","filter":"0"}, …]
 *
 * 竹二 DSP(CHU2 DSP) 的 productUuid 取自官方 /products/all 目录。
 *
 * 关于"热度"：社区列表的 score / like / dislike 字段目前全是 0（服务端没在算），
 * 唯一有意义的排序键是 downloadcount。所以榜单只按下载量排，不编造热度分。
 */

import { defaultBands, LIMITS, clamp, quantize } from './eqmath.js';

const API = 'https://cdn-service.moondroplab.tech/api/v1';
const CDN = 'https://cdn.moondroplab.tech';
const CACHE_KEY = 'chu2.webeq.rank.v3';
const CACHE_TTL = 12 * 3600 * 1000;

export const PRODUCT = {
  model: 'CHU2 DSP',
  uuid: '6772a0d5-3f1c-4567-967a-210e61be2308',
};

// 当前机型；setProduct 由 app.js 在切换档案时调用。没有 productUuid 的机型
// （Kiwi / TANCHJIM / JCally / 通用）在社区里没有官方预设。
let activeProduct = { model: PRODUCT.model, uuid: PRODUCT.uuid };

export function setProduct(profile) {
  activeProduct = {
    model: profile?.communityName || profile?.label || PRODUCT.model,
    uuid: profile?.productUuid || '',
  };
  return activeProduct;
}

export function getProduct() {
  return activeProduct;
}

function cacheKey(uuid) {
  return `${CACHE_KEY}:${uuid || 'none'}`;
}

// 社区文件里的 filter 字段：0 = PK；1/2 保留给架式（当前社区数据几乎都是 0）
const FILTER_MAP = { 0: 'PK', 1: 'LS', 2: 'HS' };

export async function listPresets({
  productUuid = activeProduct.uuid,
  pageIndex = 1,
  pageSize = 30,
  title = '',
  type = '',
} = {}) {
  if (!productUuid) throw new Error('当前机型没有官方社区预设');
  const qs = new URLSearchParams({
    productUuid,
    pageIndex: String(pageIndex),
    pageSize: String(pageSize),
  });
  if (title.trim()) qs.set('title', title.trim());
  if (type) qs.set('type', type);

  const res = await fetch(`${API}/peq-configs/all?${qs}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`社区接口 ${res.status}`);
  const body = await res.json();
  if (body.code !== 0) throw new Error(body.message || '社区接口返回异常');
  const data = body.data || {};
  return { list: data.list || [], total: Number(data.total || 0) };
}

/** 抓整份清单（给排序/筛选用），带进度回调 */
export async function loadAllPresets({ productUuid = activeProduct.uuid, onProgress, pageSize = 200, concurrency = 5, maxPages = 40 } = {}) {
  const first = await listPresets({ productUuid, pageIndex: 1, pageSize });
  const total = first.total || first.list.length;
  const pages = Math.max(1, Math.min(maxPages, Math.ceil(total / pageSize)));
  const out = [...first.list];
  let done = 1;
  onProgress?.({ done, pages, count: out.length, total });

  const queue = [];
  for (let p = 2; p <= pages; p++) queue.push(p);

  async function worker() {
    for (;;) {
      const p = queue.shift();
      if (p === undefined) return;
      try {
        const r = await listPresets({ productUuid, pageIndex: p, pageSize });
        if (r.list.length) out.push(...r.list);
      } catch {
        /* 单页失败跳过，别让整份榜单失败 */
      }
      done += 1;
      onProgress?.({ done, pages, count: out.length, total });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pages) }, worker));
  return { list: out, total };
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function sortPresets(list, key) {
  const arr = [...list];
  if (key === 'downloads') {
    arr.sort((a, b) => num(b.downloadcount) - num(a.downloadcount) || num(b.like) - num(a.like));
  } else if (key === 'downloads-asc') {
    arr.sort((a, b) => num(a.downloadcount) - num(b.downloadcount));
  } else if (key === 'likes') {
    arr.sort((a, b) => num(b.like) - num(a.like) || num(b.downloadcount) - num(a.downloadcount));
  }
  return arr;
}

export function filterPresets(list, { officialOnly = false, minDownloads = 0, tag = '' } = {}) {
  const t = tag.trim().toLowerCase();
  return list.filter((p) => {
    if (officialOnly && p.type !== 'OFFICIAL' && !p.isFeatured) return false;
    if (minDownloads > 0 && num(p.downloadcount) < minDownloads) return false;
    if (t) {
      const names = [...(p.tags || []).map((x) => x.name), ...(p.newTags || []).map((x) => x.title)]
        .filter(Boolean)
        .join(' ');
      const hay = `${p.title || ''} ${p.username || ''} ${names}`.toLowerCase();
      if (!hay.includes(t)) return false;
    }
    return true;
  });
}

/** 精简后才放进 localStorage，避免原始字段撑爆配额 */
function slim(list) {
  return list.map((p) => ({
    uuid: p.uuid,
    title: p.title,
    file: p.file,
    username: p.username,
    downloadcount: p.downloadcount,
    like: p.like,
    type: p.type,
    isFeatured: p.isFeatured,
    productUuid: p.productUuid,
    desc: p.desc,
    tags: (p.tags || []).map((t) => ({ name: t.name })),
    newTags: (p.newTags || []).map((t) => ({ title: t.title })),
  }));
}

export function saveRankCache(list, uuid = activeProduct.uuid) {
  try {
    localStorage.setItem(cacheKey(uuid), JSON.stringify({ at: Date.now(), list: slim(list) }));
  } catch {
    /* 配额满了就只留内存 */
  }
}

export function readRankCache(uuid = activeProduct.uuid) {
  try {
    if (!uuid) return null;
    const raw = localStorage.getItem(cacheKey(uuid));
    if (!raw) return null;
    const { at, list } = JSON.parse(raw);
    if (!Array.isArray(list) || !list.length) return null;
    if (Date.now() - at > CACHE_TTL) return null;
    return { list, at };
  } catch {
    return null;
  }
}

export async function fetchProfile(entries) {
  const res = await fetch(`${CDN}/${entries}`, { headers: { accept: 'text/plain' } });
  if (!res.ok) throw new Error(`预设文件 ${res.status}`);
  const text = await res.text();
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new Error('预设文件不是合法 JSON');
  }
  if (!Array.isArray(rows) || !rows.length) throw new Error('预设文件为空');
  return rows;
}

/** 社区行 → 我们的 5 段 band 数组 */
export function rowsToBands(rows) {
  const bands = defaultBands(LIMITS.bands);
  rows.slice(0, LIMITS.bands).forEach((row, i) => {
    const f = Number(row.frequency);
    const q = Number(row.q);
    const g = Number(row.gain);
    bands[i] = quantize({
      ...bands[i],
      type: FILTER_MAP[String(row.filter ?? 0)] || 'PK',
      freq: Number.isFinite(f) ? clamp(f, 20, 20000) : bands[i].freq,
      gain: Number.isFinite(g) ? g : 0,
      q: Number.isFinite(q) ? q : 1,
    });
  });
  return bands;
}

/** 我们的 band 数组 → 社区文件同构 JSON */
export function bandsToRows(bands) {
  return bands.map((b, i) => ({
    id: String(i + 1),
    frequency: String(Math.round(b.freq)),
    q: b.q.toFixed(3),
    gain: b.gain.toFixed(1),
    filter: b.type === 'LS' ? '1' : b.type === 'HS' ? '2' : '0',
  }));
}

export async function fetchPresetDetail(uuid) {
  const res = await fetch(`${API}/peq-configs/${uuid}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`社区详情 ${res.status}`);
  const body = await res.json();
  if (body.code !== 0 || !body.data) throw new Error(body.message || '详情不可用');
  return body.data;
}

export async function loadPresetBands(preset) {
  const rows = await fetchProfile(preset.file);
  return rowsToBands(rows);
}
