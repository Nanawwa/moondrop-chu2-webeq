/* KTMicro HID 传输层（竹二 DSP / CHU II DSP）
 *
 * 协议来源：对官方 APK 与社区逆向结论的交叉验证
 *   VID 0x31B2 / PID 0x0113，HID 接口 3，vendor usage page 0xFF01
 *   报文：report 0x4B + 10 字节载荷，走 interrupt OUT/IN
 *
 *   字节:  0     1  2  3  4     5  6  7  8  9
 *         reg   -- -- -- cmd   0  v0 v1 v2 v3
 *   cmd: 0x52 读 / 0x57 写 / 0x53 提交 / 0x43 清除
 *
 *   寄存器：
 *     0x24        EQ 槽位（0x03 = 自定义/开，0x02 = 关）
 *     0x26+2i     第 i 段：增益 ×10（int16 LE）+ 频率 Hz（uint16 LE）
 *     0x27+2i     第 i 段：Q ×1000（uint16 LE）+ 类型（0 PK / 3 LS / 4 HS）
 *     0x66        预增益（竹二上写入无实际效果）
 */

import { registersOf, DEFAULT_PROFILE } from './devices.js';

export const DEVICE_INFO = {
  vendorId: 0x31b2,
  productId: 0x0113,
  reportId: 0x4b,
  page: 0xff01,
};

