import { Hono } from "hono";
import scheduleData from "../data/schedule.json";
import { verifyAccess } from "./auth";
import { sendPush, type PushSubscriptionRecord, type VapidKeys } from "./push";
import {
  CLASS_ALERT_MODES,
  classesStartingSoon,
  DEFAULT_SETTINGS,
  humanDate,
  isQuarterHour,
  planReminders,
  relativeDay,
  summaryMessage,
  type Settings,
  type TaskKind,
} from "./reminders";
import {
  applyChange,
  applyChanges,
  dayNotes,
  findOccurrence,
  occurrences,
  semesterWeek,
  swapNotes,
  withRooms,
  type ClassChange,
  type Occurrence,
  type Schedule,
} from "./schedule";
import { addDays, daysBetween, isDate, isLocalDateTime, isTime, splitLocal, utcToZoned, zonedToUtc } from "./time";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** "1" skips the Access check; only for local dev via .dev.vars. */
  AUTH_DISABLED?: string;
}

const schedule = scheduleData as Schedule;
const TZ = schedule.timezone;
const subjectById = new Map(schedule.subjects.map((s) => [s.id, s]));

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", async (c, next) => {
  if (!(await verifyAccess(c.req.raw, c.env.ACCESS_TEAM_DOMAIN, c.env.ACCESS_AUD, c.env.AUTH_DISABLED))) {
    return c.json({ error: "Not signed in through Cloudflare Access." }, 401);
  }
  await next();
});

class BadRequest extends Error {}
const bad = (msg: string) => new BadRequest(msg);

app.onError((err, c) => {
  if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
  console.error(err);
  return c.json({ error: "Something went wrong on the server." }, 500);
});

// ---------- settings ----------

async function getSettings(db: D1Database): Promise<Settings> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'settings'").first<{ value: string }>();
  if (!row) return DEFAULT_SETTINGS;
  const saved = JSON.parse(row.value) as Partial<Settings>;
  return {
    reminderTime: saved.reminderTime ?? DEFAULT_SETTINGS.reminderTime,
    defaults: { ...DEFAULT_SETTINGS.defaults, ...saved.defaults },
    classAlerts: saved.classAlerts ?? DEFAULT_SETTINGS.classAlerts,
    morningSummary: saved.morningSummary === undefined ? DEFAULT_SETTINGS.morningSummary : saved.morningSummary,
  };
}

function parseOffsets(v: unknown): number[] {
  if (!Array.isArray(v)) throw bad("Reminders must be a list of day counts.");
  const out = v.map(Number);
  if (out.some((n) => !Number.isInteger(n) || n < 0 || n > 60)) {
    throw bad("Each reminder must be a whole number of days between 0 and 60.");
  }
  return [...new Set(out)].sort((a, b) => b - a);
}

// ---------- timetable rooms ----------

async function loadRooms(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db.prepare("SELECT session_id, room FROM session_rooms").all<{ session_id: string; room: string }>();
  return new Map(results.map((r) => [r.session_id, r.room]));
}

/** The timetable with the rooms changed in the app. */
async function timetable(db: D1Database): Promise<Schedule> {
  return withRooms(schedule, await loadRooms(db));
}

// ---------- class changes ----------

interface ChangeRow {
  occurrence_id: string;
  date: string;
  cancelled: number;
  room: string | null;
  start_time: string | null;
  end_time: string | null;
  note: string | null;
}

const toChange = (r: ChangeRow): ClassChange => ({
  occurrenceId: r.occurrence_id,
  cancelled: !!r.cancelled,
  room: r.room,
  start: r.start_time,
  end: r.end_time,
  note: r.note,
});

async function loadChanges(db: D1Database, from: string, to: string): Promise<Map<string, ClassChange>> {
  const { results } = await db
    .prepare("SELECT * FROM class_changes WHERE date BETWEEN ? AND ?")
    .bind(from, to)
    .all<ChangeRow>();
  return new Map(results.map((r) => [r.occurrence_id, toChange(r)]));
}

