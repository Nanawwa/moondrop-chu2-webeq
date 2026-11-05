#!/usr/bin/env bash
# 把 WebEQ 挂到 tailnet 的 /eq 路径（只追加一条 handler，不动 / 和 /cc）
#
#   sudo ./enable-tailnet.sh            # 默认 8099
#   sudo ./enable-tailnet.sh 8099
#
# 撤销：sudo tailscale serve --set-path /eq off
set -euo pipefail

PORT="${1:-8099}"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" != "0" ]; then
  echo "需要 root 才能写 tailscale serve 配置："
  echo "  sudo $0 $PORT"
  echo
  echo "（一次性免 sudo 的办法：sudo tailscale set --operator=\$USER）"
  exit 1
fi

HOST="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"

# 本地静态服务得先活着
if ! curl -sf -o /dev/null "http://127.0.0.1:${PORT}/"; then
  echo "[!] 127.0.0.1:${PORT} 没有响应，先把静态服务起来："
  echo "    systemctl --user enable --now chu2-webeq    # 或 ./run.sh"
  echo "    （root 下 systemctl 要加 --user=$SUDO_USER 或直接 nohup python3 -m http.server）"
  exit 1
fi

BEFORE=/tmp/tailscale-serve-before.json
AFTER=/tmp/tailscale-serve-after.json
tailscale serve status --json > "$BEFORE" 2>/dev/null || echo '{}' > "$BEFORE"

echo "== 改动前 =="
tailscale serve status || true

tailscale serve --bg --set-path /eq "http://127.0.0.1:${PORT}"

tailscale serve status --json > "$AFTER" 2>/dev/null || true

echo
echo "== 改动后 =="
tailscale serve status

echo
python3 - "$BEFORE" "$AFTER" "$HOST" <<'PY'
import json, sys
before, after, host = sys.argv[1], sys.argv[2], sys.argv[3]
def handlers(p):
    try:
        d = json.load(open(p))
        return d.get("Web", {}).get(f"{host}:443", {}).get("Handlers", {})
    except Exception:
        return {}
ha, hb = handlers(before), handlers(after)
added = [k for k in hb if k not in ha]
removed = [k for k in ha if k not in hb]
print("新增:", added or "无")
print("消失:", removed or "无（现有服务没被动）")
PY

echo
echo "== 资源自检 =="
for p in /eq/ /eq/styles.css /eq/js/app.js /eq/js/importers.js / /cc/; do
  printf '%-24s ' "$p"
  curl -s -o /dev/null -w '%{http_code}\n' --max-time 8 "https://${HOST}${p}"
done

echo
echo "打开：https://${HOST}/eq/   （末尾斜杠别省）"
echo "撤销：sudo tailscale serve --set-path /eq off"
