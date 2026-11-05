#!/usr/bin/env bash
# 把 WebEQ 挂到 Tailscale 域名的 /eq 路径下（带有效证书 → 浏览器认为它是安全上下文 → WebHID 可用）
#
# 为什么值得做：页面是纯前端，HID 访问发生在"打开页面那台电脑"上。
# 所以在装了耳机的电脑上打开 https://<机器>.<tailnet>.ts.net/eq/ 就能直接用，
# 不需要把文件拷过去。
set -euo pipefail
PORT="${1:-8099}"
NAME="$(tailscale status --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["Self"]["DNSName"].rstrip("."))' 2>/dev/null || echo "<你的机器名>.ts.net")"

echo "Tailnet 域名: $NAME"
echo

if ! tailscale serve status 2>/dev/null | grep -q '/eq'; then
  echo "需要 root 写一次 serve 配置，执行其中一条："
  echo
  echo "  sudo tailscale serve --bg --set-path /eq http://127.0.0.1:${PORT}"
  echo
  echo "# 或者把 operator 设成你自己，以后就不用 sudo："
  echo "  sudo tailscale set --operator=\$USER"
  echo "  tailscale serve --bg --set-path /eq http://127.0.0.1:${PORT}"
  echo
  echo "配好之后访问： https://${NAME}/eq/"
else
  echo "已经在跑了： https://${NAME}/eq/"
fi
