#!/bin/bash
# 배포: 암호화 번들을 새로 만들고 main → gh-pages 로 밀어 GitHub Pages 를 갱신합니다.
# (Pages 소스가 gh-pages 로 잡혀 있어서, main 만 푸시하면 사이트가 바뀌지 않습니다.)
set -euo pipefail
cd "$(dirname "$0")"

echo "--- 1) 암호화 번들 생성"
python3 build_encrypted.py
python3 build_standalone.py

echo "--- 2) 평문이 실수로 올라가지 않는지 확인"
if git ls-files --error-unmatch data.json >/dev/null 2>&1 || \
   git ls-files --error-unmatch data-embed.js >/dev/null 2>&1; then
  echo "평문 파일이 아직 Git 추적 중입니다. git rm --cached data.json data-embed.js 후 다시 실행하세요." >&2
  exit 1
fi
for f in data.enc.json data-enc.js donnie-board.html; do
  [ -s "$f" ] || { echo "$f 가 없습니다." >&2; exit 1; }
done

echo "--- 3) 커밋 & 푸시"
git add -A
if ! git diff --cached --quiet; then
  git commit -m "우리 집 보드 데이터 갱신 ($(date +%F))"
else
  echo "(커밋할 변경 없음)"
fi
git push origin main
git push origin main:gh-pages --force

echo "--- 4) 사이트 확인"
for i in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://mkl0124-oss.github.io/donnie-board/")
  echo "  index.html HTTP $code"
  [ "$code" = "200" ] && break
  sleep 10
done
plain=$(curl -s -o /dev/null -w "%{http_code}" "https://mkl0124-oss.github.io/donnie-board/data.json")
echo "  data.json HTTP $plain (404 여야 정상)"