/** Classes in a date range, with the one-off changes made in the app. */
async function classesBetween(db: D1Database, from: string, to: string): Promise<Occurrence[]> {
  return applyChanges(occurrences(await timetable(db), from, to), await loadChanges(db, from, to));
}

/** One class by id, with its change applied; null if the timetable has no such class. */
async function classById(db: D1Database, id: string): Promise<Occurrence | null> {
  const occ = findOccurrence(await timetable(db), id);
  if (!occ) return null;
  const row = await db.prepare("SELECT * FROM class_changes WHERE occurrence_id = ?").bind(id).first<ChangeRow>();
  return applyChange(occ, row ? toChange(row) : undefined);
}

// ---------- tasks ----------

interface TaskRow {
  id: string;
  subject_id: string;
  title: string;
  notes: string | null;
  kind: TaskKind;
  due_at: string;
  occurrence_id: string | null;
  location: string | null;
  reminder_offsets: string;
  done: number;
  created_at: number;
  completed_at: number | null;
}

interface ReminderRow {
  task_id: string;
  offset_days: number;
  fire_at: number;
  sent_at: number | null;
}

function toTask(row: TaskRow, reminders: ReminderRow[]) {
  return {
    id: row.id,
    subjectId: row.subject_id,
    title: row.title,
    notes: row.notes ?? "",
    kind: row.kind,
    dueAt: row.due_at,
    occurrenceId: row.occurrence_id,
    location: row.location ?? "",
    reminderOffsets: JSON.parse(row.reminder_offsets) as number[],
    done: !!row.done,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    reminders: reminders
      .filter((r) => r.task_id === row.id)
      .map((r) => ({ offsetDays: r.offset_days, fireAt: r.fire_at, sentAt: r.sent_at })),
  };
}

