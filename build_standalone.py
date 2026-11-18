#!/usr/bin/env python3
"""index.html + styles.css + app.js + data-enc.js 를 한 파일로 합쳐 donnie-board.html 을 만듭니다.

휴대폰에서 파일로 바로 열 때(인터넷 주소 없이) 쓰는 오프라인용 파일입니다.
이 파일에도 암호문만 들어갑니다. (열 때는 같은 비밀번호가 필요합니다)

사용: python3 build_standalone.py
"""
import pathlib
import re

here = pathlib.Path(__file__).resolve().parent
html = (here / "index.html").read_text(encoding="utf-8")
css = (here / "styles.css").read_text(encoding="utf-8")
js = (here / "app.js").read_text(encoding="utf-8")
enc = (here / "data-enc.js").read_text(encoding="utf-8")

if '<script src="data-enc.js"></script>' not in html:
    raise SystemExit("index.html 에 data-enc.js script 태그가 없습니다.")

html = html.replace(
    '<link rel="stylesheet" href="styles.css">',
    "<style>\n" + css + "\n</style>")
html = html.replace(
    '<script src="data-enc.js"></script>',
    "<script>\n" + enc + "</script>")
html = html.replace(
    '<script src="app.js"></script>',
    "<script>\n" + js + "\n</script>")

out = here / "donnie-board.html"
out.write_text(html, encoding="utf-8")

left = [m for m in re.findall(r'(?:src|href)="([^"]+)"', html)
        if not m.startswith(("data:", "#"))]
print(f"{out.name} 생성 ({out.stat().st_size/1024:.0f} KB)" +
      (f" · 남은 외부 참조: {left}" if left else " · 외부 참조 없음"))
