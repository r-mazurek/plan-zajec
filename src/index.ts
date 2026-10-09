import { Hono } from "hono";
import scheduleData from "../data/schedule.json";
import { verifyAccess } from "./auth";
import { sendPush, type PushSubscriptionRecord, type VapidKeys } from "./push";
import { DEFAULT_SETTINGS, humanDate, planReminders, relativeDay, type Settings, type TaskKind } from "./reminders";
import { dayNotes, findOccurrence, occurrences, semesterWeek, swapNotes, type Schedule } from "./schedule";
import { daysBetween, isDate, isLocalDateTime, isTime, splitLocal, utcToZoned, zonedToUtc } from "./time";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

const schedule = scheduleData as Schedule;
const TZ = schedule.timezone;
const subjectById = new Map(schedule.subjects.map((s) => [s.id, s]));

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", async (c, next) => {
  if (!(await verifyAccess(c.req.raw, c.env.ACCESS_TEAM_DOMAIN, c.env.ACCESS_AUD))) {
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
function resolveDue(due: unknown): { dueAt: string; occurrenceId: string | null; location: string | null } {
  const d = due as { type?: string; occurrenceId?: string; at?: string } | undefined;
  if (d?.type === "class") {
    const occ = d.occurrenceId ? findOccurrence(schedule, d.occurrenceId) : null;
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
    sessions: schedule.sessions,
    pending: schedule.pending,
    settings: await getSettings(c.env.DB),
    vapidPublicKey: c.env.VAPID_PUBLIC_KEY ?? null,
  });
});

app.get("/api/occurrences", (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!isDate(from) || !isDate(to)) throw bad("Pass from and to as YYYY-MM-DD.");
  if (to < from || daysBetween(from, to) > 200) throw bad("The date range must be between 0 and 200 days.");
  return c.json({
    occurrences: occurrences(schedule, from, to),
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
  const due = resolveDue(body.due);
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
    const due = resolveDue(body.due);
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
  };
  if (!isTime(next.reminderTime)) throw bad("Reminder time must look like 18:00.");
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
      const occ = row.occurrence_id ? findOccurrence(schedule, row.occurrence_id) : null;
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

const handler: ExportedHandler<Env> = {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runDueReminders(env));
  },
};

export default handler;
