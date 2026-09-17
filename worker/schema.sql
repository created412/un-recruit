CREATE TABLE IF NOT EXISTS records (
  sid TEXT NOT NULL,
  name TEXT NOT NULL,
  pin TEXT NOT NULL,
  org TEXT DEFAULT '',
  stage TEXT DEFAULT '',
  missions INTEGER DEFAULT 0,
  doc_at TEXT DEFAULT '',
  final_at TEXT DEFAULT '',
  saved_at TEXT DEFAULT '',
  text TEXT DEFAULT '',
  state TEXT DEFAULT '{}',
  PRIMARY KEY (sid, name)
);

-- 틀린 PIN·교사 비밀번호 시도 횟수 (무차별 대입 방지)
CREATE TABLE IF NOT EXISTS attempts (
  k TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);

-- 학생이 복사해서 붙여 넣은 최종 결과물 (다시 내면 줄이 하나 더 쌓입니다)
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sid TEXT NOT NULL,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
