CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('assignment', 'exam')),
  due_at TEXT NOT NULL,            -- local Europe/Warsaw 'YYYY-MM-DDTHH:MM'
  occurrence_id TEXT,              -- '<sessionId>@<date>' when due at a class
  location TEXT,
  reminder_offsets TEXT NOT NULL,  -- JSON array of days before due
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX tasks_open ON tasks (done, due_at);

CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  offset_days INTEGER NOT NULL,
  fire_at INTEGER NOT NULL,        -- epoch ms, UTC
  sent_at INTEGER
);
CREATE INDEX reminders_due ON reminders (sent_at, fire_at);
CREATE INDEX reminders_task ON reminders (task_id);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_success_at INTEGER
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