async function loadTasks(db: D1Database, where: string, ...params: unknown[]) {
  const { results: rows } = await db
    .prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY due_at ASC`)
    .bind(...params)
    .all<TaskRow>();
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const { results: rems } = await db
    .prepare(
      `SELECT task_id, offset_days, fire_at, sent_at FROM reminders WHERE task_id IN (${ids.map(() => "?").join(",")}) ORDER BY fire_at`,
    )
    .bind(...ids)
    .all<ReminderRow>();
  return rows.map((r) => toTask(r, rems));
}

/** Resolves the `due` part of a request into a concrete local date-time (+ class link). */
async function resolveDue(
  db: D1Database,
  due: unknown,
): Promise<{ dueAt: string; occurrenceId: string | null; location: string | null }> {
  const d = due as { type?: string; occurrenceId?: string; at?: string } | undefined;
  if (d?.type === "class") {
    const occ = d.occurrenceId ? await classById(db, d.occurrenceId) : null;
    if (!occ) throw bad("That class doesn't take place on that day. Pick another class.");
    return { dueAt: `${occ.date}T${occ.start}`, occurrenceId: occ.id, location: occ.room ?? null };
  }
  if (d?.type === "date") {
    if (!isLocalDateTime(d.at)) throw bad("Enter the due date and time.");
    return { dueAt: d.at, occurrenceId: null, location: null };
  }
  throw bad("Choose when the task is due: at a class or on a date.");
}

async function rescheduleReminders(db: D1Database, taskId: string, now = Date.now()) {
  const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<TaskRow>();
  const stmts = [db.prepare("DELETE FROM reminders WHERE task_id = ? AND sent_at IS NULL").bind(taskId)];
  if (task && !task.done) {
    const settings = await getSettings(db);
    const planned = planReminders(task.due_at, JSON.parse(task.reminder_offsets), settings.reminderTime, TZ, now);
    for (const r of planned) {
      stmts.push(
        db
          .prepare(
            "INSERT INTO reminders (task_id, offset_days, fire_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM reminders WHERE task_id = ? AND offset_days = ? AND sent_at IS NOT NULL)",
          )
          .bind(taskId, r.offsetDays, r.fireAt, taskId, r.offsetDays),
      );
    }
  }
  await db.batch(stmts);
}

app.get("/api/bootstrap", async (c) => {
  const now = Date.now();
  const today = utcToZoned(now, TZ).date;
  return c.json({
    now,
    today,
    week: semesterWeek(schedule, today),
    semester: schedule.semester,
    subjects: schedule.subjects,
    sessions: (await timetable(c.env.DB)).sessions,
    pending: schedule.pending,
    settings: await getSettings(c.env.DB),
    links: await loadLinks(c.env.DB),
    absences: await loadAbsences(c.env.DB),
    subjectInfo: await loadSubjectInfo(c.env.DB),
    vapidPublicKey: c.env.VAPID_PUBLIC_KEY ?? null,
  });
});

app.get("/api/occurrences", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!isDate(from) || !isDate(to)) throw bad("Pass from and to as YYYY-MM-DD.");
  if (to < from || daysBetween(from, to) > 200) throw bad("The date range must be between 0 and 200 days.");
  return c.json({
    occurrences: await classesBetween(c.env.DB, from, to),
    dayNotes: dayNotes(schedule, from, to),
    swaps: swapNotes(schedule, from, to),
  });
});

app.get("/api/tasks", async (c) => {
  const recentDone = Date.now() - 30 * 86_400_000;
  return c.json({ tasks: await loadTasks(c.env.DB, "done = 0 OR completed_at > ?", recentDone) });
});

app.post("/api/tasks", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const subjectId = String(body.subjectId ?? "");
  if (!subjectById.has(subjectId)) throw bad("Pick a subject.");
  const title = String(body.title ?? "").trim();
  if (!title) throw bad("Give the task a title.");
  const kind: TaskKind = body.kind === "exam" ? "exam" : "assignment";
  const due = await resolveDue(c.env.DB, body.due);
  const settings = await getSettings(c.env.DB);
  const offsets = body.reminderOffsets === undefined ? settings.defaults[kind] : parseOffsets(body.reminderOffsets);
  const location = typeof body.location === "string" && body.location.trim() ? body.location.trim() : due.location;

  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO tasks (id, subject_id, title, notes, kind, due_at, occurrence_id, location, reminder_offsets, done, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(id, subjectId, title, String(body.notes ?? "").trim() || null, kind, due.dueAt, due.occurrenceId, location, JSON.stringify(offsets), now, now)
    .run();
  await rescheduleReminders(c.env.DB, id, now);
  const [task] = await loadTasks(c.env.DB, "id = ?", id);
  return c.json({ task }, 201);
});

app.patch("/api/tasks/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();
  if (!existing) return c.json({ error: "That task no longer exists." }, 404);
  const body = await c.req.json().catch(() => ({}));
  const next = { ...existing };
  const now = Date.now();

  if (body.subjectId !== undefined) {
    if (!subjectById.has(body.subjectId)) throw bad("Pick a subject.");
    next.subject_id = body.subjectId;
  }
  if (body.title !== undefined) {
    next.title = String(body.title).trim();
    if (!next.title) throw bad("Give the task a title.");
  }
  if (body.notes !== undefined) next.notes = String(body.notes).trim() || null;
  if (body.kind !== undefined) next.kind = body.kind === "exam" ? "exam" : "assignment";
  if (body.due !== undefined) {
    const due = await resolveDue(c.env.DB, body.due);
    next.due_at = due.dueAt;
    next.occurrence_id = due.occurrenceId;
    if (body.location === undefined) next.location = due.location;
  }
  if (body.location !== undefined) next.location = String(body.location).trim() || null;
  if (body.reminderOffsets !== undefined) next.reminder_offsets = JSON.stringify(parseOffsets(body.reminderOffsets));
  if (body.done !== undefined) {
    next.done = body.done ? 1 : 0;
    next.completed_at = body.done ? (existing.completed_at ?? now) : null;
  }

  await c.env.DB.prepare(
    `UPDATE tasks SET subject_id = ?, title = ?, notes = ?, kind = ?, due_at = ?, occurrence_id = ?, location = ?,
     reminder_offsets = ?, done = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(next.subject_id, next.title, next.notes, next.kind, next.due_at, next.occurrence_id, next.location, next.reminder_offsets, next.done, next.completed_at, now, id)
    .run();
  await rescheduleReminders(c.env.DB, id, now);
  const [task] = await loadTasks(c.env.DB, "id = ?", id);
  return c.json({ task });
});

