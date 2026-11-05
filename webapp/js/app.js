/* 竹二 DSP WebEQ — 界面与状态
 *
 * 主路径只有一条：连接设备（自动读取）→ 拖曲线 → 写入设备。
 * 社区 / 我的 / 导入 只是把一条曲线放进编辑器，写入永远走右上角那一个按钮。
 */

import {
  LIMITS, setLimits, defaultBands, clamp, quantize, peakBoost, applyHeadroom,
  response, makeGrid,
} from './eqmath.js';
import { EqChart } from './chart.js';
import {
  Chu2, HidTransport, MockTransport, Spv, SpvTransport, DEVICE_INFO,
} from './protocol.js';
import {
  listPresets, loadAllPresets, sortPresets, filterPresets, loadPresetBands,
  bandsToRows, readRankCache, saveRankCache, setProduct, fetchPresetDetail,
} from './community.js';
import { parseImport } from './importers.js';
import { PROFILES, DEFAULT_PROFILE, detectProfile, registersOf } from './devices.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const PAGE_SIZE = 24;
const LS_KEY = 'chu2.webeq.presets.v1';
const THEME_KEY = 'chu2.theme';
const RANK_LIMIT = 100;

const state = {
  bands: defaultBands(5),
  profile: DEFAULT_PROFILE,
  device: null,
  transport: null,
  connected: false,
  deviceName: '',
  slot: null,
  presets: [],
  appliedUuid: '',
  detail: null,
  dirty: false,
  editSeq: 0,
  rank: null,
  buildingRank: false,
  buildSeq: 0,
  community: {
    index: 1,
    total: 0,
    title: '',
    sort: 'downloads',
    officialOnly: false,
    minDownloads: 0,
    tag: '',
    loaded: false,
    error: false,
    seq: 0,
  },
};

/* ---------------- 小工具 ---------------- */

const fmtFreq = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);
const fmtGain = (g) => `${g > 0 ? '+' : ''}${g.toFixed(1)} dB`;
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const fmtCount = (n) => compact.format(Number(n) || 0);

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

let toastTimer = null;
function toast(msg, kind = 'info') {
  const node = $('#toast');
  node.textContent = msg;
  node.dataset.show = '1';
  node.dataset.kind = kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.dataset.show = '0'; }, kind === 'error' ? 4200 : 2600);
}

function log(msg, isErr = false) {
  const host = $('#log');
  if (!host) return;
  const line = el('div', isErr ? 'err' : '');
  const at = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = `${at}  ${msg}`;
  host.appendChild(line);
  while (host.childElementCount > 300) host.removeChild(host.firstElementChild);
  host.scrollTop = host.scrollHeight;
}

function setStatus(text, live = 'off') {
  $('#status-text').textContent = text;
  $('#status').dataset.live = live;
}

function setRankbar(text, kind = '') {
  const node = $('#rank-status');
  node.textContent = text;
  node.className = 'rankbar' + (kind ? ` is-${kind}` : '');
}

const currentTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

function applyTheme(theme, persist = false) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const meta = document.getElementById('meta-theme');
  if (meta) meta.content = theme === 'dark' ? '#0b0b0c' : '#faf9f7';
  const btn = $('#btn-theme');
  if (btn) {
    const toDark = theme === 'light';
    btn.setAttribute('aria-label', toDark ? '切换到夜间模式' : '切换到日间模式');
    btn.title = toDark ? '切换到夜间模式' : '切换到日间模式';
    btn.setAttribute('aria-pressed', String(theme === 'dark'));
  }
  if (persist) {
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* noop */ }
  }
  chart.draw();
  if (state.detail?.bands) drawPresetPreview($('#preset-plot'), state.detail.bands);
}

function toggleTheme() {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
}

const communityName = () => state.profile?.communityName || state.profile?.label || '水月雨社区';
const hasCommunity = () => !!state.profile?.productUuid;

function updateDeviceInfo() {
  const node = $('#dev-info');
  if (!node) return;
  const p = state.profile;
  const bits = [
    p.brand || '—',
    p.protocol === 'spv' ? 'SPV/IIR' : 'KTMicro',
    `${p.bands || 5} 段`,
    `${(p.fs || 48000) / 1000} kHz`,
  ];
  if (p.protocol === 'spv') bits.push(`peqIndex ${p.peqIndex}`);
  if (!p.productUuid) {
    bits.push('无官方社区预设');
  } else if (state.community.error) {
    bits.push('社区不可用');
  } else {
    const count = state.community.total || (state.rank ? state.rank.length : 0);
    bits.push(state.community.loaded ? `社区 ${count.toLocaleString()} 条` : '社区读取中…');
  }
  node.textContent = bits.join(' · ');
}

function updateCommunityLabels() {
  const search = $('#search');
  if (search) search.placeholder = `搜索 ${communityName()} 调音标题…`;
  updateDeviceInfo();
}

function emptyNote(text, isError = false) {
  return el('p', `empty${isError ? ' is-error' : ''}`, text);
}

/* ---------------- 图表 ---------------- */

/** 「未写入」只在已连接且编辑器和设备不一致时出现 */
function setDirty(on) {
  state.dirty = on;
  $('#dirty-badge').hidden = !(on && state.connected);
}

/** 编辑器里的曲线换了来源（设备 / 预设 / 手改）后，清掉旧的「已应用」标记 */
function clearApplied() {
  state.appliedUuid = '';
  for (const node of $$('#preset-list .preset.is-applied')) {
    node.classList.remove('is-applied');
    const trail = node.querySelector('.preset__trail span[data-dl]');
    if (trail) trail.textContent = trail.dataset.dl;
  }
}

/** 手动改过曲线：连接时不要用设备值把用户的修改冲掉 */
function markEdited() {
  state.editSeq += 1;
  setDirty(true);
  clearApplied();
}

const chart = new EqChart($('#plot'), {
  getBands: () => state.bands,
  onChange: (id, patch) => {
    state.bands[id] = quantize({ ...state.bands[id], ...patch });
    markEdited();
    syncBandDOM(id);
    refreshReadout();
  },
});

/* ---------------- 频段编辑 ---------------- */

const bandRows = [];

const pctOfGain = (gain) => {
  const [lo, hi] = LIMITS.gain;
  return ((gain - lo) / (hi - lo)) * 100;
};

const paintGain = (input, gain) => {
  input.style.setProperty('--p', `${pctOfGain(gain).toFixed(2)}%`);
  input.style.setProperty('--zero', `${pctOfGain(0).toFixed(2)}%`);
};

function numberBox({ id, min, max, step, unit, label, prefix = false }) {
  const wrap = el('label', 'num');
  const input = document.createElement('input');
  input.type = 'number';
  input.id = id;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.inputMode = 'decimal';
  input.setAttribute('aria-label', label);
  if (prefix && unit) wrap.appendChild(el('span', 'num__label', unit));
  wrap.appendChild(input);
  if (!prefix && unit) wrap.appendChild(el('span', 'num__unit', unit));
  return { wrap, input };
}