export const CMD = { READ: 0x52, WRITE: 0x57, COMMIT: 0x53, CLEAR: 0x43 };
export const REG = {
  SLOT: 0x24,
  PREGAIN: 0x66,
  freq: (i) => 0x26 + i * 2,
  q: (i) => 0x27 + i * 2,
};
export const TYPE_CODE = { PK: 0, LS: 3, HS: 4 };
export const CODE_TYPE = { 0: 'PK', 3: 'LS', 4: 'HS' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (arr) => [...arr].map((b) => b.toString(16).padStart(2, '0')).join(' ');

export function buildPacket(reg, cmd, v = [0, 0, 0, 0]) {
  return new Uint8Array([reg, 0, 0, 0, cmd, 0, v[0] & 0xff, v[1] & 0xff, v[2] & 0xff, v[3] & 0xff]);
}

/** 真机传输：WebHID */
export class HidTransport {
  constructor(device, log = () => {}) {
    this.device = device;
    this.log = log;
    this.pending = [];
    this.onInput = this.onInput.bind(this);
    this.detached = false;
  }

  async open() {
    if (!this.device.opened) await this.device.open();
    this.device.addEventListener('inputreport', this.onInput);
    this.device.addEventListener('disconnect', () => {
      this.detached = true;
      this.failAll(new Error('设备已断开'));
    });
    this.log(`打开设备 ${this.device.productName || '(unnamed)'}`);
  }

  async close() {
    try { this.device.removeEventListener('inputreport', this.onInput); } catch { /* noop */ }
    this.failAll(new Error('连接已关闭'));
    try { if (this.device.opened) await this.device.close(); } catch { /* noop */ }
  }

  failAll(err) {
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  onInput(e) {
    const data = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    if (e.reportId !== DEVICE_INFO.reportId) return;
    const reg = data[0];
    const cmd = data[4];
    const i = this.pending.findIndex((p) => p.reg === reg && p.cmd === cmd);
    if (i === -1) {
      this.log(`收到无主报文 ${hex(data)}`, true);
      return;
    }
    const p = this.pending.splice(i, 1)[0];
    clearTimeout(p.timer);
    p.resolve(data);
  }

  send(frame) {
    this.log(`→ ${hex(frame)}`);
    return this.device.sendReport(DEVICE_INFO.reportId, frame);
  }

  /** 读寄存器：返回 10 字节回应 */
  async read(reg, timeout = 900) {
    const frame = buildPacket(reg, CMD.READ, [0, 0, 0, 0]);
    const wait = new Promise((resolve, reject) => {
      const p = { reg, cmd: CMD.READ, resolve, reject };
      p.timer = setTimeout(() => {
        const i = this.pending.indexOf(p);
        if (i !== -1) this.pending.splice(i, 1);
        reject(new Error(`读取 0x${reg.toString(16)} 超时`));
      }, timeout);
      this.pending.push(p);
    });
    await this.send(frame);
    const data = await wait;
    this.log(`← ${hex(data)}`);
    return data;
  }

  async write(reg, v, { ack = true, timeout = 600 } = {}) {
    const frame = buildPacket(reg, CMD.WRITE, v);
    if (!ack) {
      await this.send(frame);
      this.log(`写入 0x${reg.toString(16)}（不等回应）`);
      return null;
    }
    const wait = new Promise((resolve, reject) => {
      const p = { reg, cmd: CMD.WRITE, resolve, reject };
      p.timer = setTimeout(() => {
        const i = this.pending.indexOf(p);
        if (i !== -1) this.pending.splice(i, 1);
        reject(new Error(`写入 0x${reg.toString(16)} 无回应`));
      }, timeout);
      this.pending.push(p);
    });
    await this.send(frame);
    try {
      const data = await wait;
      this.log(`← ${hex(data)}`);
      return data;
    } catch (err) {
      this.log(`写入 0x${reg.toString(16)} 未拿到回应（继续）`, true);
      return null;
    }
  }

  async commit() {
    await this.send(buildPacket(0x00, CMD.COMMIT, [0, 0, 0, 0]));
    this.log('已发送提交命令，等待设备重启');
  }

  async clear() {
    await this.send(buildPacket(0x00, CMD.CLEAR, [0, 0, 0, 0]));
    await sleep(200);
  }
}

/** 模拟传输：没有硬件时也能试界面（?demo=1） */
export class MockTransport {
  constructor(state, log = () => {}) {
    this.log = log;
    this.state = state;
    this.slot = 3;
    this.pregain = 0;
    this.regs = null; // Chu2 会用当前机型档案覆盖
    this.freqScale = 1;
    this.log('模拟设备已就绪（未连接真实硬件）');
  }
  async open() {}
  async close() {}
  regsMap() {
    return this.regs || { gainFreq: REG.freq, q: REG.q, slot: REG.SLOT };
  }
  async read(reg) {
    await sleep(60);
    const out = new Uint8Array(10);
    out[0] = reg; out[4] = CMD.READ;
    const regs = this.regsMap();
    let band = -1;
    let kind = '';
    for (let i = 0; i < this.state.length; i++) {
      if (reg === regs.gainFreq(i)) { band = i; kind = 'f'; }
      if (reg === regs.q(i)) { band = i; kind = 'q'; }
    }
    if (reg === regs.slot) { out[6] = this.slot; return out; }
    if (reg === REG.PREGAIN) { out[6] = this.pregain & 0xff; return out; }
    if (band >= 0) {
      const b = this.state[band];
      if (kind === 'f') {
        const g = Math.round(b.gain * 10) & 0xffff;
        const rawFreq = Math.round(b.freq / this.freqScale);
        out[6] = g & 0xff; out[7] = g >> 8;
        out[8] = rawFreq & 0xff; out[9] = (rawFreq >> 8) & 0xff;
      } else {
        const q = Math.round(b.q * 1000) & 0xffff;
        out[6] = q & 0xff; out[7] = q >> 8;
        out[8] = TYPE_CODE[b.type] ?? 0;
      }
    }
    this.log(`← ${hex(out)}`);
    return out;
  }
  async write(reg, v) {
    await sleep(30);
    const regs = this.regsMap();
    for (let i = 0; i < this.state.length; i++) {
      const b = this.state[i];
      if (reg === regs.gainFreq(i)) {
        const g = (v[0] | (v[1] << 8)) & 0xffff;
        b.gain = ((g > 0x7fff ? g - 0x10000 : g)) / 10;
        b.freq = (v[2] | (v[3] << 8)) * this.freqScale;
      }
      if (reg === regs.q(i)) {
        b.q = (v[0] | (v[1] << 8)) / 1000;
        b.type = CODE_TYPE[v[2]] ?? b.type;
      }
    }
    if (reg === regs.slot) this.slot = v[0];
    if (reg === REG.PREGAIN) this.pregain = v[0] > 127 ? v[0] - 256 : v[0];
    return null;
  }
  async commit() { this.log('模拟提交完成（设备会重启）'); }
  async clear() {}
}

const u16 = (lo, hi) => (lo | (hi << 8)) & 0xffff;
const s16 = (lo, hi) => {
  const v = u16(lo, hi);
  return v > 0x7fff ? v - 0x10000 : v;
};

/** 把传输层包装成「设备」：读全部 / 写全部。profile 决定寄存器布局。 */
export class Chu2 {
  constructor(transport, profile = DEFAULT_PROFILE) {
    this.t = transport;
    this.log = transport.log;
    this.profile = profile;
    this.regs = registersOf(profile);
    this.bandCount = profile.bands || 5;
    // 模拟设备跟着当前档案走，手动切机型时也能读写同一套寄存器
    if (this.t && 'regs' in this.t) this.t.regs = this.regs;
    if (this.t && 'freqScale' in this.t) this.t.freqScale = profile.freqScale || 1;
  }

  async readAll() {
    const bands = [];
    for (let i = 0; i < this.bandCount; i++) {
      const f = await this.t.read(this.regs.gainFreq(i));
      await sleep(30);
      const q = await this.t.read(this.regs.q(i));
      await sleep(30);
      const rawFreq = u16(f[8], f[9]);
      bands.push({
        id: i,
        type: CODE_TYPE[q[8]] ?? 'PK',
        // 老 KTMicro 设备把频率按 2× 存（compensate2X）
        freq: rawFreq ? rawFreq * (this.profile.freqScale || 1) : 1000,
        gain: s16(f[6], f[7]) / 10,
        q: Math.max(0.1, u16(q[6], q[7]) / 1000),
      });
    }
    const slot = await this.t.read(this.regs.slot);
    await sleep(30);
    let pregain = 0;
    if (this.profile.pregainRegister != null) {
      const pre = await this.t.read(this.profile.pregainRegister);
      pregain = pre[6] > 127 ? pre[6] - 256 : pre[6];
    }
    return { bands, slot: slot[6], pregain };
  }

  async writeAll(bands, { commit = true, pregain = null } = {}) {
    // 1) 确认 EQ 槽位开着
    const slot = await this.t.read(this.regs.slot);
    await sleep(40);
    if (slot[6] === 0x02) {
      this.log('EQ 处于关闭状态，先切到自定义槽位');
      await this.t.write(this.regs.slot, [0x03, 0, 0, 0]);
      await sleep(60);
    }

    // 2) 写各段。部分 KTMicro 机型（TANCHJIM / Kiwi）不回单段 ACK，
    //    用 profile.writeAck=false 走 fire-and-forget，最后只等 commit。
    const ack = this.profile.writeAck !== false;
    const freqScale = this.profile.freqScale || 1;
    for (let i = 0; i < this.bandCount; i++) {
      const b = bands[i];
      const g = Math.round(b.gain * 10) & 0xffff;
      const f = Math.round(b.freq / freqScale) & 0xffff;
      this.log(`band${i} ${b.type} ${b.freq}Hz ${b.gain}dB Q${b.q}`);
      await this.t.write(this.regs.gainFreq(i), [g & 0xff, g >> 8, f & 0xff, f >> 8], { ack });
      await sleep(40);
      const q = Math.round(b.q * 1000) & 0xffff;
      await this.t.write(this.regs.q(i), [q & 0xff, q >> 8, TYPE_CODE[b.type] ?? 0, 0], { ack });
      await sleep(40);
    }

    // 3) 预增益（竹二上写了也没有 audible 效果，保留兼容）
    if (pregain !== null && this.profile.pregainRegister != null) {
      const v = Math.max(-127, Math.min(127, Math.round(pregain))) & 0xff;
      await this.t.write(this.profile.pregainRegister, [v, 0, 0, 0], { ack: false });
      await sleep(40);
    }

    // 4) 提交（一写就落盘，随后设备重启）
    if (commit) {
      await this.t.commit();
      await sleep(1200);
    }
  }
}

/* ==========================================================================
 * 水月雨 SPV 家族（VID 0x0666）—— IIR 系数协议
 *
 * 来源：APK 反编译（classes.dex 的 ns4/UsbDeviceHandler + libutils-lib.so）
 *   · 报文：[0x4B, OP, CMD, LEN, payload...]，LEN = 总长 - 4
 *   · 写段：OP=1, CMD=9(EQ_UPDATE)，payload 33 字节
 *       [0]=0 [1]=band [2..3]=0 [4..23]=20B 系数
 *       [24..25]=freq LE [26..27]=Q(Q8.8) [28..29]=gain(Q8.8)
 *       [30]=类型 [31]=0 [32]=peqIndex
 *   · 使能：OP=1, CMD=10(EQ_COEFF)，payload [0,0,255,255]
 *   · 保存：OP=1, CMD=1(EQ_SAVE_FLASH)
 *   · 读段：OP=0x80, CMD=9，payload [0, band]；返回字段在 offset 27
 *   · 系数：96 kHz，5×int32 LE Q30；Q/增益 Q8.8（×256）
 *   · 类型：LS=1 PK=2 HS=3 LP=4 HP=5
 * ======================================================================== */

export const SPV = {
  reportId: 0x4b,
  OP_WRITE: 1,
  OP_READ: 0x80,
  EQ_UPDATE: 9,
  EQ_COEFF: 10,
  EQ_SAVE: 1,
  EQ_ACTIVE: 15,
  FS: 96000,
};

export const SPV_TYPE = { PK: 2, LS: 1, HS: 3, LP: 4, HP: 5 };
export const SPV_TYPE_NAME = { 0: 'PK', 1: 'LS', 2: 'PK', 3: 'HS', 4: 'LP', 5: 'HP' };

function spvQ30(num, den) {
  const vals = [den[0], den[1], den[2], -num[1], -num[2]]
    .map((v) => Math.round(v * 1073741824));
  const out = new Uint8Array(20);
  const dv = new DataView(out.buffer);
  vals.forEach((v, i) => dv.setInt32(i * 4, v, true));
  return out;
}

function spvLowShelf(freq, gain, q) {
  const A = 10 ** (gain / 40);
  const w = (freq * Math.PI * 2) / SPV.FS;
  const alpha = (Math.sin(w) / 2) * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
  const c = Math.cos(w);
  const d = A + 1 + (A - 1) * c + 2 * Math.sqrt(A) * alpha;
  return {
    num: [1, (-2 * (A - 1 + (A + 1) * c)) / d, (A + 1 + (A - 1) * c - 2 * Math.sqrt(A) * alpha) / d],
    den: [
      (A * (A + 1 - (A - 1) * c + 2 * Math.sqrt(A) * alpha)) / d,
      (2 * A * (A - 1 - (A + 1) * c)) / d,
      (A * (A + 1 - (A - 1) * c - 2 * Math.sqrt(A) * alpha)) / d,
    ],
  };
}

function spvPeak(freq, gain, q) {
  const A = Math.sqrt(10 ** (gain / 20));
  const w = (freq * Math.PI * 2) / SPV.FS;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const d = alpha / A + 1;
  return {
    num: [1, (-2 * c) / d, (1 - alpha / A) / d],
    den: [(alpha * A + 1) / d, (-2 * c) / d, (1 - alpha * A) / d],
  };
}

function spvHighShelf(freq, gain, q) {
  const A = 10 ** (gain / 40);
  const w = (freq * Math.PI * 2) / SPV.FS;
  const alpha = (Math.sin(w) / 2) * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
  const c = Math.cos(w);
  const d = A + 1 - (A - 1) * c + 2 * Math.sqrt(A) * alpha;
  return {
    num: [1, (2 * (A - 1 - (A + 1) * c)) / d, (A + 1 - (A - 1) * c - 2 * Math.sqrt(A) * alpha) / d],
    den: [
      (A * (A + 1 + (A - 1) * c + 2 * Math.sqrt(A) * alpha)) / d,
      (-2 * A * (A - 1 + (A + 1) * c)) / d,
      (A * (A + 1 + (A - 1) * c - 2 * Math.sqrt(A) * alpha)) / d,
    ],
  };
}

function spvLowPass(freq, q) {
  const w = (freq * Math.PI * 2) / SPV.FS;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const d = alpha + 1;
  return {
    num: [1, (-2 * c) / d, (1 - alpha) / d],
    den: [(1 - c) / 2 / d, (1 - c) / d, (1 - c) / 2 / d],
  };
}

function spvHighPass(freq, q) {
  const w = (freq * Math.PI * 2) / SPV.FS;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const d = alpha + 1;
  return {
    num: [1, (-2 * c) / d, (1 - alpha) / d],
    den: [(1 + c) / 2 / d, (-1 - c) / d, (1 + c) / 2 / d],
  };
}

/** 20 字节 IIR 系数（Q30）。DISABLED 返回全 0。 */
export function spvCoeffs(freq, gain, q, type) {
  if (!type || type === 'DISABLED') return new Uint8Array(20);
  const f = Math.max(10, Math.min(freq, SPV.FS / 2 - 100));
  const qual = Math.max(0.0001, q);
  let c;
  switch (type) {
    case 'LS': c = spvLowShelf(f, gain, qual); break;
    case 'HS': c = spvHighShelf(f, gain, qual); break;
    case 'LP': c = spvLowPass(f, qual); break;
    case 'HP': c = spvHighPass(f, qual); break;
    default: c = spvPeak(f, gain, qual); break;
  }
  return spvQ30(c.num, c.den);
}

function spvWriteQ88(buf, off, value) {
  const v = Math.max(-32768, Math.min(32767, Math.round(value * 256)));
  buf[off] = v & 0xff;
  buf[off + 1] = (v >> 8) & 0xff;
}

function spvReadQ88(dv, off) {
  return dv.getInt16(off, true) / 256;
}

export function buildSpvPacket(op, cmd, payload = new Uint8Array(0)) {
  const pkt = new Uint8Array(4 + payload.length);
  pkt[0] = SPV.reportId;
  pkt[1] = op;
  pkt[2] = cmd;
  pkt[3] = payload.length;
  pkt.set(payload, 4);
  return pkt;
}

/** SPV 的 WebHID 传输：写不等回应，读等下一份 inputreport */
export class SpvTransport {
  constructor(device, log = () => {}) {
    this.device = device;
    this.log = log;
    this.pending = null;
    this.detached = false;
    this.onInput = this.onInput.bind(this);
  }

  async open() {
    if (!this.device.opened) await this.device.open();
    this.device.addEventListener('inputreport', this.onInput);
    this.device.addEventListener('disconnect', () => {
      this.detached = true;
      this.fail(new Error('设备已断开'));
    });
    this.log(`打开 SPV 设备 ${this.device.productName || '(unnamed)'} · report 0x4B`);
  }

  async close() {
    try { this.device.removeEventListener('inputreport', this.onInput); } catch { /* noop */ }
    this.fail(new Error('连接已关闭'));
    try { if (this.device.opened) await this.device.close(); } catch { /* noop */ }
  }

  fail(err) {
    if (!this.pending) return;
    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }

  onInput(e) {
    if (e.reportId !== SPV.reportId) return;
    const data = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    if (!this.pending) {
      this.log(`收到无主 SPV 报文 ${hex(data)}`, true);
      return;
    }
    const p = this.pending;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(new DataView(data.buffer, data.byteOffset, data.byteLength));
  }

  async send(packet) {
    this.log(`→ ${hex(packet)}`);
    await this.device.sendReport(packet[0], packet.subarray(1));
  }

  async query(packet, timeout = 1200) {
    const wait = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending && this.pending.timer === timer) this.pending = null;
        reject(new Error('SPV 读取超时'));
      }, timeout);
      this.pending = { resolve, reject, timer };
    });
    await this.send(packet);
    return wait;
  }
}