app.delete("/api/tasks/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM reminders WHERE task_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

app.get("/api/settings", async (c) => c.json({ settings: await getSettings(c.env.DB) }));

app.put("/api/settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const current = await getSettings(c.env.DB);
  const next: Settings = {
    reminderTime: body.reminderTime ?? current.reminderTime,
    defaults: {
      assignment: body.defaults?.assignment !== undefined ? parseOffsets(body.defaults.assignment) : current.defaults.assignment,
      exam: body.defaults?.exam !== undefined ? parseOffsets(body.defaults.exam) : current.defaults.exam,
    },
    classAlerts: body.classAlerts ?? current.classAlerts,
    morningSummary: body.morningSummary !== undefined ? body.morningSummary : current.morningSummary,
  };
  if (!isTime(next.reminderTime)) throw bad("Reminder time must look like 18:00.");
  if (!CLASS_ALERT_MODES.includes(next.classAlerts)) throw bad("Choose which classes to be notified about.");
  if (next.morningSummary !== null && !isQuarterHour(String(next.morningSummary))) {
    throw bad("The morning summary time must be on a quarter hour, like 07:00 or 07:15.");
  }
  await c.env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify(next))
    .run();
  if (next.reminderTime !== current.reminderTime) {
    const { results } = await c.env.DB.prepare("SELECT id FROM tasks WHERE done = 0").all<{ id: string }>();
    for (const t of results) await rescheduleReminders(c.env.DB, t.id);
  }
  return c.json({ settings: next });
});

// ---------- class changes, absences, subject notes ----------

function optionalTime(v: unknown, label: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (!isTime(v)) throw bad(`${label} must look like 14:00.`);
  return v as string;
}

/** Moves open tasks due at a class along with a change to its start time or room. */
async function syncClassTasks(db: D1Database, before: Occurrence, after: Occurrence) {
  if (before.start === after.start && before.room === after.room) return;
  const { results } = await db
    .prepare("SELECT id, location FROM tasks WHERE occurrence_id = ? AND done = 0")
    .bind(after.id)
    .all<{ id: string; location: string | null }>();
  for (const t of results) {
    // Only follow the room if the task still has the class's room (not one typed in for an exam).
    const location = (t.location ?? "") === (before.room ?? "") ? (after.room ?? null) : t.location;
    await db
      .prepare("UPDATE tasks SET due_at = ?, location = ?, updated_at = ? WHERE id = ?")
      .bind(`${after.date}T${after.start}`, location, Date.now(), t.id)
      .run();
    if (before.start !== after.start) await rescheduleReminders(db, t.id);
  }
}

