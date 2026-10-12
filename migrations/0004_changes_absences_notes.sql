-- One-off changes to a single class; NULL fields keep the timetable's value.
CREATE TABLE class_changes (
  occurrence_id TEXT PRIMARY KEY,  -- '<sessionId>@<date>'
  date TEXT NOT NULL,              -- the class's date, for range queries
  cancelled INTEGER NOT NULL DEFAULT 0,
  room TEXT,
  start_time TEXT,                 -- 'HH:MM'
  end_time TEXT,
  note TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX class_changes_date ON class_changes (date);

-- Classes marked as missed.
CREATE TABLE absences (
  occurrence_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Per-subject notes and the number of absences allowed.
CREATE TABLE subject_info (
  subject_id TEXT PRIMARY KEY,
  notes TEXT,
  absence_limit INTEGER,
  updated_at INTEGER NOT NULL
);

-- Days the morning summary was already sent.
CREATE TABLE daily_summaries (
  date TEXT PRIMARY KEY,           -- local 'YYYY-MM-DD'
  sent_at INTEGER NOT NULL
);
