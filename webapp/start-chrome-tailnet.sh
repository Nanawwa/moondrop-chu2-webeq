#!/usr/bin/env bash
# macOS / Linux 版：把 tailnet 上的 http 地址当成安全源，WebHID 才会出现。
# 不改 Tailscale 配置，用独立 profile，只在这个窗口生效。
set -euo pipefail
# 默认从 Tailscale 取本机 MagicDNS 名；没装 tailscale 或关了 MagicDNS 时，
# 手动传参，例如：./start-chrome-tailnet.sh http://<机器名>.<tailnet>.ts.net:8099
TS_NAME="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
ORIGIN="${1:-${TS_NAME:+http://$TS_NAME:8099}}"
if [ -z "$ORIGIN" ]; then
  echo "用法：$0 http://<机器名>.<tailnet>.ts.net:8099"
  exit 1
fi
PROFILE="${TMPDIR:-/tmp}/chu2-webeq-profile"

if command -v google-chrome >/dev/null; then BIN=google-chrome
elif command -v chromium >/dev/null; then BIN=chromium
elif [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif [ -x "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" ]; then
  BIN="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
else
  echo "没找到 Chrome / Edge，自己替换 BIN"; exit 1
fi

exec "$BIN" --unsafely-treat-insecure-origin-as-secure="$ORIGIN" \
  --user-data-dir="$PROFILE" --no-first-run --new-window "$ORIGIN/" >/dev/null 2>&1 &
