-- 모의 UN 회의용 테이블
CREATE TABLE IF NOT EXISTS mun_students (
  sid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT DEFAULT '',
  keynote TEXT DEFAULT '',
  updated_at TEXT DEFAULT ''
);

-- 발언 신청 큐 (status: waiting | speaking | done)
CREATE TABLE IF NOT EXISTS mun_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sid TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT '',
  agenda TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'waiting',
  created_at TEXT NOT NULL,
  started_at TEXT DEFAULT '',
  ended_at TEXT DEFAULT '',
  seconds INTEGER DEFAULT 0
);

-- 발언 요지, 수정안, 표결 기록 (kind: speech | motion | vote)
CREATE TABLE IF NOT EXISTS mun_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sid TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT '',
  kind TEXT NOT NULL,
  text TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
