#!/bin/bash
# 배포: 암호화 번들을 새로 만들고, 캐시 버스팅 버전을 찍은 뒤 main → gh-pages 로 밀어 GitHub Pages 를 갱신합니다.
# (Pages 소스가 gh-pages 로 잡혀 있어서, main 만 푸시하면 사이트가 바뀌지 않습니다.)
set -euo pipefail
cd "$(dirname "$0")"

REPO_URL="https://mkl0124-oss.github.io/donnie-board/"

echo "--- 1) 암호화 번들 생성"
python3 build_encrypted.py

echo "--- 2) 캐시 버스팅 버전 찍기"
# styles.css / data-enc.js / app.js 를 부를 때 붙는 ?v= 값과 version.json 을 같은 값으로 맞춥니다.
# index.html 자체도 브라우저·중계 서버에 10분간 캐시되므로, version.json 을 보고 스스로 새 주소로
# 다시 여는 스크립트가 index.html 안에 들어 있습니다.
VER=$(date +%Y%m%d%H%M%S)
python3 - "$VER" <<'PY'
import json, pathlib, re, sys

ver = sys.argv[1]
idx = pathlib.Path("index.html")
s = idx.read_text(encoding="utf-8")

# 1) asset 주소에 붙은 ?v=... 를 새 버전으로
s = re.sub(r'(?P<name>styles\.css|data-enc\.js|app\.js)(?:\?v=[^"\']*)?',
           lambda m: m.group("name") + "?v=" + ver, s)
# 2) <meta name="board-version" content="...">
s = re.sub(r'(<meta name="board-version" content=")[^"]*(")',
           lambda m: m.group(1) + ver + m.group(2), s)
idx.write_text(s, encoding="utf-8")

app = pathlib.Path("app.js")
a = app.read_text(encoding="utf-8")
a2 = re.sub(r'(board-version:[ \t]*)\S+', lambda m: m.group(1) + ver, a, count=1)
if a2 != a:
    app.write_text(a2, encoding="utf-8")

pathlib.Path("version.json").write_text(
    json.dumps({"version": ver}, ensure_ascii=False) + "\n", encoding="utf-8")

leftover = re.findall(r'"(?:styles\.css|data-enc\.js|app\.js)(?!\?v=)', s)
if leftover:
    sys.exit("캐시 버스팅이 빠진 참조가 있습니다: %s" % leftover)
print("  version = " + ver)
PY

echo "--- 3) 오프라인용 한 파일 재생성 (새 버전 반영)"
python3 build_standalone.py

echo "--- 4) 평문·개인정보가 실수로 올라가지 않는지 확인"
if git ls-files --error-unmatch data.json >/dev/null 2>&1 || \
   git ls-files --error-unmatch data-embed.js >/dev/null 2>&1; then
  echo "평문 파일이 아직 Git 추적 중입니다. git rm --cached data.json data-embed.js 후 다시 실행하세요." >&2
  exit 1
fi
for f in data.enc.json data-enc.js index.html app.js styles.css version.json donnie-board.html; do
  [ -s "$f" ] || { echo "$f 가 없습니다." >&2; exit 1; }
done
# 배포되는 파일에 학교명·반·실명·동네·학원 고유명이 들어가면 멈춥니다.
if grep -n -E "금성|바름반|김도윤|중랑구립체육센터|필드림|제이앤|신내6단지" \
     index.html app.js styles.css data-enc.js data.enc.json version.json donnie-board.html >/dev/null 2>&1; then
  echo "배포 파일에 개인정보로 볼 수 있는 단어가 있습니다. 배포를 멈춥니다." >&2
  grep -n -E "금성|바름반|김도윤|중랑구립체육센터|필드림|제이앤|신내6단지" \
     index.html app.js styles.css data-enc.js data.enc.json version.json donnie-board.html >&2 || true
  exit 1
fi
if python3 - <<'PY'
import json, pathlib, re, sys
enc = json.loads(pathlib.Path("data.enc.json").read_text(encoding="utf-8"))
bad = re.search(r'[가-힣]', enc.get("ciphertext", ""))
sys.exit(1 if bad else 0)
PY
then :
else
  echo "암호문에 평문이 섞여 있습니다." >&2
  exit 1
fi

echo "--- 5) 커밋 & 푸시 (main → gh-pages)"
git add -A
if ! git diff --cached --quiet; then
  git commit -m "우리 집 보드 데이터 갱신 ($(date +%F)) v$VER"
else
  echo "(커밋할 변경 없음)"
fi
git push origin main
git push origin main:gh-pages --force

echo "--- 6) 사이트 확인"
ok=""
for i in $(seq 1 30); do
  page=$(curl -s "$REPO_URL?cachecheck=$RANDOM")
  if printf '%s' "$page" | grep -q "board-version\" content=\"$VER\""; then
    echo "  index.html 새 버전 확인 (v$VER)"
    ok=1
    break
  fi
  echo "  index.html 아직 이전 버전… ($i)"
  sleep 10
done
[ -n "$ok" ] || echo "  경고: index.html 새 버전이 아직 안 보입니다. 1~2분 뒤 다시 확인하세요." >&2

for asset in "app.js" "styles.css" "data-enc.js" "version.json" "data.enc.json"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "${REPO_URL}${asset}?v=$VER")
  echo "  $asset?v=$VER HTTP $code"
done
vj=$(curl -s "${REPO_URL}version.json?t=$RANDOM")
echo "  version.json = $vj"
appok=""
for i in $(seq 1 18); do
  if curl -s "${REPO_URL}app.js?v=$VER" | grep -q "board-version: $VER"; then
    echo "  app.js 안의 버전 표식 일치"
    appok=1
    break
  fi
  echo "  app.js 버전 표식 확인 중… ($i)"
  sleep 10
done
[ -n "$appok" ] || echo "  경고: app.js 버전 표식이 아직 이전 값입니다. 1~2분 뒤 다시 확인하세요." >&2
plain=$(curl -s -o /dev/null -w "%{http_code}" "${REPO_URL}data.json")
echo "  data.json HTTP $plain (404 여야 정상)"
echo "  새 주소(캐시 없이 바로 열기): ${REPO_URL}?v=$VER"
