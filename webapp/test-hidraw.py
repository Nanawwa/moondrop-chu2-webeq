#!/usr/bin/env python3
"""绕开浏览器、直接在 Linux 上验协议：读竹2 DSP 的 EQ 槽位和 5 段参数。

用法：
  ls /dev/hidraw*                     # 插上耳机后看多出来哪个
  sudo python3 test-hidraw.py /dev/hidraw3

只读，不写入任何东西。Windows 上这个脚本不适用（hidraw 是 Linux 的东西）。
"""
import os
import sys
import time

VID, PID = 0x31B2, 0x0113
REPORT_ID = 0x4B
CMD_READ = 0x52
REG = {"slot": 0x24, "pregain": 0x66}


def find_hidraw():
    for name in sorted(os.listdir("/dev")):
        if not name.startswith("hidraw"):
            continue
        path = f"/dev/{name}"
        uevent = f"/sys/class/hidraw/{name}/device/uevent"
        try:
            info = open(uevent).read().upper()
        except OSError:
            continue
        if f"{VID:08X}" in info and f"{PID:08X}" in info:
            return path
    return None


def frame(reg, cmd, v=(0, 0, 0, 0)):
    return bytes([REPORT_ID, reg, 0, 0, 0, cmd, 0, *[b & 0xFF for b in v]])


def read_reg(fd, reg, timeout=1.0):
    os.write(fd, frame(reg, CMD_READ))
    deadline = time.time() + timeout
    while time.time() < deadline:
        data = os.read(fd, 64)
        if len(data) >= 10 and data[0] == REPORT_ID:
            p = data[1:11]
            if p[0] == reg and p[4] == CMD_READ:
                return p
    return None


def s16(lo, hi):
    v = lo | (hi << 8)
    return v - 0x10000 if v > 0x7FFF else v


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else find_hidraw()
    if not path:
        sys.exit("没找到 31b2:0113 的 hidraw 节点，先插好耳机再跑，或用参数指定路径")
    fd = os.open(path, os.O_RDWR)
    print(f"设备 {path}")

    slot = read_reg(fd, REG["slot"])
    print("槽位 0x24 →", slot.hex(" ") if slot else "无回应")
    if slot:
        print("  EQ 状态:", "开（自定义）" if slot[6] == 3 else "关" if slot[6] == 2 else slot[6])

    for i in range(5):
        f = read_reg(fd, 0x26 + i * 2)
        q = read_reg(fd, 0x27 + i * 2)
        if not f or not q:
            print(f"band{i}: 无回应")
            continue
        gain = s16(f[6], f[7]) / 10
        freq = f[8] | (f[9] << 8)
        qq = (q[6] | (q[7] << 8)) / 1000
        typ = {0: "PK", 3: "LS", 4: "HS"}.get(q[8], q[8])
        print(f"band{i}: {typ:>2} {freq:>5} Hz  {gain:+5.1f} dB  Q {qq:.3f}")

    pre = read_reg(fd, REG["pregain"])
    if pre:
        v = pre[6] - 256 if pre[6] > 127 else pre[6]
        print("预增益 0x66 →", v, "dB（竹二上通常没有实际效果）")
    os.close(fd)


if __name__ == "__main__":
    main()
