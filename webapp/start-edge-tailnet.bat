@echo off
rem ============================================================================
rem  用 Edge 打开 tailnet 上的竹二 DSP WebEQ，并让这个地址被当作"安全上下文"，
rem  这样 WebHID（navigator.hid）才会出现，才能连 USB 声卡。
rem
rem  不改 Tailscale 配置、不动现有服务；只在本窗口生效。
rem  代价：用的是独立 profile（%LOCALAPPDATA%\Chu2WebEQ），看不到你平时的书签。
rem ============================================================================
setlocal

rem 从 Tailscale 取本机 MagicDNS 名。如果你的客户端关了 MagicDNS 或没装 tailscale CLI，
rem 手动把下面两行改成 http://<机器名>.<tailnet>.ts.net:8099 或 http://<tailnet-ip>:8099
set "TS="
for /f "delims=" %%i in ('powershell -NoProfile -Command "(tailscale status --json | ConvertFrom-Json).Self.DNSName.TrimEnd('.')" 2^>nul') do set "TS=%%i"
if not defined TS (
  echo [x] 没拿到 Tailscale MagicDNS 名。先确认 tailscale 命令可用，
  echo     或手动把 URL / ORIGIN 改成具体地址后再跑。
  pause
  exit /b 1
)
set "URL=http://%TS%:8099/"
set "ORIGIN=http://%TS%:8099"
set "PROFILE=%LOCALAPPDATA%\Chu2WebEQ"

set "EDGE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE (
  echo [x] 没找到 msedge.exe，把下面的命令手动改一下路径后在 cmd 里跑：
  echo     msedge.exe --unsafely-treat-insecure-origin-as-secure=%ORIGIN% --user-data-dir="%PROFILE%" %URL%
  pause
  exit /b 1
)

echo 启动 Edge：%EDGE%
echo 地址：%URL%
echo 若页面仍提示"需要 https 或 localhost"，按 F12 看 Console 里 isSecureContext 的值。
start "" "%EDGE%" --unsafely-treat-insecure-origin-as-secure=%ORIGIN% --user-data-dir="%PROFILE%" --no-first-run --new-window "%URL%"

endlocal
