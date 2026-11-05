# 部署指南（给接手的 agent）

把 `chu2/webapp/` 这个静态站点放到云服务器 + 有效证书上。**没有后端、没有数据库、没有构建步骤、没有密钥。**

唯一硬要求：**必须 HTTPS，且证书必须被浏览器认可**。

原因是页面用 WebHID 直连 USB 声卡，而 `navigator.hid` 只在安全上下文里存在：
`https://` ✅、`http://localhost` ✅、`http://1.2.3.4` ❌、自签证书 ❌（浏览器仍判为非安全）。

---

## 0. 要上传什么

整个 `webapp/` 目录（约 200 KB）：

```
index.html  styles.css  js/*.js  chu2-webeq.html  docs/
```

`chu2-webeq.html` 是单文件版（CSS/JS 全内联），如果你只想传一个文件，传它并把
`index.html` 指过去也行：

```nginx
location = / { try_files /chu2-webeq.html =404; }
```

不要传：`*.py`（本地工具）、`run.sh`、`serve.sh`、`start-*`、`deploy/`。

## 1. 域名 + 端口

1. 域名加一条 A 记录指向服务器公网 IP（例：`eq.example.com`）。
2. 安全组 / 防火墙放行 **80 和 443**（80 只用于签发证书，之后可只留 443）。
3. 服务器上确认 80/443 没被别的服务占用：`ss -lntp | grep -E ':80|:443'`。

## 2. 方案 A：nginx + certbot（最通用）

```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
sudo mkdir -p /var/www/chu2-webeq
# 上传 webapp/ 里的文件到这里（rsync/scp/git 都行）
sudo rsync -av --exclude '*.py' --exclude 'deploy' --exclude 'run.sh' --exclude 'serve.sh' \
     --exclude 'start-*' ./webapp/ /var/www/chu2-webeq/

sudo cp deploy/nginx.conf /etc/nginx/sites-available/chu2-webeq
sudo sed -i 's/eq.example.com/你的域名/' /etc/nginx/sites-available/chu2-webeq
sudo ln -s /etc/nginx/sites-available/chu2-webeq /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d 你的域名 --redirect
```

certbot 会改写配置加 443 和跳转。签完访问 `https://你的域名/`。

## 3. 方案 B：Caddy（自动证书，配置最短）

```bash
sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/eq.example.com/你的域名/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy 自动申请并续期证书，不用 certbot。

## 4. 方案 C：Docker

```bash
docker compose -f deploy/docker-compose.yml up -d
```

`deploy/docker-compose.yml` 起两个容器：nginx 静态站 + Caddy 反代并签证书。
把 compose 里的 `eq.example.com` 改成你的域名，`webapp/` 目录路径按实际情况调。

## 5. 验收（必须逐条过）

```bash
./deploy/verify.sh https://你的域名
```

脚本会检查：`/`、`/styles.css`、`/js/app.js`、`/js/importers.js`、`/js/devices.js` 是否 200、
content-type 是否正确、有没有被重定向到 http。

然后在**桌面版 Chrome / Edge** 打开，F12 Console：

```js
location.href
window.isSecureContext      // 必须是 true
typeof navigator.hid        // 必须是 "object"
```

三条都对，才算部署完成。接着插上竹二 DSP → 点「连接设备」→ 选 `Chu2 DSP` → 「读取设备」，
日志里应出现 5 条 `←` 回应。

> 移动端浏览器没有 WebHID，手机打开只能看界面和社区，连不了设备——这是浏览器限制，不是部署问题。

## 6. 缓存与更新

- HTML 用 `no-cache`（`deploy/nginx.conf` 已配），保证改完刷新就生效。
- CSS/JS 可以短缓存；如果你的 CDN 缓存很凶，给文件名加 hash 或直接 `max-age=0`。
- 更新就是覆盖文件，没有迁移、没有重启（nginx 只在改配置时需要 reload）。

## 7. 明确不要做的事

| 别做 | 原因 |
| --- | --- |
| 用自签证书 / 忽略证书错误 | 浏览器仍判非安全上下文，`navigator.hid` 依旧不存在 |
| 给页面加 `Permissions-Policy: hid=()` | 直接把 WebHID 关掉 |
| 把页面塞进 `<iframe>` | WebHID 要求顶层上下文，嵌进去就用不了 |
| 开强制 HTTPS 却只监听 80 | 页面打不开 |
| 用 Cloudflare 的 "Rocket Loader" | 会重写脚本，可能弄坏模块加载；关掉更稳 |
| 把 `*.py`、`*.sh` 一起传到 web 根目录 | 没必要暴露本地脚本 |

## 8. 这个站点对外发起的请求

只有两个域名（浏览器直连，不需要服务端出网）：

- `cdn-service.moondroplab.tech` — 社区列表/详情接口（CORS `*`）
- `cdn.moondroplab.tech` — 预设文件与图片（CORS `*`）

如果你的环境有出网代理，把这两个加白即可；不加也能用，只是社区列表空、本地调音不受影响。
