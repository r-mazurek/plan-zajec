-- "Starts in 15 minutes" notifications already sent, so a retried cron run doesn't repeat them.
CREATE TABLE class_alerts (
  occurrence_id TEXT PRIMARY KEY,  -- '<sessionId>@<date>'
  sent_at INTEGER NOT NULL
);
