/**
 * UN 기구 공개 채용 · 학생 기록 저장소 (Google Apps Script)
 *
 * 이 코드는 교사의 구글 시트에 붙어서 동작합니다.
 * 학생 페이지가 보내는 기록을 「학생기록」 시트에 한 학생당 한 줄로 저장하고,
 * 교사 페이지(teacher.html)가 교사 비밀번호로 전체 기록을 읽어 갑니다.
 *
 * 설치 방법은 저장소의 README.md 「학생 기록 모으기」를 보세요.
 */

// ▼ 반드시 바꾸세요. 교사 페이지에 들어갈 때 쓰는 비밀번호입니다.
const TEACHER_KEY = "여기에-교사-비밀번호를-쓰세요";

const SHEET_NAME = "학생기록";
const HEAD = ["학번", "이름", "지원 기구", "진행 단계", "미션 완료", "지원서 접수", "최종 제출", "마지막 저장", "제출 텍스트", "PIN 확인값", "원본 데이터"];
const COL = { sid: 1, name: 2, pin: 10, state: 11 };
const MAX_CELL = 49000; // 구글 시트 셀 글자 수 한도(50,000) 안쪽

function doGet() {
  return out_({ ok: true, service: "un-recruit" });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (body.action === "save") return out_(save_(body));
    if (body.action === "load") return out_(load_(body));
    if (body.action === "list") return out_(list_(body));
    return out_({ ok: false, error: "action" });
  } catch (err) {
    return out_({ ok: false, error: "server", message: String(err) });
  }
}

function save_(b) {
  const sid = clean_(b.sid), name = clean_(b.name), pin = clean_(b.pinHash);
  if (!sid || !name || !pin) return { ok: false, error: "identity" };
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheet_();
    const row = findRow_(sh, sid, name);
    if (row) {
      const stored = String(sh.getRange(row, COL.pin).getValue() || "");
      if (stored && stored !== pin) return { ok: false, error: "pin" };
    }
    const s = b.summary || {};
    const values = [
      sid, name, clean_(s.org), clean_(s.stage), Number(s.missions) || 0,
      when_(s.docAt), when_(s.finalAt), when_(new Date().toISOString()),
      cut_(s.text), pin, cut_(JSON.stringify(b.state || {}))
    ].map(safe_);
    const target = row || sh.getLastRow() + 1;
    const range = sh.getRange(target, 1, 1, HEAD.length);
    range.setNumberFormat("@");
    range.setValues([values]);
    return { ok: true, savedAt: new Date().toISOString() };
  } finally {
    lock.releaseLock();
  }
}

function load_(b) {
  const sid = clean_(b.sid), name = clean_(b.name), pin = clean_(b.pinHash);
  if (!sid || !name || !pin) return { ok: false, error: "identity" };
  const sh = sheet_();
  const row = findRow_(sh, sid, name);
  if (!row) return { ok: true, found: false };
  const stored = String(sh.getRange(row, COL.pin).getValue() || "");
  if (stored && stored !== pin) return { ok: false, error: "pin" };
  let state = null;
  try { state = JSON.parse(String(sh.getRange(row, COL.state).getValue() || "null")); } catch (err) { state = null; }
  return { ok: true, found: true, state: state };
}

function list_(b) {
  if (!TEACHER_KEY || TEACHER_KEY === "여기에-교사-비밀번호를-쓰세요") return { ok: false, error: "nokey" };
  if (String(b.key || "") !== TEACHER_KEY) return { ok: false, error: "key" };
  const sh = sheet_();
  const n = sh.getLastRow();
  if (n < 2) return { ok: true, rows: [] };
  const v = sh.getRange(2, 1, n - 1, HEAD.length).getDisplayValues();
  const rows = v.filter(r => r[0] || r[1]).map(r => {
    let state = null;
    try { state = JSON.parse(r[COL.state - 1] || "null"); } catch (err) { state = null; }
    return { sid: r[0], name: r[1], org: r[2], stage: r[3], missions: Number(r[4]) || 0, docAt: r[5], finalAt: r[6], savedAt: r[7], text: r[8], state: state };
  });
  return { ok: true, rows: rows };
}

/* ── 도움 함수 ── */
function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}
function findRow_(sh, sid, name) {
  const n = sh.getLastRow();
  if (n < 2) return 0;
  const v = sh.getRange(2, 1, n - 1, 2).getDisplayValues();
  for (let i = 0; i < v.length; i++) {
    if (String(v[i][0]).trim() === sid && String(v[i][1]).trim() === name) return i + 2;
  }
  return 0;
}
function clean_(x) { return String(x == null ? "" : x).trim().slice(0, 200); }
function cut_(x) { x = String(x == null ? "" : x); return x.length > MAX_CELL ? x.slice(0, MAX_CELL) : x; }
// 학생 글이 =, +, -, @ 로 시작해도 수식으로 바뀌지 않게 합니다.
function safe_(x) { return typeof x === "string" && /^[=+\-@]/.test(x) ? "'" + x : x; }
function when_(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : Utilities.formatDate(d, "Asia/Seoul", "yyyy-MM-dd HH:mm");
}
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
