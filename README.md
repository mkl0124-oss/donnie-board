# 우리 집 보드

아이를 위한 **학원 시간표 · 급식 · 숙제** 보드입니다.
휴대폰(아이폰)에서 링크를 열고 비밀번호를 넣으면 오늘 해야 할 것이 한눈에 보입니다.

- 배포 주소: https://mkl0124-oss.github.io/donnie-board/
- 저장소: https://github.com/mkl0124-oss/donnie-board

## 잠금

보드 내용은 **비밀번호로 암호화**되어 있습니다. 저장소에는 암호문만 올라갑니다.

- 첫 화면은 잠금 화면(🔒)이고, 비밀번호를 넣으면 열립니다.
- `이 기기에서 잠금 해제 유지`를 체크한 채 열면, 그 기기에서는 다음부터 바로 열립니다.
- 오른쪽 위 **🔒 잠금** 버튼을 누르면 언제든 다시 잠깁니다. (그 기기에 저장된 열쇠도 지웁니다)
- 암호화: PBKDF2-HMAC-SHA256(310,000회, 16바이트 salt) → AES-256-GCM(12바이트 IV).
  브라우저에서는 Web Crypto API 로 그 자리에서 풉니다. 서버에는 평문이 가지 않습니다.

## 화면 구성

| 탭 | 내용 |
| --- | --- |
| 오늘 | 오늘의 급식(메뉴·칼로리), 오늘의 학원 일정(시간순, 지금/다음 표시), 겨울방학 D-day와 다가오는 학사일정 |
| 시간표 | 월~토 학원 시간표, 오늘 요일 강조 |
| 급식 | 이번 주 월~금 급식(주 이동 가능), 이번 달 전체 급식 펼쳐보기 |
| 숙제 | 숙제·준비물 체크리스트 (추가·완료·삭제, 이 기기에 저장) |
| 일정 | 시험·수행평가 일정과 범위(다음 시험 D-day), 학사일정 목록과 D-day |

날짜와 요일은 한국 시간(`Asia/Seoul`) 기준으로 자동 인식합니다.

## 파일

```
index.html          화면 구조 (잠금 화면 포함)
styles.css          디자인 (모바일 우선)
app.js              동작 (잠금 해제·복호화, 오늘 계산, 렌더링, 숙제 저장)
data.enc.json       암호문 (salt·iv·iteration·ciphertext)
data-enc.js         위 암호문을 window.DONNIE_ENC 로 넣은 파일
build_encrypted.py  로컬 원본 → 위 두 파일 생성
build_standalone.py 오프라인용 donnie-board.html 생성
fetch_neis.py       급식·학사일정 자동 갱신 (로컬 실행)
deploy.sh           암호화 번들 생성 → 커밋 → 배포
```

저장소에 올리지 않는 로컬 파일: 평문 원본(`data.json`), 비밀번호 파일, salt 파일. (`.gitignore`)

## 배포 (GitHub Pages)

공개 주소는 **`gh-pages` 브랜치**에서 나옵니다. `main`만 고쳐서는 사이트가 바뀌지 않습니다.

```bash
./deploy.sh
```

`deploy.sh`가 하는 일:

1. `build_encrypted.py` — 원본을 암호화해 `data.enc.json`, `data-enc.js` 갱신
2. `build_standalone.py` — `donnie-board.html` 갱신
3. 커밋 후 `main` 과 `gh-pages` 에 푸시 (`gh-pages`는 강제 푸시)
4. 공개 주소가 200인지, `data.json`이 404인지 확인

## 데이터 고치기

1. 로컬 `data.json` 을 고칩니다.
2. `./deploy.sh` 를 실행합니다. (암호화·커밋·배포를 한 번에)
3. 1~2분 뒤 사이트에 반영됩니다. 그 기기의 저장된 열쇠는 salt 가 그대로라 계속 쓸 수 있습니다.

### data.json 구조

- `school`: NEIS 학교 코드(`office`, `neisOffice`, `neisCode`) — 저장소에는 올리지 않습니다
- `vacation`: 겨울방학 기간(`start`, `end`)과 방학식 날짜
- `academies`: 요일별 학원 목록 `{start, end, name, place, kind}` (`kind`: sports·study·care)
- `events`: 학사일정 `{date, title, type}`
- `exams`: 시험 일정 `{date, endDate, title, note, items:[{when, subject, scope}]}`
- `notices`: 알림장에서 온 숙제·준비물 `{updatedAt, source, items:[{id, text}]}`
- `meals`: 날짜별 급식 `{calories, menu: []}`
- `updatedAt`: 데이터 기준일

### 급식·학사일정 자동 갱신

```bash
python3 fetch_neis.py   # 로컬 data.json 갱신 + 암호화 번들 재생성
./deploy.sh             # 배포
```

학교 코드는 로컬 `data.json` 의 `school` 값에서 읽습니다.

## 개인정보

공개 저장소에는 **암호문과 화면 코드만** 있습니다. 아이 실명, 집 주소, 보호자 이름·전화번호,
사진, 학교·학원 이름, 학교 코드는 저장소 어디에도 넣지 않습니다.
비밀번호는 저장소 밖 로컬 파일(`/workspace/work/donnie/.board-pass`, 권한 600)에만 둡니다.

## 참고

- 숙제 체크리스트는 `localStorage`(키 `donnie.homework.v1`)에 저장되어 **그 기기에서만** 유지됩니다.
- 알림장에서 온 항목(`n…`)은 보드 데이터 값으로 다시 채워지고, 체크 상태만 기기에 남습니다.
- 급식표는 NEIS에 올라온 만큼만 표시됩니다. 다음 달 식단은 게시 후 반영됩니다.
