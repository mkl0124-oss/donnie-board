#!/usr/bin/env python3
"""NEIS(나이스) 교육정보 개방 포털에서 학교 급식·학사일정을 받아 data.json 을 갱신하고,
암호화 번들(data.enc.json / data-enc.js)을 다시 만듭니다.

사용: python3 fetch_neis.py
- 급식: MEAL_FROM ~ MEAL_TO 의 날짜별 중식
- 학사일정: SCHED_FROM ~ SCHED_TO
- 학원 시간표(academies)와 방학 정보(vacation)는 손으로 관리하는 값이라 그대로 둡니다.
- 학교 코드는 data.json 의 school 값(로컬 전용)에서 읽습니다.
"""
import datetime
import json
import pathlib
import re
import subprocess
import sys
import urllib.request

MEAL_FROM = datetime.date(2026, 11, 2)
MEAL_TO = datetime.date(2027, 2, 28)
SCHED_FROM = datetime.date(2026, 9, 1)
SCHED_TO = datetime.date(2027, 3, 1)

HERE = pathlib.Path(__file__).resolve().parent
DATA_PATH = HERE / "data.json"


def school_codes(data):
    school = data.get("school") or {}
    office = school.get("neisOffice")
    code = school.get("neisCode")
    if not office or not code:
        sys.exit("data.json 의 school.neisOffice / school.neisCode 가 필요합니다.")
    return office, code


def api(office, code, hub, **params):
    q = "&".join(f"{k}={v}" for k, v in params.items())
    url = (f"https://open.neis.go.kr/hub/{hub}?Type=json&pIndex=1&pSize=100"
           f"&ATPT_OFCDC_SC_CODE={office}&SD_SCHUL_CODE={code}&{q}")
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return json.load(r)
    except Exception:
        return {}


def clean_menu(s):
    s = s.replace("<br/>", "\n").replace("<br>", "\n")
    s = re.sub(r"\((?:[0-9]+\.)*[0-9]+\)", "", s)
    s = s.replace("!", "")
    return [re.sub(r"[~*]+$", "", p).strip() for p in s.split("\n") if p.strip()]


def fetch_meals(office, code):
    meals = {}
    d = MEAL_FROM
    while d <= MEAL_TO:
        ymd = d.strftime("%Y%m%d")
        r = api(office, code, "mealServiceDietInfo", MLSV_YMD=ymd)
        try:
            for row in r["mealServiceDietInfo"][1]["row"]:
                if row["MMEAL_SC_CODE"] == "2":  # 중식
                    iso = d.isoformat()
                    meals[iso] = {
                        "calories": float(str(row.get("CAL_INFO", "0")).replace(" Kcal", "").strip() or 0),
                        "menu": clean_menu(row.get("DDISH_NM", "")),
                    }
        except (KeyError, IndexError):
            pass
        d += datetime.timedelta(days=1)
    return meals


def fetch_events(office, code):
    """NEIS 학사일정 → events. 토요휴업일은 목록에서 뺍니다."""
    found = {}
    d = SCHED_FROM
    while d < SCHED_TO:
        r = api(office, code, "SchoolSchedule", AA_FROM_YMD=d.strftime("%Y%m%d"),
                AA_TO_YMD=(d + datetime.timedelta(days=6)).strftime("%Y%m%d"))
        try:
            for row in r["SchoolSchedule"][1]["row"]:
                name = (row.get("EVENT_NM") or "").strip()
                if name in ("토요휴업일",):
                    continue
                found[(row["AA_YMD"], name)] = name
        except (KeyError, IndexError):
            pass
        d += datetime.timedelta(days=7)

    type_of = {
        "겨울방학식": "school", "종업식": "school", "개학식": "school",
        "겨울방학": "vacation", "학년말 방학": "vacation", "여름방학": "vacation",
        "재량휴업일": "holiday",
    }
    events = []
    for (ymd, name) in sorted(found):
        iso = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}"
        t = "holiday" if ("휴일" in name or "절" in name or "연휴" in name
                          or name in ("추석", "설날", "신정")) \
            else type_of.get(name, "school")
        e = {"date": iso, "title": name, "type": t}
        if e not in events:
            events.append(e)
    return events


VACATION_RUNS = ("겨울방학", "여름방학", "학년말 방학", "겨울방학식", "여름방학식")


def merge_events(existing, fetched, today):
    """직접 정리해 둔 일정은 지키고, NEIS 에서 새로 확인된 날짜만 덧붙입니다.

    - 지난 날짜는 넣지 않습니다.
    - 같은 날짜에 이미 일정이 있으면 그대로 둡니다. (직접 쓴 설명·구분이 우선)
    - 방학 기간은 매일 행이 오기 때문에 넣지 않습니다. (보드의 방학 카드가 보여 줌)
    """
    kept = [dict(e) for e in existing]
    have_dates = {e["date"] for e in kept}
    added = []

    for e in fetched:
        if e["date"] < today:
            continue
        if e["date"] in have_dates:
            continue
        if e["title"] in VACATION_RUNS:
            continue
        added.append(e)
        have_dates.add(e["date"])

    return sorted(kept + added, key=lambda x: x["date"]), added


def rebuild_encrypted():
    script = HERE / "build_encrypted.py"
    if not script.exists():
        return False
    proc = subprocess.run([sys.executable, str(script)], cwd=str(HERE),
                          capture_output=True, text=True)
    if proc.stdout.strip():
        print(proc.stdout.strip())
    if proc.returncode != 0:
        print(proc.stderr.strip(), file=sys.stderr)
    return proc.returncode == 0


def main():
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    office, code = school_codes(data)

    meals = fetch_meals(office, code)
    if meals:
        data["meals"] = meals
    events, added = merge_events(
        data.get("events", []),
        fetch_events(office, code),
        datetime.date.today().isoformat(),
    )
    data["events"] = events
    data["updatedAt"] = datetime.date.today().isoformat()
    DATA_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"급식 {len(meals)}일 갱신 · 학사일정 기존 {len(events) - len(added)}건 유지, "
          f"NEIS 에서 {len(added)}건 추가 → data.json")

    if rebuild_encrypted():
        print("암호화 번들까지 갱신했습니다. 배포는 ./deploy.sh")
    else:
        print("암호화 번들 갱신에 실패했습니다. ./deploy.sh 를 실행해 확인하세요.", file=sys.stderr)


if __name__ == "__main__":
    main()
