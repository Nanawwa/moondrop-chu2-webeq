#!/usr/bin/env bash
# 用法： ./deploy/verify.sh https://eq.example.com
set -uo pipefail
BASE="${1:?用法: verify.sh https://你的域名}"
BASE="${BASE%/}"
fail=0

check() {
  local path="$1" want="${2:-200}"
  local out code ctype
  out=$(curl -s -o /dev/null -w '%{http_code} %{content_type}' --max-time 10 "${BASE}${path}")
  code="${out%% *}"; ctype="${out#* }"
  if [ "$code" = "$want" ]; then
    printf '  ✓ %-22s %s  %s\n' "$path" "$code" "$ctype"
  else
    printf '  ✗ %-22s %s (期望 %s)\n' "$path" "$code" "$want"; fail=1
  fi
}

echo "站点：$BASE"
case "$BASE" in
  https://*) ;;
  *) echo "  ! 不是 https —— WebHID 不会可用，仅能看界面" ;;
esac

check "/"
check "/styles.css"
check "/js/app.js"
check "/js/community.js"
check "/js/importers.js"
check "/js/devices.js"
check "/js/protocol.js"
check "/js/eqmath.js"
check "/js/chart.js"
check "/chu2-webeq.html"

# 证书链检查（仅 https）
if [[ "$BASE" == https://* ]]; then
  host=$(echo "$BASE" | sed -E 's#https://([^/]+).*#\1#')
  if echo | openssl s_client -connect "${host}:443" -servername "${host}" 2>/dev/null | grep -q 'Verify return code: 0 (ok)'; then
    echo "  ✓ 证书链校验通过"
  else
    echo "  ✗ 证书链有问题（自签或链不全），浏览器会把页面判为非安全上下文"; fail=1
  fi
fi

echo
echo "浏览器侧还要确认（F12 Console）："
echo '  window.isSecureContext   → true'
echo '  typeof navigator.hid     → "object"'
exit $fail
