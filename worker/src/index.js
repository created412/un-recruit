/**
 * UN 기구 공개 채용 · 학생 기록 API (Cloudflare Worker + D1)
 *
 * POST { action: "save", sid, name, pinHash, summary, state }  학생 기록 저장(학번+이름당 한 줄)
 * POST { action: "load", sid, name, pinHash }                  PIN이 맞으면 저장된 기록 반환
 * POST { action: "list", key }                                  교사 비밀번호(TEACHER_KEY)로 전체 기록 조회
 * POST { action: "resetPin", key, sid, name }                   교사가 학생 PIN 초기화
 * POST { action: "submit", sid, name, text }                    학생이 복사한 최종 결과물 제출(학생당 한 번, 수정 불가)
 * POST { action: "submissions", key }                           교사 비밀번호로 제출함 조회
 *
 * 보안: 학생별 PIN을 5번 틀리면 10분, 교사 비밀번호를 한 접속 주소에서 10번 틀리면 30분 잠급니다.
 */
const PIN_LIMIT = 5, PIN_LOCK_MS = 10 * 60e3;
const KEY_LIMIT = 10, KEY_LOCK_MS = 30 * 60e3;
const MAX_BODY = 300_000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS } });
const clean = x => String(x ?? "").trim().slice(0, 200);
// 교사 화면이 한국 시각 "YYYY-MM-DD HH:mm" 형식을 기대합니다.
const kst = iso => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
};
const sameKey = (a, b) => {
  a = String(a || ""); b = String(b || "");
  if (!a || !b || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method === "GET") return json({ ok: true, service: "un-recruit" });
    if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
    const raw = await req.text();
    if (raw.length > MAX_BODY) return json({ ok: false, error: "too_large" }, 413);
    let b;
    try { b = JSON.parse(raw); } catch { return json({ ok: false, error: "json" }, 400); }
    b.ip = req.headers.get("CF-Connecting-IP") || "unknown";
    try {
      if (b.action === "save") return json(await save(env, b));
      if (b.action === "load") return json(await load(env, b));
      if (b.action === "list") return json(await list(env, b));
      if (b.action === "resetPin") return json(await resetPin(env, b));
      if (b.action === "submit") return json(await submit(env, b));
      if (b.action === "submissions") return json(await submissions(env, b));
      return json({ ok: false, error: "action" }, 400);
    } catch (err) {
      console.error(err);
      return json({ ok: false, error: "server" }, 500);
    }
  },
};