app.put("/api/classes/:id/change", async (c) => {
  const id = c.req.param("id");
  const base = findOccurrence(await timetable(c.env.DB), id);
  if (!base) return c.json({ error: "That class isn't in the timetable." }, 404);
  const before = (await classById(c.env.DB, id))!;
  const body = await c.req.json().catch(() => ({}));
  const room = String(body.room ?? "").trim().slice(0, 40);
  const start = optionalTime(body.start, "Start");
  const end = optionalTime(body.end, "End");
  if ((start ?? base.start) >= (end ?? base.end)) throw bad("The class has to end after it starts.");
  const row = {
    cancelled: body.cancelled ? 1 : 0,
    room: room && room !== base.room ? room : null,
    start_time: start && start !== base.start ? start : null,
    end_time: end && end !== base.end ? end : null,
    note: String(body.note ?? "").trim().slice(0, 200) || null,
  };
  if (!row.cancelled && !row.room && !row.start_time && !row.end_time && !row.note) {
    await c.env.DB.prepare("DELETE FROM class_changes WHERE occurrence_id = ?").bind(id).run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO class_changes (occurrence_id, date, cancelled, room, start_time, end_time, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(occurrence_id) DO UPDATE SET cancelled = excluded.cancelled, room = excluded.room,
         start_time = excluded.start_time, end_time = excluded.end_time, note = excluded.note, updated_at = excluded.updated_at`,
    )
      .bind(id, base.date, row.cancelled, row.room, row.start_time, row.end_time, row.note, Date.now())
      .run();
  }
  const after = (await classById(c.env.DB, id))!;
  await syncClassTasks(c.env.DB, before, after);
  return c.json({ occurrence: after });
});

app.delete("/api/classes/:id/change", async (c) => {
  const id = c.req.param("id");
  const before = await classById(c.env.DB, id);
  if (!before) return c.json({ error: "That class isn't in the timetable." }, 404);
  await c.env.DB.prepare("DELETE FROM class_changes WHERE occurrence_id = ?").bind(id).run();
  const after = findOccurrence(await timetable(c.env.DB), id)!;
  await syncClassTasks(c.env.DB, before, after);
  return c.json({ occurrence: after });
});

/** Changes the room of a class for every week; the room from schedule.json restores the timetable. */
app.put("/api/sessions/:id/room", async (c) => {
  const id = c.req.param("id");
  const session = schedule.sessions.find((x) => x.id === id);
  if (!session) return c.json({ error: "That class isn't in the timetable." }, 404);
  const body = await c.req.json().catch(() => ({}));
  const room = String(body.room ?? "").trim().slice(0, 40);
  if (!room) throw bad("Enter the room.");
  // Open tasks due at this class follow the room, as with a one-off change.
  const { results } = await c.env.DB.prepare("SELECT DISTINCT occurrence_id AS id FROM tasks WHERE occurrence_id LIKE ? AND done = 0")
    .bind(`${id}@%`)
    .all<{ id: string }>();
  const before = new Map<string, Occurrence>();
  for (const { id: occId } of results) {
    const o = await classById(c.env.DB, occId);
    if (o) before.set(occId, o);
  }
  if (room === (session.room ?? "")) {
    await c.env.DB.prepare("DELETE FROM session_rooms WHERE session_id = ?").bind(id).run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO session_rooms (session_id, room, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET room = excluded.room, updated_at = excluded.updated_at`,
    )
      .bind(id, room, Date.now())
      .run();
  }
  for (const [occId, o] of before) await syncClassTasks(c.env.DB, o, (await classById(c.env.DB, occId))!);
  return c.json({ sessions: (await timetable(c.env.DB)).sessions });
});

async function loadAbsences(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare("SELECT occurrence_id FROM absences").all<{ occurrence_id: string }>();
  return results.map((r) => r.occurrence_id);
}

