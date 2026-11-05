#!/usr/bin/env python3
"""把 webapp 打成一个单文件 HTML（内联 CSS/JS），方便拷到别的机器上直接开。"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ORDER = ["eqmath.js", "devices.js", "protocol.js", "chart.js", "community.js", "importers.js", "app.js"]


def strip_module(src: str) -> str:
    src = re.sub(r"^import\s+[\s\S]*?from\s+['\"][^'\"]+['\"];", "", src, flags=re.M)
    src = re.sub(r"^export\s+\{[^}]*\};?", "", src, flags=re.M)
    src = re.sub(r"^export\s+(?=(default\s+)?(const|let|var|function|class|async)\b)", "", src, flags=re.M)
    return src


DECL = re.compile(r"^(?:const|let|class|async function|function)\s+([A-Za-z_$][\w$]*)", re.M)


def check_duplicates(sources: dict) -> None:
    seen = {}
    clash = []
    for name, src in sources.items():
        for m in DECL.finditer(src):
            ident = m.group(1)
            if ident in seen and seen[ident] != name:
                clash.append(f"{ident}: {seen[ident]} vs {name}")
            seen.setdefault(ident, name)
    if clash:
        raise SystemExit("打包会撞名，先改名：\n  " + "\n  ".join(clash))


def main() -> None:
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "styles.css").read_text(encoding="utf-8")
    sources = {name: strip_module((ROOT / "js" / name).read_text(encoding="utf-8")) for name in ORDER}
    check_duplicates(sources)
    js = "\n\n".join(
        f"/* ===== {name} ===== */\n" + sources[name] for name in ORDER
    )

    html = html.replace(
        '<link rel="stylesheet" href="styles.css">',
        "<style>\n" + css + "\n</style>",
    )
    inline = '<script type="module">\n' + js.replace("</script>", "<\\/script>") + "\n</script>"
    # 用函数替换，避免 JS 里的 \s \n 被 re 当成替换模板转义
    html = re.sub(r'<script type="module" src="js/app\.js"></script>', lambda _m: inline, html)
    out = ROOT / "chu2-webeq.html"
    out.write_text(html, encoding="utf-8")
    print(f"{out}  {out.stat().st_size/1024:.1f} KiB")


if __name__ == "__main__":
    main()