async function save(env, b) {
  const sid = clean(b.sid), name = clean(b.name), pin = clean(b.pinHash);
  if (!sid || !name || !pin) return { ok: false, error: "identity" };
  const lockKey = `pin:${sid}|${name}`;
  if (await locked(env, lockKey)) return { ok: false, error: "locked" };
  const row = await env.DB.prepare("SELECT pin FROM records WHERE sid = ? AND name = ?").bind(sid, name).first();
  if (row && row.pin && row.pin !== pin) { await fail(env, lockKey, PIN_LIMIT, PIN_LOCK_MS); return { ok: false, error: "pin" }; }
  const s = b.summary || {};
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO records (sid, name, pin, org, stage, missions, doc_at, final_at, saved_at, text, state)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(sid, name) DO UPDATE SET pin = ?3, org = ?4, stage = ?5, missions = ?6, doc_at = ?7,
       final_at = ?8, saved_at = ?9, text = ?10, state = ?11`
  ).bind(sid, name, pin, clean(s.org), clean(s.stage), Number(s.missions) || 0,
    kst(s.docAt), kst(s.finalAt), kst(now), String(s.text || ""), JSON.stringify(b.state || {})).run();
  return { ok: true, savedAt: now };
}

async function load(env, b) {
  const sid = clean(b.sid), name = clean(b.name), pin = clean(b.pinHash);
  if (!sid || !name || !pin) return { ok: false, error: "identity" };
  const lockKey = `pin:${sid}|${name}`;
  if (await locked(env, lockKey)) return { ok: false, error: "locked" };
  const row = await env.DB.prepare("SELECT pin, state FROM records WHERE sid = ? AND name = ?").bind(sid, name).first();
  if (!row) return { ok: true, found: false };
  if (row.pin && row.pin !== pin) { await fail(env, lockKey, PIN_LIMIT, PIN_LOCK_MS); return { ok: false, error: "pin" }; }
  if (!row.pin) {
    // 교사가 PIN을 초기화한 뒤 처음 들어온 사람이 새 PIN을 정합니다. 동시에 두 명이 오면 먼저 온 쪽만 성공합니다.
    const claim = await env.DB.prepare("UPDATE records SET pin = ? WHERE sid = ? AND name = ? AND pin = ''").bind(pin, sid, name).run();
    if (!claim.meta.changes) return { ok: false, error: "pin" };
  }
  await clear(env, lockKey);
  let state = null;
  try { state = JSON.parse(row.state || "null"); } catch { state = null; }
  return { ok: true, found: true, state };
}

async function list(env, b) {
  if (!env.TEACHER_KEY) return { ok: false, error: "nokey" };
  if (!(await teacherOk(env, b))) return { ok: false, error: b.lockedOut ? "locked" : "key" };
  const { results } = await env.DB.prepare(
    "SELECT sid, name, org, stage, missions, doc_at, final_at, saved_at, text, state FROM records ORDER BY sid, name"
  ).all();
  const rows = results.map(r => {
    let state = null;
    try { state = JSON.parse(r.state || "null"); } catch { state = null; }
    return { sid: r.sid, name: r.name, org: r.org, stage: r.stage, missions: r.missions, docAt: r.doc_at, finalAt: r.final_at, savedAt: r.saved_at, text: r.text, state };
  });
  return { ok: true, rows };
}

async function resetPin(env, b) {
  if (!env.TEACHER_KEY || !(await teacherOk(env, b))) return { ok: false, error: b.lockedOut ? "locked" : "key" };
  const sid = clean(b.sid), name = clean(b.name);
  const r = await env.DB.prepare("UPDATE records SET pin = '' WHERE sid = ? AND name = ?").bind(sid, name).run();
  return { ok: true, changed: r.meta.changes };
}

/* ── 제출함 ── */
const MAX_SUBMIT = 60_000;
async function submit(env, b) {
  const sid = clean(b.sid), name = clean(b.name), text = String(b.text || "").trim();
  if (!sid || !name) return { ok: false, error: "identity" };
  if (text.length < 20) return { ok: false, error: "empty" };
  if (text.length > MAX_SUBMIT) return { ok: false, error: "too_large" };
  // 한 학생은 한 번만 낼 수 있고, 낸 글은 고칠 수 없습니다.
  const prev = await env.DB.prepare("SELECT id, created_at FROM submissions WHERE sid = ? AND name = ? LIMIT 1").bind(sid, name).first();
  if (prev) return { ok: false, error: "already", id: prev.id, submittedAt: kst(prev.created_at) };
  const now = new Date().toISOString();
  const r = await env.DB.prepare("INSERT INTO submissions (sid, name, text, created_at) VALUES (?, ?, ?, ?)")
    .bind(sid, name, text, now).run();
  return { ok: true, id: r.meta.last_row_id, submittedAt: kst(now) };
}
async function submissions(env, b) {
  if (!env.TEACHER_KEY) return { ok: false, error: "nokey" };
  if (!(await teacherOk(env, b))) return { ok: false, error: b.lockedOut ? "locked" : "key" };
  const { results } = await env.DB.prepare("SELECT id, sid, name, text, created_at FROM submissions ORDER BY id DESC").all();
  return { ok: true, rows: results.map(r => ({ id: r.id, sid: r.sid, name: r.name, text: r.text, submittedAt: kst(r.created_at) })) };
}

/* ── 시도 횟수 제한 ── */
async function locked(env, k) {
  const r = await env.DB.prepare("SELECT locked_until FROM attempts WHERE k = ?").bind(k).first();
  return !!(r && r.locked_until > Date.now());
}
async function fail(env, k, limit, lockMs) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO attempts (k, fails, locked_until) VALUES (?1, 1, 0)
     ON CONFLICT(k) DO UPDATE SET
       fails = CASE WHEN locked_until > 0 AND locked_until <= ?2 THEN 1 ELSE fails + 1 END,
       locked_until = CASE WHEN (CASE WHEN locked_until > 0 AND locked_until <= ?2 THEN 1 ELSE fails + 1 END) >= ?3 THEN ?4 ELSE 0 END`
  ).bind(k, now, limit, now + lockMs).run();
}
async function clear(env, k) {
  await env.DB.prepare("DELETE FROM attempts WHERE k = ?").bind(k).run();
}
async function teacherOk(env, b) {
  const k = `key:${b.ip}`;
  if (await locked(env, k)) { b.lockedOut = true; return false; }
  if (sameKey(b.key, env.TEACHER_KEY)) { await clear(env, k); return true; }
  await fail(env, k, KEY_LIMIT, KEY_LOCK_MS);
  return false;
}
