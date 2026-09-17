/**
 * UN 기구 공개 채용 · 학생 기록 API (Cloudflare Worker + D1)
 *
 * POST { action: "save", sid, name, pinHash, summary, state }  학생 기록 저장(학번+이름당 한 줄)
 * POST { action: "load", sid, name, pinHash }                  PIN이 맞으면 저장된 기록 반환
 * POST { action: "list", key }                                  교사 비밀번호(TEACHER_KEY)로 전체 기록 조회
 * POST { action: "resetPin", key, sid, name }                   교사가 학생 PIN 초기화
 */
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
    try {
      if (b.action === "save") return json(await save(env, b));
      if (b.action === "load") return json(await load(env, b));
      if (b.action === "list") return json(await list(env, b));
      if (b.action === "resetPin") return json(await resetPin(env, b));
      return json({ ok: false, error: "action" }, 400);
    } catch (err) {
      return json({ ok: false, error: "server", message: String(err && err.message || err) }, 500);
    }
  },
};

async function save(env, b) {
  const sid = clean(b.sid), name = clean(b.name), pin = clean(b.pinHash);
  if (!sid || !name || !pin) return { ok: false, error: "identity" };
  const row = await env.DB.prepare("SELECT pin FROM records WHERE sid = ? AND name = ?").bind(sid, name).first();
  if (row && row.pin && row.pin !== pin) return { ok: false, error: "pin" };
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
  const row = await env.DB.prepare("SELECT pin, state FROM records WHERE sid = ? AND name = ?").bind(sid, name).first();
  if (!row) return { ok: true, found: false };
  if (row.pin && row.pin !== pin) return { ok: false, error: "pin" };
  let state = null;
  try { state = JSON.parse(row.state || "null"); } catch { state = null; }
  return { ok: true, found: true, state };
}

async function list(env, b) {
  if (!env.TEACHER_KEY) return { ok: false, error: "nokey" };
  if (!sameKey(b.key, env.TEACHER_KEY)) return { ok: false, error: "key" };
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
  if (!env.TEACHER_KEY || !sameKey(b.key, env.TEACHER_KEY)) return { ok: false, error: "key" };
  const sid = clean(b.sid), name = clean(b.name);
  const r = await env.DB.prepare("UPDATE records SET pin = '' WHERE sid = ? AND name = ?").bind(sid, name).run();
  return { ok: true, changed: r.meta.changes };
}
