#!/usr/bin/env python3
"""多线程分块下载器（Range），支持 HTTP(S)_PROXY 环境变量"""
import os, sys, time, threading, requests
from concurrent.futures import ThreadPoolExecutor

URL = sys.argv[1]
OUT = sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 16
PROXY = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY") or os.environ.get("ALL_PROXY")
PROXIES = {"http": PROXY, "https": PROXY} if PROXY else None
HDRS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"}

r = requests.head(URL, headers=HDRS, proxies=PROXIES, timeout=30, allow_redirects=True)
total = int(r.headers["content-length"])
print(f"size={total/1048576:.1f} MiB ranges={r.headers.get('accept-ranges')} proxy={PROXY}", flush=True)

part = os.path.join(os.path.dirname(os.path.abspath(OUT)), "." + os.path.basename(OUT) + ".part")
done = [0] * N
lock = threading.Lock()
chunk = (total + N - 1) // N


def grab(i):
    start = i * chunk
    end = min(total, start + chunk) - 1
    if start > end:
        return
    for attempt in range(6):
        try:
            with requests.get(URL, headers={**HDRS, "Range": f"bytes={start}-{end}"},
                              proxies=PROXIES, timeout=60, stream=True) as resp:
                with open(f"{part}.{i}", "wb") as f:
                    for buf in resp.iter_content(262144):
                        f.write(buf)
                        with lock:
                            done[i] += len(buf)
            if os.path.getsize(f"{part}.{i}") == end - start + 1:
                return
        except Exception as e:
            print(f"[w{i}] retry {attempt}: {e}", flush=True)
            time.sleep(1 + attempt)
    raise RuntimeError(f"chunk {i} failed")


t0 = time.time()
with ThreadPoolExecutor(N) as ex:
    futs = [ex.submit(grab, i) for i in range(N)]
    while any(not f.done() for f in futs):
        time.sleep(0.5)
        got = sum(done)
        sp = got / max(time.time() - t0, 1e-9) / 1048576
        print(f"\r{got/1048576:7.1f}/{total/1048576:.1f} MiB  {100*got/total:5.1f}%  {sp:6.2f} MiB/s", end="", flush=True)
    for f in futs:
        f.result()

with open(OUT, "wb") as out:
    for i in range(N):
        p = f"{part}.{i}"
        if os.path.exists(p):
            with open(p, "rb") as f:
                out.write(f.read())
            os.remove(p)
print(f"\ndone {OUT} {os.path.getsize(OUT)} bytes in {time.time()-t0:.1f}s", flush=True)
