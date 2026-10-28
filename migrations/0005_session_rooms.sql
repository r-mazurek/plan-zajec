-- Rooms changed for every week of a timetable session; replaces the room in schedule.json.
CREATE TABLE session_rooms (
  session_id TEXT PRIMARY KEY,
  room TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