/** 把任意来源的曲线裁/补成当前机型的段数 */
function fitToProfile(bands) {
  const count = state.profile.bands || 5;
  const defs = defaultBands(count);
  const out = bands.slice(0, count).map((b) => quantize({ ...b }));
  while (out.length < count) out.push(quantize(defs[out.length]));
  return out;
}

function buildBands() {
  const host = $('#bands');
  host.textContent = '';
  bandRows.length = 0;

  state.bands.forEach((b, i) => {
    const row = el('div', 'band');

    const idx = el('span', 'band__idx', String(i + 1));
    idx.setAttribute('aria-hidden', 'true');

    const sel = document.createElement('select');
    sel.className = 'select band__type';
    sel.setAttribute('aria-label', `第 ${i + 1} 段滤波器类型`);
    for (const type of state.profile.filterTypes || ['PK', 'LS', 'HS']) {
      const o = el('option', '', type);
      o.value = type;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      state.bands[i] = quantize({ ...state.bands[i], type: sel.value });
      markEdited();
      chart.draw();
      refreshReadout();
    });

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'band__gain';
    slider.id = `g-${i}`;
    slider.min = String(LIMITS.gain[0]);
    slider.max = String(LIMITS.gain[1]);
    slider.step = '0.1';
    slider.value = String(b.gain);
    slider.setAttribute('aria-label', `第 ${i + 1} 段增益`);

    slider.addEventListener('input', () => {
      state.bands[i] = quantize({ ...state.bands[i], gain: Number(slider.value) });
      markEdited();
      syncBandDOM(i, 'slider');
      chart.draw();
      refreshReadout();
    });

    const gain = numberBox({
      id: `gv-${i}`, min: LIMITS.gain[0], max: LIMITS.gain[1], step: 0.1,
      unit: 'dB', label: `第 ${i + 1} 段增益（dB）`,
    });
    gain.wrap.classList.add('band__num--gain');
    gain.input.addEventListener('change', () => {
      const v = Number(gain.input.value);
      state.bands[i] = quantize({ ...state.bands[i], gain: Number.isFinite(v) ? v : 0 });
      markEdited();
      syncBandDOM(i);
      chart.draw();
      refreshReadout();
    });

    const freq = numberBox({
      id: `f-${i}`, min: LIMITS.freq[0], max: LIMITS.freq[1], step: 1,
      unit: 'Hz', label: `第 ${i + 1} 段频率（Hz）`,
    });
    freq.wrap.classList.add('band__num--freq');
    freq.input.addEventListener('change', () => {
      const v = Number(freq.input.value);
      state.bands[i] = quantize({ ...state.bands[i], freq: Number.isFinite(v) ? v : b.freq });
      markEdited();
      syncBandDOM(i);
      chart.draw();
      refreshReadout();
    });

    const q = numberBox({
      id: `q-${i}`, min: LIMITS.q[0], max: LIMITS.q[1], step: 0.01,
      unit: 'Q', label: `第 ${i + 1} 段 Q 值`, prefix: true,
    });
    q.wrap.classList.add('band__num--q');
    q.input.addEventListener('change', () => {
      const v = Number(q.input.value);
      state.bands[i] = quantize({ ...state.bands[i], q: Number.isFinite(v) ? v : b.q });
      markEdited();
      syncBandDOM(i);
      chart.draw();
      refreshReadout();
    });

    row.append(idx, sel, slider, gain.wrap, freq.wrap, q.wrap);
    host.appendChild(row);
    bandRows.push({ row, sel, slider, gain, freq, q });
  });

  syncAllDOM();
}

/** 把 state 写回控件；skip='slider' 时不要打断正在拖动的滑块 */
function syncBandDOM(i, skip = '') {
  const r = bandRows[i];
  const b = state.bands[i];
  if (!r) return;

  r.sel.value = b.type;
  if (skip !== 'slider') r.slider.value = String(b.gain);
  paintGain(r.slider, b.gain);
  r.slider.setAttribute('aria-valuetext', fmtGain(b.gain));
  r.gain.input.value = b.gain.toFixed(1);
  r.freq.input.value = String(Math.round(b.freq));
  r.q.input.value = b.q.toFixed(2);
}

function syncAllDOM() {
  state.bands.forEach((_, i) => syncBandDOM(i));
}

function refreshReadout() {
  const peak = peakBoost(state.bands);
  const node = $('#peak-readout');
  node.textContent = `${peak > 0 ? '+' : ''}${peak.toFixed(1)} dB`;
  node.classList.toggle('is-hot', peak > 0.1);
}

function refreshAll() {
  syncAllDOM();
  refreshReadout();
  chart.draw();
}

/* ---------------- 机型 / 设备 ---------------- */

function buildProfileOptions() {
  const sel = $('#dev-profile');
  sel.textContent = '';
  for (const p of PROFILES) {
    const tag = p.verified ? '' : (p.experimental ? ' · 实验' : ' · 未验证');
    const o = el('option', '', p.label + tag);
    o.value = p.id;
    sel.appendChild(o);
  }
  sel.value = state.profile.id;
}

/** 不同机型支持的滤波类型不同（例如 KT02H20 只有 PK） */
function applyFilterTypes() {
  const types = state.profile.filterTypes || ['PK', 'LS', 'HS'];
  state.bands.forEach((b, i) => {
    if (!types.includes(b.type)) state.bands[i] = { ...b, type: 'PK' };
    const r = bandRows[i];
    if (!r) return;
    const cur = state.bands[i].type;
    r.sel.textContent = '';
    for (const type of types) {
      const o = el('option', '', type);
      o.value = type;
      r.sel.appendChild(o);
    }
    r.sel.value = cur;
  });
  chart.draw();
  refreshReadout();
}

function applyLimits() {
  state.bands = state.bands.map((b) => quantize(b));
  bandRows.forEach((r, i) => {
    const b = state.bands[i];
    if (!b) return;
    r.slider.min = String(LIMITS.gain[0]);
    r.slider.max = String(LIMITS.gain[1]);
    r.gain.input.min = String(LIMITS.gain[0]);
    r.gain.input.max = String(LIMITS.gain[1]);
    r.freq.input.min = String(LIMITS.freq[0]);
    r.freq.input.max = String(LIMITS.freq[1]);
    r.q.input.min = String(LIMITS.q[0]);
    r.q.input.max = String(LIMITS.q[1]);
    syncBandDOM(i);
  });
  chart.draw();
  refreshReadout();
}

/** 切到段数不同的机型时保留能保留的段，不够的补默认段 */
function resizeBands(count) {
  if (state.bands.length === count) {
    state.bands = state.bands.map((b) => quantize(b));
    applyLimits();
    return;
  }
  const defs = defaultBands(count);
  const next = state.bands.slice(0, count).map((b) => quantize(b));
  while (next.length < count) next.push(quantize(defs[next.length]));
  state.bands = next;
  buildBands();
}

