#!/usr/bin/env bash
# 本机起一个静态服务，然后浏览器打开 http://localhost:8099
# WebHID 需要安全上下文：localhost 算安全上下文，直接用 IP 访问不算。
set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-8099}"

echo "竹二 DSP WebEQ"
echo "→ 打开 http://localhost:${PORT}/  （加 ?demo=1 可以先看界面，不接设备）"
echo "→ 用 Chrome / Edge 打开；Firefox 没有 WebHID。"
echo

# 尽量只监听本机，避免把控制接口暴露到局域网
exec python3 -m http.server "${PORT}" --bind 127.0.0.1