app.put("/api/classes/:id/absence", async (c) => {
  const id = c.req.param("id");
  const occ = findOccurrence(schedule, id);
  if (!occ) return c.json({ error: "That class isn't in the timetable." }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (body.absent) {
    await c.env.DB.prepare("INSERT OR IGNORE INTO absences (occurrence_id, subject_id, created_at) VALUES (?, ?, ?)")
      .bind(id, occ.subject, Date.now())
      .run();
  } else {
    await c.env.DB.prepare("DELETE FROM absences WHERE occurrence_id = ?").bind(id).run();
  }
  return c.json({ absences: await loadAbsences(c.env.DB) });
});

interface SubjectInfo {
  notes: string;
  absenceLimit: number | null;
}

async function loadSubjectInfo(db: D1Database): Promise<Record<string, SubjectInfo>> {
  const { results } = await db
    .prepare("SELECT subject_id, notes, absence_limit FROM subject_info")
    .all<{ subject_id: string; notes: string | null; absence_limit: number | null }>();
  return Object.fromEntries(results.map((r) => [r.subject_id, { notes: r.notes ?? "", absenceLimit: r.absence_limit }]));
}

app.put("/api/subjects/:id/info", async (c) => {
  const id = c.req.param("id");
  if (!subjectById.has(id)) return c.json({ error: "That subject isn't in the timetable." }, 404);
  const body = await c.req.json().catch(() => ({}));
  const notes = String(body.notes ?? "").trim().slice(0, 4000) || null;
  let limit: number | null = null;
  if (body.absenceLimit !== undefined && body.absenceLimit !== null && body.absenceLimit !== "") {
    limit = Number(body.absenceLimit);
    if (!Number.isInteger(limit) || limit < 0 || limit > 50) throw bad("Allowed absences must be a whole number between 0 and 50.");
  }
  await c.env.DB.prepare(
    `INSERT INTO subject_info (subject_id, notes, absence_limit, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(subject_id) DO UPDATE SET notes = excluded.notes, absence_limit = excluded.absence_limit, updated_at = excluded.updated_at`,
  )
    .bind(id, notes, limit, Date.now())
    .run();
  return c.json({ info: { notes: notes ?? "", absenceLimit: limit } });
});

// ---------- subject links ----------

interface LinkRow {
  id: string;
  subject_id: string;
  url: string;
  title: string | null;
  created_at: number;
}

const toLink = (r: LinkRow) => ({ id: r.id, subjectId: r.subject_id, url: r.url, title: r.title ?? "" });

async function loadLinks(db: D1Database) {
  const { results } = await db.prepare("SELECT * FROM links ORDER BY created_at").all<LinkRow>();
  return results.map(toLink);
}

/** Accepts "github.com/x" as well as full URLs; only http(s). */
export function parseLinkUrl(v: unknown): string {
  let s = String(v ?? "").trim();
  if (!s) throw bad("Enter the link's address.");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw bad("That doesn't look like a web address.");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".")) {
    throw bad("That doesn't look like a web address.");
  }
  return url.href;
}

function parseLinkTitle(v: unknown): string | null {
  return String(v ?? "").trim().slice(0, 100) || null;
}

app.post("/api/links", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const subjectId = String(body.subjectId ?? "");
  if (!subjectById.has(subjectId)) throw bad("Pick a subject.");
  const row: LinkRow = {
    id: crypto.randomUUID(),
    subject_id: subjectId,
    url: parseLinkUrl(body.url),
    title: parseLinkTitle(body.title),
    created_at: Date.now(),
  };
  await c.env.DB.prepare("INSERT INTO links (id, subject_id, url, title, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(row.id, row.subject_id, row.url, row.title, row.created_at)
    .run();
  return c.json({ link: toLink(row) }, 201);
});

app.patch("/api/links/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM links WHERE id = ?").bind(id).first<LinkRow>();
  if (!row) return c.json({ error: "That link no longer exists." }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (body.url !== undefined) row.url = parseLinkUrl(body.url);
  if (body.title !== undefined) row.title = parseLinkTitle(body.title);
  await c.env.DB.prepare("UPDATE links SET url = ?, title = ? WHERE id = ?").bind(row.url, row.title, id).run();
  return c.json({ link: toLink(row) });
});

