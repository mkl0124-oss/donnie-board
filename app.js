/* 우리 집 보드 — 학원·급식·숙제 보드
   board-version: 20261127173428
   데이터: 열 때마다 data.enc.json 을 직접 받아(data-enc.js 는 예비용) 비밀번호로 풀어서 씁니다.
   평문 데이터는 저장소에 올리지 않습니다. */
(function () {
  'use strict';

  var DAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
  var DAY_KEY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  var EN_KEY = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' };
  var HW_KEY = 'donnie.homework.v1';
  var TAB_KEY = 'donnie.tab';
  var KEY_STORE = 'donnie.key.v1';
  var DATA_REFRESH_MS = 5 * 60 * 1000;  /* 화면을 띄워 둔 동안 최신 데이터를 다시 확인하는 간격 */
  var DEFAULT_HW = [
    '학교 알림장 확인',
    '학원 가방 챙기기',
    '숙제 다 했는지 확인',
    '물통 · 실내화 챙기기',
    '내일 시간표 확인'
  ];

  var DATA = null;
  var weekOffset = 0;
  var MY_VER = '';            /* index.html 이 기억하는 코드 버전 */
  var refreshing = false;
  var refreshInFlight = null;
  var refreshNoteTimer = null;

  /* ---------- time helpers (Asia/Seoul) ---------- */

  function seoulNow() {
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
    });
    var p = {};
    fmt.formatToParts(new Date()).forEach(function (part) { p[part.type] = part.value; });
    var hour = parseInt(p.hour, 10); if (hour === 24) hour = 0;
    return {
      y: parseInt(p.year, 10), m: parseInt(p.month, 10), d: parseInt(p.day, 10),
      date: p.year + '-' + p.month + '-' + p.day,
      minutes: hour * 60 + parseInt(p.minute, 10),
      dow: EN_KEY[p.weekday] || 'sun'
    };
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function toISO(dt) { return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()); }
  function parseISO(s) { var a = s.split('-'); return new Date(+a[0], +a[1] - 1, +a[2]); }
  function daysBetween(fromISO, toISOStr) {
    var a = parseISO(fromISO), b = parseISO(toISOStr);
    return Math.round((b - a) / 86400000);
  }
  function isoToMinutes(t) { var a = t.split(':'); return (+a[0]) * 60 + (+a[1]); }
  function prettyTime(t) {
    var a = t.split(':'); var h = +a[0];
    var ampm = h < 12 ? '오전' : '오후';
    var hh = h % 12; if (hh === 0) hh = 12;
    return ampm + ' ' + hh + ':' + a[1];
  }
  function mdLabel(iso) {
    var dt = parseISO(iso);
    return (dt.getMonth() + 1) + '월 ' + dt.getDate() + '일';
  }
  function mdShort(iso) {
    var dt = parseISO(iso);
    return (dt.getMonth() + 1) + '/' + dt.getDate();
  }
  function ddayLabel(iso, today) {
    var n = daysBetween(today, iso);
    if (n === 0) return '오늘';
    return n > 0 ? 'D-' + n : 'D+' + (-n);
  }
  function mondayOf(iso, offsetWeeks) {
    var dt = parseISO(iso);
    var shift = (dt.getDay() + 6) % 7; /* 월=0 */
    dt.setDate(dt.getDate() - shift + offsetWeeks * 7);
    return dt;
  }

  /* ---------- 암호문 불러오기 (PBKDF2-HMAC-SHA256 + AES-256-GCM) ---------- */

  var ENC = null;      /* window.DONNIE_ENC: salt · iv · iterations · ciphertext */
  var AES_KEY = null;  /* 지금 화면에 쓰고 있는 복호화 키 */

  function b64ToBytes(b64) {
    var s = String(b64).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    var u = new Uint8Array(bytes), s = '';
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  }

  function cryptoReady() {
    return !!(window.crypto && window.crypto.subtle && window.TextDecoder && window.TextEncoder);
  }

  /* 비밀번호 -> 32바이트 AES 키 (data.enc 의 salt·iterations 그대로) */
  function deriveKey(password) {
    var pw = new TextEncoder().encode(password);
    return crypto.subtle.importKey('raw', pw, { name: 'PBKDF2' }, false, ['deriveKey'])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          {
            name: 'PBKDF2',
            salt: b64ToBytes(ENC.salt),
            iterations: (ENC && ENC.iterations) || 310000,
            hash: 'SHA-256'
          },
          base,
          { name: 'AES-GCM', length: 256 },
          true,          /* 이 기기에 키를 저장할 수 있도록 추출 가능하게 */
          ['decrypt']
        );
      });
  }

  function decryptWith(key) {
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(ENC.iv) },
      key,
      b64ToBytes(ENC.ciphertext)
    ).then(function (buf) {
      return JSON.parse(new TextDecoder('utf-8').decode(buf));
    });
  }

  /* "이 기기에서 잠금 해제 유지" — 키만 저장하고 데이터는 저장하지 않습니다. */
  function loadStoredKey() {
    try {
      var raw = localStorage.getItem(KEY_STORE);
      if (!raw) return null;
      var bytes = b64ToBytes(raw);
      return bytes.length === 32 ? bytes : null;
    } catch (e) { return null; }
  }

  function storeKey(key) {
    return crypto.subtle.exportKey('raw', key).then(function (raw) {
      try { localStorage.setItem(KEY_STORE, bytesToB64(raw)); } catch (e) {}
    }).catch(function () {});
  }

  function forgetKey() {
    try { localStorage.removeItem(KEY_STORE); } catch (e) {}
  }

  /* ---------- 최신 암호문 직접 받기 (정적 data-enc.js 는 실패할 때 쓰는 예비) ---------- */

  function validEnc(e) {
    return !!(e && e.salt && e.iv && e.ciphertext);
  }

  function encSig(e) {
    return e ? String(e.salt || '') + '|' + String(e.iv || '') + '|' + String(e.ciphertext || '') : '';
  }

  /* 캐시를 건너띄고 서버의 최신 암호문을 받아 옵니다. 실패하면 null. */
  function fetchEnc() {
    if (!window.fetch) return Promise.resolve(null);
    try {
      return fetch('./data.enc.json?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { return validEnc(j) ? j : null; })
        .catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function fetchLatestVersion() {
    if (!window.fetch) return Promise.resolve('');
    try {
      return fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { return (j && j.version) || ''; })
        .catch(function () { return ''; });
    } catch (e) { return Promise.resolve(''); }
  }

  /* 화면만 다시 그립니다. (보던 탭·스크롤 위치·체크 상태는 그대로) */
  function applyData(data) {
    T = seoulNow();
    DATA = data;
    renderAll();
  }

  /* 최신 암호문을 받아 내용이 바뀌었을 때만 다시 그립니다.
     결과: 'updated' | 'same' | 'fail' | 'locked' */
  function refreshData() {
    if (!AES_KEY || !DATA) return Promise.resolve('locked');
    if (refreshInFlight) return refreshInFlight;   /* 여러 번 불려도 요청은 한 번만 */

    var prev = ENC;
    refreshInFlight = fetchEnc().then(function (enc) {
      if (!enc) { ENC = prev; return 'fail'; }
      if (encSig(enc) === encSig(prev)) { ENC = prev; return 'same'; }
      ENC = enc;
      return decryptWith(AES_KEY).then(function (data) {
        applyData(data);
        return 'updated';
      }).catch(function () {
        ENC = prev;
        return 'fail';
      });
    }).catch(function () {
      ENC = prev;
      return 'fail';
    }).then(function (res) {
      refreshInFlight = null;
      return res;
    });
    return refreshInFlight;
  }

  var refreshBtn = null, refreshNoteEl = null;

  function setRefreshState(state, note) {
    var btn = refreshBtn;
    if (btn) {
      btn.classList.toggle('is-busy', state === 'busy');
      btn.classList.toggle('is-done', state === 'done');
      btn.classList.toggle('is-fail', state === 'fail');
      btn.setAttribute('aria-label', state === 'busy' ? '새로고침 중' : '새로고침');
    }
    if (refreshNoteTimer) { clearTimeout(refreshNoteTimer); refreshNoteTimer = null; }
    if (refreshNoteEl) {
      refreshNoteEl.textContent = note || '';
      refreshNoteEl.classList.toggle('show', !!note);
    }
    if (note) {
      refreshNoteTimer = setTimeout(function () {
        refreshNoteTimer = null;
        if (refreshNoteEl) {
          refreshNoteEl.textContent = '';
          refreshNoteEl.classList.remove('show');
        }
        if (btn) btn.classList.remove('is-done', 'is-fail');
      }, 2000);
    }
  }

  /* 코드가 바뀌었으면 캐시를 건너띄 주소로 한 번 다시 열립니다. */
  function goToVersion(v) {
    var u;
    try { u = new URL(location.href); } catch (e) { return false; }
    if (u.searchParams.get('v') === v) return false;
    u.searchParams.set('v', v);
    location.replace(u.toString());
    return true;
  }

  /* 헤더의 새로고침 버튼: 코드 판올림 → 다시 열기, 데이터만 바뀜 → 바로 다시 받기 */
  function refreshNow() {
    if (refreshing) return;
    refreshing = true;
    setRefreshState('busy');

    fetchLatestVersion().then(function (v) {
      if (v && MY_VER && v !== MY_VER && goToVersion(v)) return null;
      return refreshData();
    }).then(function (res) {
      refreshing = false;
      if (res === null) return;   /* 새 주소로 이동 중 */
      if (res === 'updated') setRefreshState('done', '업데이트됐어요');
      else if (res === 'same') setRefreshState('done', '최신 상태예요');
      else if (res === 'locked') setRefreshState('fail', '잠금을 먼저 풀어 주세요');
      else setRefreshState('fail', '연결을 확인해 주세요');
    }).catch(function () {
      refreshing = false;
      setRefreshState('fail', '연결을 확인해 주세요');
    });
  }

  /* ---------- rendering: hero ---------- */

  var T = seoulNow();

  function renderHero() {
    var dt = parseISO(T.date);
    document.getElementById('todayLabel').textContent =
      (dt.getMonth() + 1) + '월 ' + dt.getDate() + '일 ' + DAY_KO[dt.getDay()] + '요일';

    var vac = DATA.vacation || {};
    var pill = document.getElementById('ddayPill');
    var sub = [];

    if (vac.start) {
      var toStart = daysBetween(T.date, vac.start);
      var toEnd = daysBetween(T.date, vac.end || vac.start);
      if (toStart > 0) {
        pill.textContent = '겨울방학 D-' + toStart;
      } else if (toEnd >= 0) {
        pill.textContent = '겨울방학 D+' + (-toStart);
      } else {
        var next = nextEvents(1)[0];
        pill.textContent = next ? next.title + ' ' + ddayLabel(next.date, T.date) : '';
      }
    }

    var meal = !isWeekendToday() && DATA.meals && DATA.meals[T.date];
    var list = (DATA.academies && DATA.academies[T.dow]) || [];
    if (list.length) sub.push('학원 ' + list.length + '개');
    if (meal) sub.push('점심 ' + Math.round(meal.calories) + 'kcal');
    var exam = nextExam();
    if (exam) sub.push('시험 ' + ddayLabel(exam.date, T.date));
    document.getElementById('heroSub').textContent = sub.join(' · ');
  }

  /* ---------- rendering: today ---------- */

  function isWeekendToday() { return T.dow === 'sat' || T.dow === 'sun'; }

  function renderTodayMeal() {
    var ul = document.getElementById('todayMenu');
    var kcal = document.getElementById('todayKcal');
    var note = document.getElementById('todayMealNote');
    var isWeekend = isWeekendToday();
    var meal = !isWeekend && DATA.meals && DATA.meals[T.date];

    if (meal && meal.menu && meal.menu.length) {
      ul.innerHTML = meal.menu.map(function (m, i) {
        return '<li' + (i === 0 ? ' class="main"' : '') + '>' + esc(m) + '</li>';
      }).join('');
      kcal.textContent = Math.round(meal.calories) + ' kcal';
      note.textContent = '중식 · ' + mdLabel(T.date) + ' · 출처 NEIS 급식식단정보';
      return;
    }

    kcal.textContent = '';
    var vac = DATA.vacation || {};
    var inVac = vac.start && T.date >= vac.start && T.date <= (vac.end || vac.start);
    var next = nextMealDate(T.date);
    var msg = inVac ? '겨울방학이라 급식이 없어요 🎉'
      : isWeekend ? '주말이라 학교 급식이 없어요'
      : '오늘은 급식이 없어요';
    ul.innerHTML = '<li class="loading">' + msg + '</li>';
    if (next) {
      var nm = DATA.meals[next];
      note.textContent = '다음 급식 ' + mdLabel(next) + ' · ' + nm.menu.slice(0, 3).join(', ') +
        ' (' + Math.round(nm.calories) + 'kcal)';
    } else {
      note.textContent = '다음 급식표는 아직 올라오지 않았어요.';
    }
  }

  function nextMealDate(from) {
    var keys = Object.keys(DATA.meals || {}).sort();
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] < from) continue;
      var dow = parseISO(keys[i]).getDay();
      if (dow === 0 || dow === 6) continue; /* 주말 돌봄 급식은 건너뜀 */
      return keys[i];
    }
    return null;
  }

  function renderTodayAcademy() {
    var list = (DATA.academies && DATA.academies[T.dow]) || [];
    var ol = document.getElementById('todayTimeline');
    var note = document.getElementById('todayAcademyNote');
    document.getElementById('todayAcademyCount').textContent = list.length ? list.length + '개' : '';

    if (!list.length) {
      ol.innerHTML = '<li class="empty">오늘은 학원이 없는 날이에요 🍀</li>';
      note.textContent = '';
      return;
    }

    var now = T.minutes;
    var nextMarked = false;
    var nextItem = null;
    ol.innerHTML = list.map(function (s) {
      var st = isoToMinutes(s.start), en = isoToMinutes(s.end);
      var cls = 'tl-item', badge = '';
      if (now >= st && now < en) { cls += ' is-now'; badge = '<span class="badge">지금</span>'; }
      else if (now >= en) { cls += ' is-done'; }
      else if (!nextMarked) { nextMarked = true; nextItem = s; badge = '<span class="badge next">다음</span>'; }
      return '<li class="' + cls + '">' +
        '<span class="tl-dot"></span>' +
        '<span class="tl-time">' + esc(s.start) + '–' + esc(s.end) + '</span>' +
        '<span class="tl-body">' +
          '<span class="tl-name tag-' + esc(s.kind || 'sports') + '">' + esc(s.name) + badge + '</span>' +
          (s.place ? '<span class="tl-place">' + esc(s.place) + '</span>' : '') +
          (s.note ? '<span class="tl-place">' + esc(s.note) + '</span>' : '') +
        '</span></li>';
    }).join('');

    var first = list[0];
    if (now < isoToMinutes(first.start)) {
      note.textContent = '첫 일정 ' + prettyTime(first.start) + ' · ' + leftText(isoToMinutes(first.start) - now) + '남았어요';
    } else if (nextItem) {
      note.textContent = '다음은 ' + nextItem.name + ' ' + prettyTime(nextItem.start) + ' · ' +
        leftText(isoToMinutes(nextItem.start) - now) + '남았어요';
    } else {
      note.textContent = '오늘 학원 일정은 모두 끝났어요 🎉';
    }
  }

  function leftText(minsLeft) {
    var hh = Math.floor(minsLeft / 60), mm = minsLeft % 60;
    return (hh > 0 ? hh + '시간 ' : '') + (mm > 0 ? mm + '분 ' : '');
  }

  function renderDday() {
    var vac = DATA.vacation || {};
    var big = document.getElementById('ddayBig');
    var note = document.getElementById('ddayNote');
    if (!vac.start) { big.textContent = '-'; return; }

    var toStart = daysBetween(T.date, vac.start);
    var toEnd = daysBetween(T.date, vac.end || vac.start);
    if (toStart > 0) {
      big.textContent = '겨울방학까지 D-' + toStart;
      note.textContent = mdLabel(vac.start) + ' 시작 · ' + mdLabel(vac.end) + '까지' +
        (vac.startEvent ? ' (' + mdLabel(vac.startEvent) + ' ' + (vac.startEventName || '') + ')' : '');
    } else if (toEnd >= 0) {
      big.textContent = '겨울방학 D+' + (-toStart);
      note.textContent = '개학은 ' + mdLabel(addDays(vac.end, 1)) + '이에요';
    } else {
      big.textContent = '겨울방학 끝 · 개학했어요';
      note.textContent = '';
    }

    var ul = document.getElementById('nextEvents');
    var evs = nextEvents(3);
    ul.innerHTML = evs.map(function (e) {
      return '<li><span>' + esc(e.title) + '</span><span class="d">' +
        mdShort(e.date) + ' · ' + ddayLabel(e.date, T.date) + '</span></li>';
    }).join('');
  }

  function addDays(iso, n) {
    var dt = parseISO(iso); dt.setDate(dt.getDate() + n); return toISO(dt);
  }

  function nextEvents(n) {
    return (DATA.events || [])
      .filter(function (e) { return e.date >= T.date; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; })
      .slice(0, n);
  }

  /* ---------- rendering: timetable ---------- */

  function renderTimetable() {
    var wrap = document.getElementById('timetable');
    var mon = mondayOf(T.date, 0);
    var order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    var labels = ['월', '화', '수', '목', '금', '토'];
    var html = order.map(function (key, i) {
      var dt = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
      var iso = toISO(dt);
      var isToday = iso === T.date;
      var list = (DATA.academies && DATA.academies[key]) || [];
      var body = list.length ? list.map(function (s) {
        return '<div class="slot">' +
          '<span class="slot-time">' + esc(s.start) + '–' + esc(s.end) + '</span>' +
          '<span class="slot-name ' + esc(s.kind || '') + '">' + esc(s.name) +
          (s.place ? ' <span class="muted">· ' + esc(s.place) + '</span>' : '') +
          (s.note ? ' <span class="muted">· ' + esc(s.note) + '</span>' : '') +
          '</span></div>';
      }).join('') : '<p class="day-rest">학원 없음</p>';
      return '<section class="day-card' + (isToday ? ' today' : '') + '">' +
        '<header class="day-head"><span class="day-name">' + labels[i] + '요일</span>' +
        '<span class="day-date">' + mdShort(iso) + '</span>' +
        (isToday ? '<span class="badge">오늘</span>' : '') + '</header>' + body + '</section>';
    }).join('');
    wrap.innerHTML = html;
    document.getElementById('timetableNote').textContent =
      (DATA.academyInfo && DATA.academyInfo['비고']) || '';
  }

  /* ---------- rendering: meals ---------- */

  function renderMeals() {
    var mon = mondayOf(T.date, weekOffset);
    var fri = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 4);
    document.getElementById('weekRange').textContent =
      mdShort(toISO(mon)) + ' ~ ' + mdShort(toISO(fri));

    var box = document.getElementById('weekMeals');
    var html = '';
    for (var i = 0; i < 5; i++) {
      var dt = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
      var iso = toISO(dt);
      var meal = DATA.meals && DATA.meals[iso];
      var isToday = iso === T.date;
      html += '<article class="meal-card' + (isToday ? ' today' : '') + '">' +
        '<header class="meal-head"><span class="meal-day">' +
        DAY_KO[dt.getDay()] + '요일 <span class="muted">' + mdShort(iso) + '</span>' +
        (isToday ? ' <span class="badge">오늘</span>' : '') + '</span>' +
        (meal ? '<span class="meal-cal">' + Math.round(meal.calories) + ' kcal</span>' : '') +
        '</header>' +
        (meal ? '<p class="meal-items">' + meal.menu.map(esc).join(' · ') + '</p>'
              : '<p class="meal-none">급식 정보가 없어요 (휴일이거나 미게시)</p>') +
        '</article>';
    }
    box.innerHTML = html;

    renderMonth();
  }

  function renderMonth() {
    var monthPrefix = T.date.slice(0, 7);
    document.getElementById('monthTitle').textContent = (+monthPrefix.slice(5, 7)) + '월 전체 급식';
    var keys = Object.keys(DATA.meals || {}).filter(function (k) {
      return k.slice(0, 7) === monthPrefix;
    }).sort();
    var box = document.getElementById('monthMeals');
    if (!keys.length) {
      box.innerHTML = '<p class="empty">이 달 급식 정보가 아직 없어요.</p>';
    } else {
      box.innerHTML = keys.map(function (k) {
        var dt = parseISO(k);
        var meal = DATA.meals[k];
        var dow = dt.getDay();
        var weekend = dow === 0 || dow === 6;
        return '<details class="month-row" data-date="' + k + '">' +
          '<summary><span class="md">' + (dt.getMonth() + 1) + '/' + dt.getDate() +
          ' (' + DAY_KO[dow] + ')</span>' +
          '<span class="preview">' + esc(meal.menu.slice(0, 4).join(', ')) + '</span>' +
          '<span class="mc">' + Math.round(meal.calories) + 'kcal</span></summary>' +
          '<div class="body">' + meal.menu.map(esc).join(' · ') +
          (weekend ? '<br><span class="muted">주말 급식(돌봄) 식단이에요.</span>' : '') +
          '</div></details>';
      }).join('');
    }
    document.getElementById('mealSourceNote').textContent =
      '급식 데이터: NEIS 교육정보 개방 포털 · 최종 반영 ' + (DATA.updatedAt || '-') +
      ' · 주말 식단은 돌봄 급식입니다.';
  }

  /* ---------- rendering: homework ---------- */

  function loadHW() {
    try {
      var raw = localStorage.getItem(HW_KEY);
      if (!raw) {
        var adopted = adoptPreviousHW();
        if (adopted) return adopted;
        return seedHW();
      }
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return seedHW();
      return arr;
    } catch (e) { return seedHW(); }
  }

  /* 예전 이름으로 저장해 둔 숙제 목록이 이 기기에 있으면 새 키로 옮깁니다. (한 번만) */
  function adoptPreviousHW() {
    try {
      var legacy = null;
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k === HW_KEY || !/homework\.v1$/.test(k)) continue;
        legacy = k;
        break;
      }
      if (!legacy) return null;
      var arr = JSON.parse(localStorage.getItem(legacy) || 'null');
      if (!Array.isArray(arr) || !arr.length) return null;
      localStorage.setItem(HW_KEY, JSON.stringify(arr));
      localStorage.removeItem(legacy);
      return arr;
    } catch (e) { return null; }
  }

  function isNoticeItem(it) { return it && String(it.id).charAt(0) === 'n'; }

  /* 알림장에서 온 숙제·준비물은 보드 데이터의 notices.items 에서 자동으로 채우고,
     알림장에서 빠진 항목은 지웁니다. 손으로 적은 항목과 체크 상태는 그대로 둡니다. */
  function mergeNoticeHW() {
    var src = (DATA.notices && DATA.notices.items) || [];
    var byId = {};
    src.forEach(function (it) { byId[it.id] = it; });

    HW = HW.filter(function (it) { return !(isNoticeItem(it) && !byId[it.id]); });
    HW = HW.map(function (it) {
      if (isNoticeItem(it) && byId[it.id]) {
        return { id: it.id, text: byId[it.id].text, done: !!it.done };
      }
      return it;
    });
    var have = {};
    HW.forEach(function (it) { have[it.id] = true; });
    src.forEach(function (it) {
      if (!have[it.id]) HW.push({ id: it.id, text: it.text, done: false });
    });
    HW.sort(function (a, b) {
      var an = isNoticeItem(a) ? 0 : 1, bn = isNoticeItem(b) ? 0 : 1;
      return an - bn;
    });
    saveHW(HW);
  }
  function seedHW() {
    var arr = DEFAULT_HW.map(function (t, i) {
      return { id: 'd' + i, text: t, done: false };
    });
    saveHW(arr);
    return arr;
  }
  function saveHW(arr) {
    try { localStorage.setItem(HW_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  var HW = loadHW();

  function renderHW() {
    var ul = document.getElementById('hwList');
    if (!HW.length) {
      ul.innerHTML = '<li class="empty">할 일을 적어 보세요. 아래에서 추가할 수 있어요.</li>';
    } else {
      ul.innerHTML = HW.map(function (it) {
        var fromNotice = isNoticeItem(it);
        return '<li class="hw-item' + (it.done ? ' done' : '') + (fromNotice ? ' from-notice' : '') +
          '" data-id="' + esc(it.id) + '">' +
          '<button type="button" class="hw-check" aria-label="완료 표시" data-act="toggle" data-id="' + esc(it.id) + '"></button>' +
          '<span class="hw-text">' + esc(it.text) +
            (fromNotice ? '<span class="hw-src">알림장</span>' : '') +
          '</span>' +
          '<button type="button" class="hw-del" aria-label="삭제" data-act="del" data-id="' + esc(it.id) + '">×</button>' +
          '</li>';
      }).join('');
    }
    var done = HW.filter(function (i) { return i.done; }).length;
    document.getElementById('hwProgress').textContent = done + ' / ' + HW.length;
    document.getElementById('hwBar').style.width = HW.length ? (done / HW.length * 100) + '%' : '0%';
  }

  function bindHW() {
    document.getElementById('hwForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = document.getElementById('hwInput');
      var text = input.value.trim();
      if (!text) return;
      HW.push({ id: 'h' + Date.now(), text: text, done: false });
      saveHW(HW); input.value = ''; renderHW();
      input.focus();
    });

    document.getElementById('hwList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      if (btn.getAttribute('data-act') === 'toggle') {
        HW = HW.map(function (i) { return i.id === id ? { id: i.id, text: i.text, done: !i.done } : i; });
      } else {
        HW = HW.filter(function (i) { return i.id !== id; });
      }
      saveHW(HW); renderHW();
    });

    document.getElementById('hwClearDone').addEventListener('click', function () {
      HW = HW.filter(function (i) { return !i.done; });
      saveHW(HW); renderHW();
    });
  }

  /* ---------- rendering: events ---------- */

  function nextExam() {
    var arr = (DATA.exams || []).filter(function (x) {
      return (x.endDate || x.date) >= T.date;
    }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return arr[0] || null;
  }

  function renderExams() {
    var card = document.getElementById('examCard');
    var empty = document.getElementById('examEmpty');
    if (!card) return;
    var first = nextExam();
    var exams = first ? [first] : [];

    if (!exams.length) {
      card.hidden = true;
      if (empty) empty.hidden = false;
      return;
    }

    var e = exams[0];
    card.hidden = false;
    if (empty) empty.hidden = true;

    document.getElementById('examTitle').textContent =
      e.title + ' · ' + mdLabel(e.date) + (e.endDate ? '~' + mdLabel(e.endDate) : '');
    document.getElementById('examDday').textContent = ddayLabel(e.date, T.date);
    document.getElementById('examList').innerHTML = (e.items || []).map(function (it) {
      return '<li>' +
        (it.when ? '<span class="exam-when">' + esc(it.when) + '</span>' : '') +
        '<span class="exam-subject">' + esc(it.subject) + '</span>' +
        (it.scope ? '<span class="exam-scope">' + esc(it.scope) + '</span>' : '') +
        '</li>';
    }).join('');
    document.getElementById('examNote').textContent = e.note || '';
  }

  function renderEvents() {
    var ul = document.getElementById('eventList');
    var evs = (DATA.events || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    if (!evs.length) { ul.innerHTML = '<li class="empty">학사일정이 없어요.</li>'; return; }
    ul.innerHTML = evs.map(function (e) {
      var past = e.date < T.date;
      return '<li class="event-item ' + esc(e.type || '') + (past ? ' past' : '') + '">' +
        '<span class="ed">' + mdLabel(e.date) + '</span>' +
        '<span class="et"><span class="ettitle">' + esc(e.title) + '</span>' +
          (e.detail ? '<span class="edetail">' + esc(e.detail) + '</span>' : '') + '</span>' +
        '<span class="dday">' + (past ? '' : ddayLabel(e.date, T.date)) + '</span></li>';
    }).join('');
    document.getElementById('eventSourceNote').textContent =
      '학사일정은 NEIS 학사일정과 학급 알림장을 함께 봐서 정리했어요.';
  }

  /* ---------- misc ---------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function bindTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
    function activate(name) {
      tabs.forEach(function (t) {
        var on = t.getAttribute('data-tab') === name;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      document.querySelectorAll('.tab-panel').forEach(function (p) {
        p.classList.toggle('is-active', p.id === 'panel-' + name);
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      try { localStorage.setItem(TAB_KEY, name); } catch (e) {}
    }
    tabs.forEach(function (t) {
      t.addEventListener('click', function () { activate(t.getAttribute('data-tab')); });
    });
    var saved = null;
    try { saved = localStorage.getItem(TAB_KEY); } catch (e) {}
    if (saved && document.getElementById('panel-' + saved)) activate(saved);
  }

  function bindWeekNav() {
    document.getElementById('prevWeek').addEventListener('click', function () {
      weekOffset--; renderMeals();
    });
    document.getElementById('nextWeek').addEventListener('click', function () {
      weekOffset++; renderMeals();
    });
  }

  function renderAll() {
    var foot = document.getElementById('footNote');
    if (foot) foot.textContent = '급식·학사일정: NEIS 교육정보 개방 포털 · 최종 반영 ' +
      (DATA.updatedAt || '-') + ' · 학원 시간표: 보호자 제공';
    renderHero();
    renderTodayMeal();
    renderTodayAcademy();
    renderDday();
    renderTimetable();
    renderMeals();
    mergeNoticeHW();
    renderHW();
    renderExams();
    renderEvents();
  }

  function fail(err) {
    showLock('보드를 열지 못했어요: ' + (err && err.message ? err.message : '알 수 없는 오류'), true);
    console.error(err);
  }

  /* ---------- 잠금 화면 ---------- */

  var lockEl = null, lockForm = null, lockInput = null, lockErrorEl = null,
      rememberEl = null, submitEl = null;
  var dayTimer = null;

  function setLockMessage(text, info) {
    if (!lockErrorEl) return;
    lockErrorEl.textContent = text || '';
    lockErrorEl.classList.toggle('show', !!text);
    lockErrorEl.classList.toggle('is-info', !!info);
  }

  function lockBusy(busy) {
    if (submitEl) { submitEl.disabled = busy; submitEl.textContent = busy ? '여는 중…' : '열기'; }
    if (lockInput) lockInput.disabled = busy;
  }

  function showLock(message, info) {
    DATA = null;
    AES_KEY = null;
    document.body.classList.add('locked');
    if (lockEl) lockEl.hidden = false;
    setLockMessage(message || '', info);
    if (lockInput) {
      lockInput.value = '';
      lockInput.disabled = false;
      try { lockInput.focus(); } catch (e) {}
    }
    if (submitEl) { submitEl.disabled = false; submitEl.textContent = '열기'; }
  }

  function showBoard(data) {
    T = seoulNow();
    DATA = data;
    document.body.classList.remove('locked');
    if (lockEl) lockEl.hidden = true;
    setLockMessage('');
    renderAll();
    if (!dayTimer) {
      dayTimer = setInterval(function () {
        var now = seoulNow();
        if (now.date !== T.date) { T = now; renderAll(); }
      }, 60000);
    }
    try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch (e) {}
  }

  function tryUnlock(password) {
    return deriveKey(password).then(function (key) {
      return decryptWith(key).then(function (data) {
        return { key: key, data: data };
      });
    });
  }

  function bindLock() {
    lockEl = document.getElementById('lockScreen');
    lockForm = document.getElementById('lockForm');
    lockInput = document.getElementById('lockInput');
    lockErrorEl = document.getElementById('lockError');
    rememberEl = document.getElementById('rememberDevice');
    submitEl = document.getElementById('lockSubmit');
    var lockNow = document.getElementById('lockNow');

    if (lockForm) {
      lockForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var pw = ((lockInput && lockInput.value) || '').trim();
        if (!pw) { setLockMessage('비밀번호를 입력해 주세요'); return; }
        setLockMessage('');
        lockBusy(true);
        tryUnlock(pw).then(function (res) {
          lockBusy(false);
          if (rememberEl && rememberEl.checked) storeKey(res.key);
          else forgetKey();
          showBoard(res.data);
        }).catch(function (err) {
          console.error(err);
          lockBusy(false);
          forgetKey();
          setLockMessage('비밀번호가 맞지 않아요');
          if (lockInput) {
            lockInput.value = '';
            try { lockInput.focus(); } catch (e2) {}
          }
        });
      });
    }

    if (lockNow) {
      lockNow.addEventListener('click', function () {
        forgetKey();
        showLock('잠갔어요. 다시 열려면 비밀번호를 입력해 주세요.', true);
      });
    }
  }

  function boot() {
    window.addEventListener('error', function (ev) {
      var sub = document.getElementById('heroSub');
      if (sub && !sub.textContent && !document.body.classList.contains('locked')) {
        sub.textContent = '화면 오류: ' + (ev.message || '알 수 없음');
      }
    });

    bindTabs();
    bindWeekNav();
    bindHW();
    bindLock();

    refreshBtn = document.getElementById('refreshNow');
    refreshNoteEl = document.getElementById('refreshNote');
    var verMeta = document.querySelector('meta[name="board-version"]');
    MY_VER = verMeta ? (verMeta.getAttribute('content') || '') : '';
    if (refreshBtn) refreshBtn.addEventListener('click', refreshNow);

    if (!cryptoReady()) {
      showLock('이 환경에서는 잠금을 열 수 없어요. 인터넷 주소로 열어 주세요.', true);
      return;
    }

    /* 앱으로 돌아왔을 때: 날짜가 바뀌었으면 다시 그리고, 데이터도 최신으로 맞춥니다. */
    function wake() {
      if (!DATA) return;
      var now = seoulNow();
      if (now.date !== T.date) { T = now; renderAll(); }
      refreshData();
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) wake();
    });
    window.addEventListener('pageshow', function () { wake(); });
    window.addEventListener('focus', function () { wake(); });

    /* 화면을 띄워 둔 동안에도 가끔 새 데이터를 확인합니다. (숨겨져 있을 땐 쉼) */
    setInterval(function () {
      if (!document.hidden && DATA) refreshData();
    }, DATA_REFRESH_MS);

    var fallback = validEnc(window.DONNIE_ENC) ? window.DONNIE_ENC : null;
    var stored = loadStoredKey();

    /* 열 때마다 서버의 최신 암호문을 먼저 받아 옵니다. (오프라인·실패 시 정적 data-enc.js) */
    fetchEnc().then(function (fresh) {
      ENC = fresh || fallback;
      if (!ENC) { showLock('보드 데이터를 찾지 못했어요. 잠시 뒤 다시 열어 주세요.'); return; }
      if (!stored) { showLock(''); return; }

      return crypto.subtle.importKey('raw', stored, { name: 'AES-GCM' }, true, ['decrypt'])
        .then(function (key) {
          return decryptWith(key).then(function (data) { return { key: key, data: data }; });
        })
        .then(function (res) { AES_KEY = res.key; showBoard(res.data); })
        .catch(function () { forgetKey(); showLock(''); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