function setProfile(profile, quiet = false) {
  const prevId = state.profile?.id;
  state.profile = profile;
  setProduct(profile);
  setLimits({
    bands: profile.bands || 5,
    gain: profile.gain || [-12, 12],
    q: profile.q || [0.1, 10],
    freq: profile.freq || [20, 20000],
    fs: profile.fs || 48000,
  });

  $('#dev-profile').value = profile.id;
  const sub = $('#brand-sub');
  if (sub) sub.textContent = `${profile.label} · ${profile.bands || 5} 段`;
  document.title = `${profile.label} · WebEQ`;
  const note = $('#profile-note');
  const unverified = profile.verified
    ? ''
    : (profile.protocol === 'spv' ? '' : ' · 未在竹二上验证');
  note.textContent = `${profile.note}${unverified}${profile.experimental ? ' · 实验' : ''}`;
  note.className = `hint${profile.verified ? '' : ' is-warn'}`;
  if (!quiet) log(`机型档案 → ${profile.label}${profile.verified ? '' : '（未验证）'}`);

  if (state.device) {
    state.device.profile = profile;
    if ('regs' in state.device) state.device.regs = registersOf(profile);
    state.device.bandCount = profile.bands || 5;
    if (state.device.peqIndex !== undefined) state.device.peqIndex = profile.peqIndex ?? 7;
    if (state.transport && 'regs' in state.transport) state.transport.regs = state.device.regs;
    if (state.transport && 'freqScale' in state.transport) state.transport.freqScale = profile.freqScale || 1;
  }

  resizeBands(profile.bands || 5);
  applyFilterTypes();

  if (prevId && prevId !== profile.id) syncCommunityToProfile();
  else updateCommunityLabels();
}

function setConnected(on, name = '') {
  state.connected = on;
  $('#dirty-badge').hidden = !(on && state.dirty);
  $('#btn-read').disabled = !on;
  $('#btn-write').disabled = !on;
  $('#btn-connect').textContent = on ? '断开连接' : '连接设备';
  const badge = $('#dev-badge');
  badge.textContent = on ? '已连接' : '未连接';
  badge.dataset.state = on ? 'on' : 'off';

  if (on) {
    state.deviceName = name || 'Chu2 DSP';
    $('#dev-name').textContent = state.deviceName;
    $('#dev-meta').textContent = `VID 0x31B2 · PID 0x0113 · report 0x4B${DEMO ? ' · 模拟' : ''}`;
    setStatus(`已连接 · ${state.deviceName}`, 'on');
  } else {
    $('#dev-name').textContent = '未连接';
    $('#dev-meta').textContent = 'VID 0x31B2 · PID 0x0113 · report 0x4B';
    setStatus('未连接设备', 'off');
  }
}

