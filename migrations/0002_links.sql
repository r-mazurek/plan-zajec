CREATE TABLE links (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,                      -- shown instead of the host name when set
  created_at INTEGER NOT NULL
);
CREATE INDEX links_subject ON links (subject_id, created_at);
