#!/usr/bin/env python3
"""index.html + styles.css + app.js + data-enc.js 를 한 파일로 합쳐 donnie-board.html 을 만듭니다.

휴대폰에서 파일로 바로 열 때(인터넷 주소 없이) 쓰는 오프라인용 파일입니다.
이 파일에도 암호문만 들어갑니다. (열 때는 같은 비밀번호가 필요합니다)

index.html 의 자산 주소에는 캐시 버스팅용 `?v=...` 가 붙어 있어도 됩니다.
(합칠 때는 쿼리를 떼고 내용을 그대로 넣습니다.)

사용: python3 build_standalone.py
"""
import pathlib
import re

here = pathlib.Path(__file__).resolve().parent
html = (here / "index.html").read_text(encoding="utf-8")
css = (here / "styles.css").read_text(encoding="utf-8")
js = (here / "app.js").read_text(encoding="utf-8")
enc = (here / "data-enc.js").read_text(encoding="utf-8")

RE_CSS = re.compile(r'<link rel="stylesheet" href="styles\.css(?:\?v=[^"]*)?">')
RE_ENC = re.compile(r'<script src="data-enc\.js(?:\?v=[^"]*)?"></script>')
RE_APP = re.compile(r'<script src="app\.js(?:\?v=[^"]*)?"></script>')

for name, pat in (("styles.css", RE_CSS), ("data-enc.js", RE_ENC), ("app.js", RE_APP)):
    if not pat.search(html):
        raise SystemExit(f"index.html 에 {name} 참조가 예상한 모양으로 없습니다.")

html = RE_CSS.sub(lambda m: "<style>\n" + css + "\n</style>", html, count=1)
html = RE_ENC.sub(lambda m: "<script>\n" + enc + "</script>", html, count=1)
html = RE_APP.sub(lambda m: "<script>\n" + js + "\n</script>", html, count=1)

out = here / "donnie-board.html"
out.write_text(html, encoding="utf-8")

left = [m for m in re.findall(r'(?:src|href)="([^"]+)"', html)
        if not m.startswith(("data:", "#"))]
print(f"{out.name} 생성 ({out.stat().st_size/1024:.0f} KB)" +
      (f" · 남은 외부 참조: {left}" if left else " · 외부 참조 없음"))