/** SPV 设备：读段 / 写段 / 使能 / 保存 flash */
export class Spv {
  constructor(transport, profile) {
    this.t = transport;
    this.log = transport.log;
    this.profile = profile;
    this.bandCount = profile.bands || 8;
    this.peqIndex = profile.peqIndex ?? 7;
  }

  async readAll() {
    const bands = [];
    for (let i = 0; i < this.bandCount; i++) {
      const dv = await this.t.query(
        buildSpvPacket(SPV.OP_READ, SPV.EQ_UPDATE, new Uint8Array([0, i])),
      );
      if (!dv || dv.byteLength < 34) throw new Error('SPV 读取返回长度异常');
      // 正常响应以 OP 开头；少数实现会带 report id，做一次兼容判断
      const base = dv.getUint8(0) === SPV.OP_READ ? 27 : 28;
      const code = dv.getUint8(base + 6);
      bands.push({
        id: i,
        type: SPV_TYPE_NAME[code] || 'PK',
        freq: dv.getUint16(base, true) || 1000,
        q: Math.max(0.1, spvReadQ88(dv, base + 2) || 1),
        gain: spvReadQ88(dv, base + 4),
      });
      await sleep(50);
    }
    return { bands, slot: this.peqIndex, pregain: 0 };
  }

  async writeAll(bands, { commit = true } = {}) {
    for (let i = 0; i < this.bandCount; i++) {
      const b = bands[i];
      const payload = new Uint8Array(33);
      payload[0] = 0;
      payload[1] = i;
      payload.set(spvCoeffs(b.freq, b.gain, b.q, b.type), 4);
      payload[24] = b.freq & 0xff;
      payload[25] = (b.freq >> 8) & 0xff;
      spvWriteQ88(payload, 26, b.q);
      spvWriteQ88(payload, 28, b.gain);
      payload[30] = SPV_TYPE[b.type] ?? SPV_TYPE.PK;
      payload[32] = this.peqIndex;
      this.log(`SPV band${i} ${b.type} ${b.freq}Hz ${b.gain}dB Q${b.q}`);
      await this.t.send(buildSpvPacket(SPV.OP_WRITE, SPV.EQ_UPDATE, payload));
      await sleep(25);
    }

    // 使能全部系数
    await this.t.send(buildSpvPacket(SPV.OP_WRITE, SPV.EQ_COEFF, new Uint8Array([0, 0, 255, 255])));
    await sleep(50);

    if (commit) await this.commit();
  }

  async commit() {
    await this.t.send(buildSpvPacket(SPV.OP_WRITE, SPV.EQ_SAVE, new Uint8Array(0)));
    await sleep(200);
    this.log('SPV 已保存到 flash');
  }
}