async function connect() {
  if (writing) return;
  if (state.connected) { await disconnect(); return; }

  if (DEMO) {
    state.transport = new MockTransport(state.bands, log);
    state.device = new Chu2(state.transport, state.profile);
    setConnected(true, 'Chu2 DSP（模拟）');
    log('模拟模式：不会碰真机');
    if (state.dirty) {
      toast('已连接，保留当前曲线；要读模拟设备值点「从设备读取」');
    } else {
      await doRead();
    }
    return;
  }

  if (!('hid' in navigator)) {
    toast('这个浏览器没有 WebHID，请用 Chrome 或 Edge', 'error');
    log('navigator.hid 不可用：需要 Chrome/Edge，且页面在 localhost 或 https 下', true);
    return;
  }

  const btn = $('#btn-connect');
  btn.disabled = true;
  try {
    setStatus('等待选择设备…', 'busy');
    const devices = await navigator.hid.requestDevice({
      filters: [
        { vendorId: DEVICE_INFO.vendorId, productId: DEVICE_INFO.productId },
        { vendorId: DEVICE_INFO.vendorId },
        { vendorId: 0x0666 },
        { usagePage: DEVICE_INFO.page },
      ],
    });
    if (!devices || !devices.length) {
      setConnected(false);
      return;
    }

    const dev = devices[0];
    const detected = detectProfile(dev);
    if (!detected && dev.vendorId !== DEVICE_INFO.vendorId) {
      // 既不是 KTMicro，也不在 SPV 已收录列表里。宁可拒绝，也不要按别的机型盲写。
      const iir = dev.vendorId === 0x0666;
      const msg = iir
        ? '这台 0x0666 设备不在已收录的 SPV 机型里，已断开，不会盲写'
        : '未识别的机型，已断开，不会写入';
      toast(msg, 'error');
      log(`${msg}（VID 0x${dev.vendorId.toString(16)} PID 0x${dev.productId.toString(16)}）`, true);
      setConnected(false);
      return;
    }

    const profile = detected || PROFILES.find((p) => p.id === 'kt0210-generic');
    const transport = profile.protocol === 'spv'
      ? new SpvTransport(dev, log)
      : new HidTransport(dev, log);
    await transport.open();
    state.transport = transport;
    setProfile(profile, true);
    if (!detected) toast('没识别出具体型号，按 KT0210 通用档案处理；写入前先「从设备读取」核对');

    state.device = profile.protocol === 'spv'
      ? new Spv(transport, profile)
      : new Chu2(transport, profile);
    setConnected(true, dev.productName || state.profile.label);
    $('#dev-meta').textContent =
      `VID 0x${dev.vendorId.toString(16).toUpperCase()} · PID 0x${dev.productId.toString(16).toUpperCase()} · report 0x4B`;
    log(`已连接 ${dev.productName || '(unnamed)'} · VID 0x${dev.vendorId.toString(16)} PID 0x${dev.productId.toString(16)}`);

    if (state.dirty) {
      toast('已连接，保留当前曲线；要读设备原曲线点「从设备读取」');
      log('已连接；当前曲线有未保存的修改，跳过自动读取');
    } else {
      toast('已连接，正在读取当前曲线…');
      await doRead();
    }
  } catch (err) {
    setConnected(false);
    log(`连接失败：${err.message}`, true);
    toast(`连接失败：${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function disconnect() {
  try { await state.transport?.close(); } catch { /* noop */ }
  state.transport = null;
  state.device = null;
  setConnected(false);
  toast('已断开');
}

let writing = false;

async function doRead() {
  if (!state.device) return;
  if (DEMO && state.transport) state.transport.state = state.bands;
  const profileId = state.profile.id;
  const seq = state.editSeq;
  setStatus('读取中…', 'busy');
  try {
    const res = await state.device.readAll();

    // 读的过程中切了机型，或用户改了曲线/应用了预设：设备值不能覆盖用户的操作
    if (state.profile.id !== profileId) {
      setStatus('已连接', 'on');
      log('读取完成，但期间切换了机型，结果已丢弃', false);
      return;
    }
    if (state.editSeq !== seq) {
      state.slot = res.slot;
      setStatus(`已连接 · 槽位 0x${Number(res.slot).toString(16)}`, 'on');
      toast('读取完成，但你期间改了曲线，已保留当前曲线');
      log('读取完成；期间曲线被修改，未覆盖', false);
      return;
    }

    state.bands = fitToProfile(res.bands);
    state.slot = res.slot;
    clearApplied();
    setDirty(false);
    refreshAll();
    setStatus(`已连接 · 槽位 0x${Number(res.slot).toString(16)}`, 'on');
    toast(`已读取设备曲线（${state.bands.length} 段）`);
    log(`读取完成 slot=0x${res.slot.toString(16)} pregain=${res.pregain}`);
  } catch (err) {
    if (state.editSeq !== seq || state.profile.id !== profileId) return;
    setStatus('已连接 · 读取失败', 'error');
    log(`读取失败：${err.message}`, true);
    toast(`读取失败：${err.message}`, 'error');
  }
}

/* ---------------- 写入 ---------------- */

function openDialog(dlg) {
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function closeDialog(dlg) {
  if (typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
}

function askWrite() {
  if (!state.device) { toast('先连接设备', 'error'); return; }
  const peak = peakBoost(state.bands);
  const p = state.profile;
  const warn = p.verified
    ? ''
    : (p.experimental
      ? '当前是实验机型档案，写入有风险，建议先「从设备读取」核对。'
      : '当前机型档案还没在真机验证过，写入前建议先「从设备读取」核对。');
  const restarts = p.commitRestarts !== false;
  const tail = restarts
    ? '提交后设备会重启一次，约 1 秒音频中断；拔掉再插会保留这次的曲线。'
    : '写入后立即保存到设备 flash，不会重启。';
  $('#dlg-write-body').textContent =
    `${warn}把当前 ${state.bands.length} 段曲线写进 ${p.label}（峰值 ${peak > 0 ? '+' : ''}${peak.toFixed(1)} dB）。${tail}`;
  openDialog($('#dlg-write'));
}

async function doWrite() {
  if (!state.device || writing) return;
  writing = true;
  const wBtn = $('#btn-write');
  const cBtn = $('#btn-connect');
  const rBtn = $('#btn-read');
  const okBtn = $('#dlg-ok');
  wBtn.disabled = true;
  cBtn.disabled = true;
  rBtn.disabled = true;
  okBtn.disabled = true;
  const restarts = state.profile.commitRestarts !== false;
  try {
    setStatus('写入中…', 'busy');
    await state.device.writeAll(state.bands, { commit: true });
    setDirty(false);
    if (restarts) {
      setStatus('已提交 · 设备重启中', 'busy');
      log('提交完成，设备会重新枚举', false);
      toast('已提交，设备重启中；约 1 秒后重新连接');
      try { await state.transport?.close(); } catch { /* noop */ }
      state.transport = null;
      state.device = null;
      setConnected(false);
      setStatus('已提交 · 重新连接后可继续', 'off');
    } else {
      setStatus('已保存到设备', 'on');
      toast('已写入并保存到设备');
      log('SPV 写入完成（未重启）');
    }
  } catch (err) {
    setStatus('写入失败', 'error');
    log(`写入失败：${err.message}`, true);
    toast(`写入失败：${err.message}`, 'error');
  } finally {
    writing = false;
    okBtn.disabled = false;
    cBtn.disabled = false;
    wBtn.disabled = !state.connected;
    rBtn.disabled = !state.connected;
  }
}

/* ---------------- 我的预设 ---------------- */

function loadPresets() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    state.presets = raw ? JSON.parse(raw) : [];
  } catch { state.presets = []; }
  renderSaved();
}

function storePresets() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state.presets.slice(0, 40))); } catch { /* noop */ }
  renderSaved();
}

function renderSaved() {
  const host = $('#saved-list');
  host.textContent = '';
  if (!state.presets.length) {
    host.appendChild(emptyNote('还没有自己的预设。调好曲线后点「保存当前」。'));
    return;
  }

  state.presets.forEach((p, idx) => {
    const row = el('div', 'preset preset--static');

    const info = el('div', 'preset__info');
    info.appendChild(el('div', 'preset__title', p.name));
    const meta = p.bands
      .map((b) => `${Math.round(b.freq)}:${b.gain > 0 ? '+' : ''}${b.gain}`)
      .join('  ');
    const from = p.profileLabel ? `${p.profileLabel} · ` : '';
    info.appendChild(el('div', 'preset__meta', from + meta));

    const acts = el('div', 'preset__actions');
    const load = el('button', 'btn btn--soft btn--sm', '载入');
    load.type = 'button';
    load.addEventListener('click', () => {
      markEdited();
      state.bands = fitToProfile(p.bands);
      refreshAll();
      const from = p.profileLabel && p.profileLabel !== state.profile.label ? `（来自 ${p.profileLabel}）` : '';
      toast(`已载入「${p.name}」${from}`);
    });

    const del = el('button', 'btn btn--ghost btn--sm', '删除');
    del.type = 'button';
    del.addEventListener('click', () => {
      state.presets.splice(idx, 1);
      storePresets();
      toast('已删除');
    });

    acts.append(load, del);
    row.append(info, acts);
    host.appendChild(row);
  });
}

function openSaveDialog() {
  const input = $('#preset-name');
  input.value = `我的预设 ${state.presets.length + 1}`;
  openDialog($('#dlg-save'));
  setTimeout(() => { input.focus(); input.select(); }, 30);
}

function saveCurrent() {
  const input = $('#preset-name');
  const name = input.value.trim() || `我的预设 ${state.presets.length + 1}`;
  state.presets.unshift({
    name,
    bands: state.bands.map((b) => quantize(b)),
    at: Date.now(),
    profile: state.profile.id,
    profileLabel: state.profile.label,
    productUuid: state.profile.productUuid || '',
  });
  storePresets();
  closeDialog($('#dlg-save'));
  setTab('mine');
  toast(`已保存「${name}」`);
}

/* ---------------- 社区 ---------------- */

function tagNames(p) {
  const arr = (p.tags && p.tags.length ? p.tags : p.newTags) || [];
  return arr.map((t) => t.name || t.title).filter(Boolean).slice(0, 3);
}

function presetBadge(p) {
  const official = p.type === 'OFFICIAL';
  if (!official && !p.isFeatured) return null;
  return el('span', 'badge-official', official ? '官方' : '精选');
}

function needsRank() {
  const c = state.community;
  return c.sort !== 'default' || c.minDownloads > 0 || !!c.tag.trim();
}

function renderPresetRow(p) {
  const row = el('div', 'preset');
  row.dataset.uuid = p.uuid;

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'preset__main';
  main.setAttribute('aria-label', `应用「${p.title || '(无标题)'}」`);
  main.title = '点击应用这条调音';

  const info = el('div', 'preset__info');
  const title = el('div', 'preset__title', p.title || '(无标题)');
  const badge = presetBadge(p);
  if (badge) title.appendChild(badge);

  const bits = [p.username || '匿名', ...tagNames(p)];
  const meta = el('div', 'preset__meta', bits.join(' · '));
  info.append(title, meta);

  const desc = (p.desc || '').trim();
  if (desc) {
    const d = el('div', 'preset__desc', desc);
    d.title = desc;
    info.appendChild(d);
  }

  const trail = el('div', 'preset__trail');
  const count = el('span', '', `↓ ${fmtCount(p.downloadcount)}`);
  count.title = `${Number(p.downloadcount) || 0} 次下载`;
  count.dataset.dl = count.textContent;
  trail.append(count, el('span', 'preset__chev', '›'));
  main.append(info, trail);

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'preset__more';
  more.textContent = '详情';
  more.setAttribute('aria-label', `查看「${p.title || '(无标题)'}」的详情`);
  more.title = '查看完整描述和频段';
  more.addEventListener('click', () => openPresetDetail(p));

  if (p.uuid === state.appliedUuid) {
    row.classList.add('is-applied');
    count.textContent = '已应用';
  }

  main.addEventListener('click', () => applyPreset(p, main, count));
  row.append(main, more);
  return row;
}

async function applyPreset(p, btn = null, countEl = null, prefetched = null) {
  const row = btn
    ? btn.closest('.preset')
    : [...document.querySelectorAll('#preset-list .preset')].find((x) => x.dataset.uuid === p.uuid);
  const main = btn || row?.querySelector('.preset__main') || null;
  const count = countEl || row?.querySelector('.preset__trail span') || null;

  if (main && main.disabled) return;
  if (main) main.disabled = true;
  if (row) row.classList.add('is-loading');
  const prev = count?.textContent || '';
  if (count) count.textContent = '读取…';

  try {
    const bands = prefetched || await loadPresetBands(p);
    markEdited();
    state.bands = fitToProfile(bands);
    state.appliedUuid = p.uuid;
    refreshAll();

    $$('#preset-list .preset.is-applied').forEach((x) => x.classList.remove('is-applied'));
    if (row) row.classList.add('is-applied');
    if (count) {
      if (!count.dataset.dl) count.dataset.dl = prev;
      count.textContent = '已应用';
    }

    const otherModel = !!(p.productUuid && state.profile.productUuid && p.productUuid !== state.profile.productUuid);
    toast(state.connected
      ? `已应用「${p.title}」，点右上角「写入设备」保存到耳机${otherModel ? '（与当前机型不同，仅作参考）' : ''}`
      : `已应用「${p.title}」，连接设备后可写入${otherModel ? '（与当前机型不同，仅作参考）' : ''}`);
    log(`载入社区调音 ${p.uuid} ${p.title}${otherModel ? '（非当前机型，仅作参考）' : ''}`);

    if (state.connected) {
      const w = $('#btn-write');
      w.classList.remove('is-nudge');
      void w.offsetWidth;
      w.classList.add('is-nudge');
      setTimeout(() => w.classList.remove('is-nudge'), 1400);
    }
  } catch (err) {
    if (count) count.textContent = prev;
    toast(`载入失败：${err.message}`, 'error');
    log(`载入社区调音失败：${err.message}`, true);
  } finally {
    if (main) main.disabled = false;
    if (row) row.classList.remove('is-loading');
  }
}

function renderList(rows, emptyText = '没有找到调音，换个词或放宽筛选。') {
  const list = $('#preset-list');
  list.textContent = '';
  if (!rows.length) {
    list.appendChild(emptyNote(emptyText));
    return;
  }
  const frag = document.createDocumentFragment();
  rows.forEach((p) => frag.appendChild(renderPresetRow(p)));
  list.appendChild(frag);
}

function setCommunityControls(enabled) {
  for (const id of ['search', 'btn-search', 'sort', 'btn-official', 'btn-filters']) {
    const node = document.getElementById(id);
    if (node) node.disabled = !enabled;
  }
  if (!enabled) {
    $('#adv-filters').hidden = true;
    $('#btn-filters').setAttribute('aria-expanded', 'false');
  }
}

function resetCommunityState() {
  state.community.seq += 1;
  state.buildSeq += 1;
  state.buildingRank = false;
  state.community.index = 1;
  state.community.total = 0;
  state.community.loaded = false;
  state.community.error = false;
  state.community.title = '';
  state.community.sort = 'downloads';
  state.community.officialOnly = false;
  state.community.minDownloads = 0;
  state.community.tag = '';
  state.rank = null;
  $('#search').value = '';
  $('#sort').value = 'downloads';
  $('#btn-official').setAttribute('aria-pressed', 'false');
  $('#min-dl').value = '0';
  $('#tag').value = '';
  $('#adv-filters').hidden = true;
  $('#btn-filters').setAttribute('aria-expanded', 'false');
  $('#rank-progress').hidden = true;
  $('#page-info').textContent = '—';
  setRankbar('');
  $('#btn-prev').disabled = true;
  $('#btn-next').disabled = true;
}

function showNoCommunity() {
  const list = $('#preset-list');
  list.textContent = '';
  list.appendChild(emptyNote(
    `水月雨社区只收录水月雨自家产品，${state.profile.label} 没有对应的社区预设。` +
    '可以到「导入」粘贴 AutoEq / 分享文件，或在「我的」里保存自己的曲线。'
  ));
  state.community.total = 0;
  state.community.loaded = true;
  state.community.error = false;
  setRankbar('该机型没有官方社区预设');
  $('#page-info').textContent = '—';
  $('#btn-prev').disabled = true;
  $('#btn-next').disabled = true;
  setCommunityControls(false);
  updateDeviceInfo();
}

function syncCommunityToProfile() {
  resetCommunityState();
  if (!hasCommunity()) {
    showNoCommunity();
    return;
  }
  setCommunityControls(true);
  const cached = readRankCache(state.profile.productUuid);
  if (cached) state.rank = cached.list;
  updateCommunityLabels();
  loadCommunity(1);
}

async function loadCommunity(index = 1) {
  if (!hasCommunity()) { showNoCommunity(); return; }
  if (needsRank()) {
    if (state.rank) renderRanked();
    else await buildRank();
    return;
  }

  const uuid = state.profile.productUuid;
  const name = communityName();
  const seq = ++state.community.seq;
  const list = $('#preset-list');
  list.textContent = '';
  list.appendChild(emptyNote('正在从水月雨社区读取…'));
  $('#btn-prev').disabled = true;
  $('#btn-next').disabled = true;

  try {
    const { list: rows, total } = await listPresets({
      productUuid: uuid,
      pageIndex: index,
      pageSize: PAGE_SIZE,
      title: state.community.title,
      type: state.community.officialOnly ? 'OFFICIAL' : '',
    });
    if (seq !== state.community.seq || state.profile.productUuid !== uuid) return;

    state.community.index = index;
    state.community.total = total;
    state.community.loaded = true;
    state.community.error = false;
    renderList(rows, total === 0
      ? `「${name}」还没有社区调音，去「导入」或「我的」建一条吧。`
      : '没有找到调音，换个词或放宽筛选。');
    setRankbar(`水月雨社区 · ${name} · 共 ${total.toLocaleString()} 个调音`);
    $('#page-info').textContent = `${index} / ${Math.max(1, Math.ceil(total / PAGE_SIZE))} 页`;
    $('#btn-prev').disabled = index <= 1;
    $('#btn-next').disabled = index * PAGE_SIZE >= total;
    setCommunityControls(true);
    updateDeviceInfo();
  } catch (err) {
    if (seq !== state.community.seq || state.profile.productUuid !== uuid) return;
    state.community.error = true;
    updateDeviceInfo();
    list.textContent = '';
    list.appendChild(emptyNote(`社区接口没响应：${err.message}。检查网络后重试。`, true));
    setRankbar(`社区连接失败 · ${name}`, 'error');
    log(`社区拉取失败：${err.message}`, true);
  }
}

async function buildRank() {
  if (!hasCommunity()) { showNoCommunity(); return; }
  const uuid = state.profile.productUuid;
  const name = communityName();
  if (state.buildingRank === uuid) return;
  const seq = ++state.buildSeq;
  state.buildingRank = uuid;

  const list = $('#preset-list');
  list.textContent = '';
  list.appendChild(emptyNote(`正在加载 ${name} 的下载量榜单…`));

  const progress = $('#rank-progress');
  const bar = progress.querySelector('span');
  progress.hidden = false;
  bar.style.width = '0%';
  setRankbar(`正在加载 ${name} 完整榜单…`);
  $('#sort').disabled = true;

  try {
    const { list, total } = await loadAllPresets({
      productUuid: uuid,
      pageSize: 1000,
      concurrency: 4,
      maxPages: 50,
      onProgress: ({ done, pages, count }) => {
        if (seq !== state.buildSeq || state.profile.productUuid !== uuid) return;
        if (pages > 1) bar.style.width = `${Math.round((done / pages) * 100)}%`;
        setRankbar(`加载 ${name} 榜单 ${done}/${pages} 页 · 已 ${count.toLocaleString()} 条`);
      },
    });
    if (seq !== state.buildSeq || state.profile.productUuid !== uuid) return;

    state.rank = list;
    state.community.total = total;
    state.community.loaded = true;
    state.community.error = false;
    saveRankCache(list, uuid);
    bar.style.width = '100%';
    setTimeout(() => { progress.hidden = true; }, 300);
    setRankbar(`完整榜单就绪 · ${name} · ${list.length.toLocaleString()} / ${total.toLocaleString()} 条`, 'done');
    toast(`${name} 榜单就绪：${list.length.toLocaleString()} 条`);
    renderRanked();
    updateDeviceInfo();
  } catch (err) {
    if (seq !== state.buildSeq || state.profile.productUuid !== uuid) return;
    progress.hidden = true;
    list.textContent = '';
    list.appendChild(emptyNote(`榜单加载失败：${err.message}`, true));
    setRankbar(`榜单加载失败 · ${name}：${err.message}`, 'error');
    toast(`榜单加载失败：${err.message}`, 'error');
    log(`榜单加载失败：${err.message}`, true);
  } finally {
    if (state.buildSeq === seq) {
      state.buildingRank = false;
      $('#sort').disabled = false;
    }
  }
}

function renderRanked() {
  if (!hasCommunity()) { showNoCommunity(); return; }
  const base = state.rank || [];
  if (!base.length) return;

  const c = state.community;
  let filtered = filterPresets(base, {
    officialOnly: c.officialOnly,
    minDownloads: c.minDownloads,
    tag: c.tag,
  });

  const q = c.title.trim().toLowerCase();
  if (q) {
    filtered = filtered.filter((p) => {
      const hay = `${p.title || ''} ${p.username || ''} ${tagNames(p).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  }

  const sorted = sortPresets(filtered, c.sort);
  const shown = sorted.slice(0, RANK_LIMIT);

  renderList(shown, '没有符合条件的调音：把最低下载量或标签放宽一点。');
  const label = { downloads: '下载量 ↓', 'downloads-asc': '下载量 ↑', likes: '点赞 ↓', default: '默认' }[c.sort] || '';
  $('#page-info').textContent =
    `${label} · 命中 ${filtered.length.toLocaleString()} / 全量 ${base.length.toLocaleString()}` +
    (shown.length < filtered.length ? ` · 显示前 ${shown.length}` : '');
  $('#btn-prev').disabled = true;
  $('#btn-next').disabled = true;
  if (!state.buildingRank) setRankbar(`完整榜单 · ${communityName()} · ${base.length.toLocaleString()} 条`);
  state.community.loaded = true;
  state.community.total = Math.max(state.community.total || 0, base.length);
  updateDeviceInfo();
}

function refreshCommunity() {
  if (!hasCommunity()) { showNoCommunity(); return; }
  if (needsRank()) {
    if (state.rank) renderRanked();
    else buildRank();
  } else {
    loadCommunity(1);
  }
}

/* ---------------- 社区详情 ---------------- */

let detailToken = 0;

const fmtDate = (ms) => {
  const d = new Date(Number(ms));
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('zh-CN') : '';
};

function detailMeta(p) {
  const bits = [p.username || '匿名', `${(Number(p.downloadcount) || 0).toLocaleString()} 次下载`];
  if (Number(p.like)) bits.push(`${p.like} 赞`);
  if (Number(p.comment_count)) bits.push(`${p.comment_count} 评论`);
  const date = fmtDate(p.createTime);
  if (date) bits.push(date);
  const kind = p.type === 'OFFICIAL' ? '官方' : (p.isFeatured ? '精选' : (p.type === 'PRIVATE' ? '私密' : '用户'));
  bits.push(kind);
  if (p.source) bits.push(`来源 ${p.source}`);
  const tags = tagNames(p);
  if (tags.length) bits.push(tags.join(' / '));
  return bits.join(' · ');
}

function drawPresetPreview(canvas, bands) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width || 520));
  const h = Math.max(1, Math.round(rect.height || 150));
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cs = getComputedStyle(canvas);
  const v = (n, f) => (cs.getPropertyValue(n) || '').trim() || f;
  const grid = v('--plot-grid', '#e7e2db');
  const gridStrong = v('--plot-grid-strong', '#d9d2ca');
  const label = v('--plot-label', '#9a928a');
  const zero = v('--plot-zero', '#c9c1b8');
  const line = v('--plot-line', '#d9533b');
  const fill = v('--plot-fill', 'rgba(217,83,59,.1)');
  const pointBg = v('--plot-point-bg', '#fff');

  const pad = { l: 30, r: 10, t: 10, b: 18 };
  const px = pad.l;
  const py = pad.t;
  const pw = Math.max(1, w - pad.l - pad.r);
  const ph = Math.max(1, h - pad.t - pad.b);
  const lo = Math.log10(LIMITS.freq[0]);
  const hi = Math.log10(LIMITS.freq[1]);
  const xOf = (f) => px + ((Math.log10(clamp(f, LIMITS.freq[0], LIMITS.freq[1])) - lo) / (hi - lo)) * pw;
  const [glo, ghi] = LIMITS.gain;
  const yLo = glo - 1;
  const yHi = ghi + 1;
  const yOf = (db) => py + ph * (1 - (db - yLo) / (yHi - yLo));

  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const [f, text] of [[20, '20'], [100, '100'], [1000, '1k'], [10000, '10k'], [20000, '20k']]) {
    const x = Math.round(xOf(f)) + 0.5;
    ctx.strokeStyle = f === 1000 ? gridStrong : grid;
    ctx.beginPath();
    ctx.moveTo(x, py);
    ctx.lineTo(x, py + ph);
    ctx.stroke();
    ctx.fillStyle = label;
    ctx.fillText(text, x, py + ph + 5);
  }

  const zeroY = Math.round(yOf(0)) + 0.5;
  ctx.strokeStyle = zero;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(px, zeroY);
  ctx.lineTo(px + pw, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  if (!bands || !bands.length) {
    ctx.fillStyle = label;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('读取频段…', px + pw / 2, py + ph / 2);
    return;
  }

  const gridF = makeGrid(260);
  const curve = response(bands, gridF);
  const pts = [];
  for (let i = 0; i < gridF.length; i++) {
    pts.push([xOf(gridF[i]), yOf(clamp(curve[i], yLo, yHi))]);
  }
  ctx.beginPath();
  ctx.moveTo(pts[0][0], zeroY);
  for (const [x, y] of pts) ctx.lineTo(x, y);
  ctx.lineTo(pts[pts.length - 1][0], zeroY);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, py, 0, py + ph);
  grad.addColorStop(0, fill);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.strokeStyle = line;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.stroke();

  for (const b of bands) {
    ctx.beginPath();
    ctx.arc(xOf(b.freq), yOf(clamp(b.gain, yLo, yHi)), 3, 0, Math.PI * 2);
    ctx.fillStyle = pointBg;
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = line;
    ctx.stroke();
  }
}