app.delete("/api/links/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM links WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// Favicons come through the Worker, so the app stays same-origin and they're cached for offline use.
app.get("/api/favicon", async (c) => {
  const host = c.req.query("host") ?? "";
  if (!/^[a-z0-9.-]{1,253}$/i.test(host) || !host.includes(".")) throw bad("Pass a host name.");
  const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`, {
    cf: { cacheEverything: true, cacheTtl: 7 * 86_400 },
  });
  // Google answers 404 with a generic globe for unknown sites; let the app show its own icon instead.
  if (!res.ok) return c.body(null, 404);
  return new Response(res.body, {
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "image/png",
      "Cache-Control": "private, max-age=604800",
    },
  });
});

// ---------- push ----------

function vapid(env: Env): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT };
}

app.post("/api/push/subscribe", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const endpoint = String(body.endpoint ?? "");
  const p256dh = String(body.keys?.p256dh ?? "");
  const auth = String(body.keys?.auth ?? "");
  if (!endpoint.startsWith("https://") || !p256dh || !auth) throw bad("The browser sent an incomplete subscription.");
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
  )
    .bind(endpoint, p256dh, auth, c.req.header("User-Agent") ?? null, Date.now())
    .run();
  return c.json({ ok: true });
});

app.post("/api/push/unsubscribe", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(String(body.endpoint ?? "")).run();
  return c.json({ ok: true });
});

app.post("/api/push/status", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const row = await c.env.DB.prepare("SELECT 1 AS ok FROM push_subscriptions WHERE endpoint = ?")
    .bind(String(body.endpoint ?? ""))
    .first();
  return c.json({ subscribed: !!row });
});

app.post("/api/push/test", async (c) => {
  const keys = vapid(c.env);
  if (!keys) return c.json({ error: "Push keys aren't configured on the server." }, 500);
  const sent = await broadcast(c.env.DB, keys, {
    title: "Notifications are on",
    body: "Task reminders will show up like this.",
    url: "/",
    tag: "test",
  });
  return c.json({ sent });
});

async function broadcast(db: D1Database, keys: VapidKeys, msg: Parameters<typeof sendPush>[1]): Promise<number> {
  const { results: subs } = await db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all<PushSubscriptionRecord>();
  let sent = 0;
  for (const sub of subs) {
    try {
      const status = await sendPush(sub, msg, keys);
      if (status === 404 || status === 410) {
        await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(sub.endpoint).run();
      } else if (status >= 200 && status < 300) {
        sent++;
        await db.prepare("UPDATE push_subscriptions SET last_success_at = ? WHERE endpoint = ?").bind(Date.now(), sub.endpoint).run();
      } else {
        console.warn(`push to ${new URL(sub.endpoint).host} failed with ${status}`);
      }
    } catch (err) {
      console.error("push failed", err);
    }
  }
  return sent;
}

// ---------- reminders cron ----------

export async function runDueReminders(env: Env, now = Date.now()) {
  const keys = vapid(env);
  const { results } = await env.DB.prepare(
    `SELECT r.id AS rid, t.* FROM reminders r JOIN tasks t ON t.id = r.task_id
     WHERE r.sent_at IS NULL AND r.fire_at <= ? AND t.done = 0 ORDER BY r.fire_at`,
  )
    .bind(now)
    .all<TaskRow & { rid: number }>();

  for (const row of results) {
    const [dueDate, dueTime] = splitLocal(row.due_at);
    const overdue = zonedToUtc(dueDate, dueTime, TZ) <= now;
    if (!overdue && keys) {
      const subject = subjectById.get(row.subject_id);
      const occ = row.occurrence_id ? await classById(env.DB, row.occurrence_id) : null;
      const when = relativeDay(dueDate, now, TZ);
      const at = occ
        ? `${occ.kind === "lab" ? "lab" : "lecture"} ${humanDate(dueDate)}, ${dueTime}`
        : `${humanDate(dueDate)}, ${dueTime}`;
      await broadcast(env.DB, keys, {
        title: row.kind === "exam" ? `Exam ${when}: ${row.title}` : `Due ${when}: ${row.title}`,
        body: `${subject?.short ?? row.subject_id}, ${at}${row.location ? `, room ${row.location}` : ""}`,
        url: `/?task=${row.id}`,
        tag: `task-${row.id}`,
      });
    }
    await env.DB.prepare("UPDATE reminders SET sent_at = ? WHERE id = ?").bind(now, row.rid).run();
  }
  return results.length;
}

// ---------- class alerts cron ----------

export async function runClassAlerts(env: Env, now = Date.now()) {
  const keys = vapid(env);
  if (!keys) return 0;
  const settings = await getSettings(env.DB);
  let sent = 0;
  const today = utcToZoned(now, TZ).date;
  const soon = classesStartingSoon(await classesBetween(env.DB, today, addDays(today, 1)), settings.classAlerts, now, TZ);
  for (const o of soon) {
    // Claim the class first, so a retried run doesn't notify twice.
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO class_alerts (occurrence_id, sent_at) VALUES (?, ?)")
      .bind(o.id, now)
      .run();
    if (!claim.meta.changes) continue;
    const mins = Math.round((zonedToUtc(o.date, o.start, TZ) - now) / 60_000);
    const name = subjectById.get(o.subject)?.name ?? o.subject;
    await broadcast(env.DB, keys, {
      title: `${o.mandatory ? "Mandatory" : "Not mandatory"} ${o.kind === "lab" ? "lab" : "lecture"} ${name} starts in ${mins} minutes`,
      body: o.remote ? "Remote" : o.room ? `Room ${o.room}` : "",
      url: `/?occ=${encodeURIComponent(o.id)}`,
      tag: `class-${o.id}`,
    });
    sent++;
  }
  await env.DB.prepare("DELETE FROM class_alerts WHERE sent_at < ?").bind(now - 30 * 86_400_000).run();
  return sent;
}

// ---------- morning summary cron ----------

/**
 * Sends the day's summary on the first run at or after the chosen time (within the hour,
 * so a missed run still sends it, but moving the time to earlier in the day doesn't).
 */
export async function runMorningSummary(env: Env, now = Date.now()) {
  const keys = vapid(env);
  const settings = await getSettings(env.DB);
  if (!keys || !settings.morningSummary) return false;
  const { date, time } = utcToZoned(now, TZ);
  const from = zonedToUtc(date, settings.morningSummary, TZ);
  if (now < from || now >= from + 3_600_000) return false;
  if (await env.DB.prepare("SELECT 1 FROM daily_summaries WHERE date = ?").bind(date).first()) return false;

  const classes = await classesBetween(env.DB, date, date);
  const { results: due } = await env.DB.prepare(
    "SELECT title, kind, due_at AS dueAt FROM tasks WHERE done = 0 AND due_at LIKE ? AND due_at >= ? ORDER BY due_at",
  )
    .bind(`${date}T%`, `${date}T${time}`)
    .all<{ title: string; kind: TaskKind; dueAt: string }>();
  const msg = summaryMessage(classes, due, (id) => subjectById.get(id)?.short ?? id);
  if (!msg) return false;

  const claim = await env.DB.prepare("INSERT OR IGNORE INTO daily_summaries (date, sent_at) VALUES (?, ?)").bind(date, now).run();
  if (!claim.meta.changes) return false;
  await broadcast(env.DB, keys, { ...msg, url: "/", tag: `summary-${date}` });
  await env.DB.prepare("DELETE FROM daily_summaries WHERE date < ?").bind(addDays(date, -30)).run();
  return true;
}

const handler: ExportedHandler<Env> = {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDueReminders(env));
    // The scheduled time is exactly on the quarter hour, unlike Date.now().
    ctx.waitUntil(runClassAlerts(env, event.scheduledTime));
    ctx.waitUntil(runMorningSummary(env, event.scheduledTime));
  },
};

export default handler;
