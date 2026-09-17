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