function renderDetailBands(bands) {
  const host = $('#preset-detail-bands');
  host.textContent = '';
  bands.forEach((b, i) => {
    const row = el('div', 'detail-band');
    row.append(
      el('span', 'detail-band__idx', String(i + 1)),
      el('span', 'detail-band__type', b.type),
      el('span', 'detail-band__freq', fmtFreq(b.freq)),
      el('span', 'detail-band__gain', fmtGain(b.gain)),
      el('span', 'detail-band__q', `Q ${b.q.toFixed(2)}`),
    );
    host.appendChild(row);
  });
}

async function openPresetDetail(p) {
  const token = ++detailToken;
  state.detail = { token, preset: p, bands: null };
  const dlg = $('#dlg-preset');
  const applyBtn = $('#preset-detail-apply');
  const descEl = $('#preset-detail-desc');
  const bandHost = $('#preset-detail-bands');

  $('#preset-detail-title').textContent = p.title || '(无标题)';
  $('#preset-detail-meta').textContent = detailMeta(p);
  const desc = (p.desc || '').trim();
  descEl.textContent = desc || '作者没有填写 EQ 描述。';
  descEl.classList.toggle('is-empty', !desc);
  bandHost.textContent = '';
  bandHost.appendChild(emptyNote('正在读取频段…'));
  applyBtn.disabled = true;
  applyBtn.textContent = '读取中…';
  openDialog(dlg);
  drawPresetPreview($('#preset-plot'), null);

  const bandsTask = loadPresetBands(p)
    .then((bands) => {
      if (!state.detail || state.detail.token !== token) return;
      const fit = fitToProfile(bands);
      state.detail.bands = fit;
      drawPresetPreview($('#preset-plot'), fit);
      renderDetailBands(fit);
      applyBtn.disabled = false;
      applyBtn.textContent = '应用到编辑器';
    })
    .catch((err) => {
      if (!state.detail || state.detail.token !== token) return;
      bandHost.textContent = '';
      bandHost.appendChild(emptyNote(`读取频段失败：${err.message || '网络错误'}`, true));
      applyBtn.textContent = '无法应用';
    });

  const detailTask = fetchPresetDetail(p.uuid)
    .then((full) => {
      if (!state.detail || state.detail.token !== token) return;
      const merged = { ...p, ...full };
      state.detail.preset = merged;
      $('#preset-detail-title').textContent = merged.title || p.title || '(无标题)';
      $('#preset-detail-meta').textContent = detailMeta(merged);
      const fullDesc = (merged.desc || p.desc || '').trim();
      descEl.textContent = fullDesc || '作者没有填写 EQ 描述。';
      descEl.classList.toggle('is-empty', !fullDesc);
    })
    .catch(() => { /* 详情接口失败时保留列表里的字段 */ });

  await Promise.allSettled([bandsTask, detailTask]);
}

