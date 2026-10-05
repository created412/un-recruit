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
      if (b.action === "munSave") return json(await munSave(env, b));
      if (b.action === "munHand") return json(await munHand(env, b));
      if (b.action === "munCancel") return json(await munCancel(env, b));
      if (b.action === "munFeed") return json(await munFeed(env, b));
      if (b.action === "munChair") return json(await munChair(env, b));
      if (b.action === "munNote") return json(await munNote(env, b));
      if (b.action === "munReport") return json(await munReport(env, b));
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

/* ── 모의 UN 회의 ──
 * 의장(교사)만 TEACHER_KEY로 큐를 조작합니다. 학생 요청에는 비밀번호가 없습니다(수업 중 사용).
 */
const MAX_TEXT = 4000;
const text_ = x => String(x ?? "").trim().slice(0, MAX_TEXT);

async function munSave(env, b) {
  const sid = clean(b.sid), name = clean(b.name);
  if (!sid || !name) return { ok: false, error: "identity" };
  await env.DB.prepare(
    `INSERT INTO mun_students (sid, name, role, keynote, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(sid) DO UPDATE SET name = ?2, role = ?3, keynote = ?4, updated_at = ?5`
  ).bind(sid, name, clean(b.role), text_(b.keynote), new Date().toISOString()).run();
  return { ok: true };
}

async function munHand(env, b) {
  const sid = clean(b.sid), name = clean(b.name);
  if (!sid || !name) return { ok: false, error: "identity" };
  const dup = await env.DB.prepare("SELECT id FROM mun_queue WHERE sid = ? AND status IN ('waiting','speaking')").bind(sid).first();
  if (dup) return { ok: true, id: dup.id, already: true };
  const r = await env.DB.prepare("INSERT INTO mun_queue (sid, name, role, agenda, status, created_at) VALUES (?, ?, ?, ?, 'waiting', ?)")
    .bind(sid, name, clean(b.role), clean(b.agenda), new Date().toISOString()).run();
  return { ok: true, id: r.meta.last_row_id };
}

async function munCancel(env, b) {
  const sid = clean(b.sid);
  await env.DB.prepare("DELETE FROM mun_queue WHERE sid = ? AND status = 'waiting'").bind(sid).run();
  return { ok: true };
}

async function munFeed(env) {
  const q = await env.DB.prepare(
    "SELECT id, sid, name, role, agenda, status, created_at, started_at FROM mun_queue WHERE status IN ('waiting','speaking') ORDER BY id"
  ).all();
  const counts = await env.DB.prepare(
    "SELECT sid, name, COUNT(*) AS n, SUM(seconds) AS secs FROM mun_queue WHERE status = 'done' GROUP BY sid, name"
  ).all();
  const notes = await env.DB.prepare(
    "SELECT sid, name, role, kind, text, created_at FROM mun_events ORDER BY id DESC LIMIT 40"
  ).all();
  return {
    ok: true,
    speaking: q.results.find(r => r.status === "speaking") || null,
    queue: q.results.filter(r => r.status === "waiting"),
    counts: counts.results,
    notes: notes.results,
  };
}

async function munChair(env, b) {
  if (!env.TEACHER_KEY || !sameKey(b.key, env.TEACHER_KEY)) return { ok: false, error: "key" };
  const now = new Date().toISOString();
  if (b.op === "call") {
    await env.DB.prepare("UPDATE mun_queue SET status = 'done', ended_at = ?, seconds = ? WHERE status = 'speaking'")
      .bind(now, Number(b.seconds) || 0).run();
    await env.DB.prepare("UPDATE mun_queue SET status = 'speaking', started_at = ? WHERE id = ?").bind(now, Number(b.id) || 0).run();
    return { ok: true };
  }
  if (b.op === "end") {
    await env.DB.prepare("UPDATE mun_queue SET status = 'done', ended_at = ?, seconds = ? WHERE status = 'speaking'")
      .bind(now, Number(b.seconds) || 0).run();
    return { ok: true };
  }
  if (b.op === "drop") {
    await env.DB.prepare("DELETE FROM mun_queue WHERE id = ? AND status = 'waiting'").bind(Number(b.id) || 0).run();
    return { ok: true };
  }
  if (b.op === "clear") {
    await env.DB.prepare("DELETE FROM mun_queue").run();
    return { ok: true };
  }
  if (b.op === "reset") { // 회의 전체 초기화 (기조연설 원고는 남김)
    await env.DB.prepare("DELETE FROM mun_queue").run();
    await env.DB.prepare("DELETE FROM mun_events").run();
    return { ok: true };
  }
  return { ok: false, error: "op" };
}

async function munNote(env, b) {
  const sid = clean(b.sid), name = clean(b.name), t = text_(b.text);
  if (!sid || !name || !t) return { ok: false, error: "empty" };
  await env.DB.prepare("INSERT INTO mun_events (sid, name, role, kind, text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(sid, name, clean(b.role), clean(b.kind) || "speech", t, new Date().toISOString()).run();
  return { ok: true };
}

async function munReport(env, b) {
  if (!env.TEACHER_KEY || !sameKey(b.key, env.TEACHER_KEY)) return { ok: false, error: "key" };
  const s = await env.DB.prepare("SELECT sid, name, role, keynote, updated_at FROM mun_students ORDER BY sid").all();
  const q = await env.DB.prepare("SELECT sid, name, role, agenda, status, created_at, started_at, ended_at, seconds FROM mun_queue ORDER BY id").all();
  const e = await env.DB.prepare("SELECT sid, name, role, kind, text, created_at FROM mun_events ORDER BY id").all();
  return { ok: true, students: s.results, queue: q.results, events: e.results };
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