function closePresetDetail() {
  state.detail = null;
  closeDialog($('#dlg-preset'));
}

/* ---------------- 导入 / 导出 ---------------- */

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function exportFile() {
  const p = state.profile;
  const slug = (p.id || 'eq').replace(/[^a-z0-9-]/gi, '');
  const data = {
    app: 'chu2-webeq',
    version: 1,
    profile: p.id,
    product: p.communityName || p.label,
    productUuid: p.productUuid || '',
    savedAt: new Date().toISOString(),
    bands: state.bands.map((b) => quantize(b)),
    rows: bandsToRows(state.bands),
  };
  download(`webeq-${slug}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
  toast(`已导出 ${p.label} 的曲线`);
}

function applyImported(res) {
  markEdited();
  state.bands = fitToProfile(res.bands);
  refreshAll();

  const who = [res.title, res.author].filter(Boolean).join(' · ');
  toast(who ? `已应用「${who}」` : `已导入（${res.source}）`);

  const peak = peakBoost(state.bands);
  const warn = peak > 0.5 ? `峰值 +${peak.toFixed(1)} dB，可能削波，可点「自动削峰」` : '';
  const hint = $('#import-hint');
  hint.textContent = [res.note || `来源：${res.source}`, warn].filter(Boolean).join('；');
  hint.className = `hint${res.note || warn ? ' is-warn' : ''}`;
  log(`导入 ${res.source}${who ? ' ' + who : ''}${res.note ? ' — ' + res.note : ''}`);
}

async function runImport() {
  const box = $('#import-input');
  const btn = $('#btn-import-eq');
  const hint = $('#import-hint');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '识别中…';
  hint.className = 'hint';
  try {
    const res = await parseImport(box.value);
    applyImported(res);
    box.value = '';
  } catch (err) {
    toast(err.message, 'error');
    hint.textContent = err.message;
    hint.className = 'hint is-error';
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function importFile(file) {
  const text = await file.text();
  try {
    const res = await parseImport(text);
    applyImported(res);
  } catch (err) {
    toast(err.message, 'error');
    log(`导入文件失败：${err.message}`, true);
  }
}

/* ---------------- 标签页 ---------------- */

function setTab(name) {
  $$('.tab').forEach((t) => {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
  $$('.panel').forEach((p) => { p.hidden = p.id !== `panel-${name}`; });
}

/* ---------------- 事件 ---------------- */

function bind() {
  $('#btn-connect').addEventListener('click', connect);
  $('#btn-theme').addEventListener('click', toggleTheme);
  $('#btn-read').addEventListener('click', doRead);
  $('#btn-write').addEventListener('click', askWrite);

  $('#dev-profile').addEventListener('change', (e) => {
    const p = PROFILES.find((x) => x.id === e.target.value);
    if (p) setProfile(p);
  });

  $('#dlg-cancel').addEventListener('click', () => closeDialog($('#dlg-write')));
  $('#dlg-ok').addEventListener('click', () => {
    closeDialog($('#dlg-write'));
    doWrite();
  });
  $('#dlg-write').addEventListener('click', (e) => {
    if (e.target === $('#dlg-write')) closeDialog($('#dlg-write'));
  });

  $('#btn-flat').addEventListener('click', () => {
    markEdited();
    state.bands = state.bands.map((b) => quantize({ ...b, gain: 0 }));
    refreshAll();
    toast('全部归零');
  });

  $('#btn-headroom').addEventListener('click', () => {
    const before = peakBoost(state.bands);
    markEdited();
    state.bands = applyHeadroom(state.bands, -0.5);
    refreshAll();
    toast(before > 0.1 ? `整体下移 ${(before + 0.5).toFixed(1)} dB，峰值到 -0.5 dB` : '本来就没削波风险');
  });

  $('#btn-save-preset').addEventListener('click', openSaveDialog);
  $('#save-cancel').addEventListener('click', () => closeDialog($('#dlg-save')));
  $('#save-ok').addEventListener('click', saveCurrent);
  $('#dlg-save').addEventListener('click', (e) => {
    if (e.target === $('#dlg-save')) closeDialog($('#dlg-save'));
  });

  $('#preset-detail-cancel').addEventListener('click', closePresetDetail);
  $('#preset-detail-apply').addEventListener('click', () => {
    const d = state.detail;
    if (!d || !d.bands) return;
    const preset = d.preset;
    const bands = d.bands;
    closePresetDetail();
    applyPreset(preset, null, null, bands);
  });
  $('#dlg-preset').addEventListener('click', (e) => {
    if (e.target === $('#dlg-preset')) closePresetDetail();
  });
  $('#dlg-preset').addEventListener('close', () => { state.detail = null; });
  $('#preset-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveCurrent(); }
  });

  $('#btn-export').addEventListener('click', exportFile);
  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) await importFile(file);
    e.target.value = '';
  });
  $('#btn-import-eq').addEventListener('click', runImport);
  $('#import-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runImport(); }
  });

  // 标签页
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const tabs = $$('.tab');
      const i = tabs.indexOf(tab);
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      setTab(next.dataset.tab);
      next.focus();
    });
  });

  // 社区搜索
  const search = $('#search');
  const runSearch = () => {
    state.community.title = search.value.trim();
    refreshCommunity();
  };
  $('#btn-search').addEventListener('click', runSearch);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  search.addEventListener('search', () => {
    if (!search.value) runSearch();
  });

  $('#sort').addEventListener('change', (e) => {
    state.community.sort = e.target.value;
    refreshCommunity();
  });

  $('#btn-official').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(on));
    state.community.officialOnly = on;
    refreshCommunity();
  });

  $('#btn-filters').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    $('#adv-filters').hidden = !open;
  });

  $('#min-dl').addEventListener('change', (e) => {
    state.community.minDownloads = Math.max(0, Number(e.target.value) || 0);
    refreshCommunity();
  });

  $('#tag').addEventListener('change', (e) => {
    state.community.tag = e.target.value.trim();
    refreshCommunity();
  });

  $('#btn-prev').addEventListener('click', () => loadCommunity(Math.max(1, state.community.index - 1)));
  $('#btn-next').addEventListener('click', () => loadCommunity(state.community.index + 1));

  // 日志
  $('#btn-log').addEventListener('click', () => openDialog($('#dlg-log')));
  $('#log-close').addEventListener('click', () => closeDialog($('#dlg-log')));
  $('#log-clear').addEventListener('click', () => { $('#log').textContent = ''; });
  $('#dlg-log').addEventListener('click', (e) => {
    if (e.target === $('#dlg-log')) closeDialog($('#dlg-log'));
  });

  const themeQuery = matchMedia('(prefers-color-scheme: dark)');
  themeQuery.addEventListener('change', (e) => {
    let stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch { /* noop */ }
    if (stored === 'light' || stored === 'dark') return;
    applyTheme(e.matches ? 'dark' : 'light', false);
  });
  window.addEventListener('resize', () => chart.resize());
}

/* ---------------- 启动 ---------------- */

function showHidHelp() {
  const secure = window.isSecureContext !== false;
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  setStatus('浏览器不支持 WebHID', 'error');

  let text;
  if (!secure || !local) {
    text = `当前地址 ${location.origin} 不是安全上下文，浏览器禁用了 WebHID。请通过 https 或 localhost 打开。`;
  } else {
    text = '这个浏览器没有暴露 WebHID。请用 Chrome / Edge 89+ 打开，并确认没有组策略禁用它。';
  }

  $('#dev-name').textContent = 'WebHID 不可用';
  const note = el('p', 'hint is-error', text);
  $('#btn-read').before(note);
  log(`诊断：url=${location.href} secureContext=${window.isSecureContext} hid=${typeof navigator.hid}`, true);
}

function boot() {
  buildBands();
  buildProfileOptions();
  setProfile(state.profile, true);
  bind();
  applyTheme(currentTheme(), false);
  setTab('community');
  refreshAll();
  loadPresets();

  const cached = readRankCache(state.profile.productUuid);
  if (cached) {
    state.rank = cached.list;
    setRankbar(`已缓存 ${cached.list.length.toLocaleString()} 条 ${communityName()} 榜单，选择排序时直接可用`);
  }

  loadCommunity(1);

  if (DEMO) {
    $('#profile-note').textContent = '模拟模式（?demo=1）：界面与曲线可用，写入只改内存';
    connect();
  } else if (!('hid' in navigator)) {
    showHidHelp();
  }
}

boot();
