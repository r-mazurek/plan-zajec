import { occurrences, type Occurrence, type Schedule } from "./schedule";
import { addDays, daysBetween, splitLocal, utcToZoned, zonedToUtc } from "./time";

export type TaskKind = "assignment" | "exam";

/** Which classes get a "starts in 15 minutes" notification. */
export type ClassAlerts = "all" | "mandatory" | "off";
export const CLASS_ALERT_MODES: ClassAlerts[] = ["all", "mandatory", "off"];
export const CLASS_ALERT_LEAD_MS = 15 * 60_000;

export interface Settings {
  reminderTime: string;
  defaults: Record<TaskKind, number[]>;
  classAlerts: ClassAlerts;
}

export const DEFAULT_SETTINGS: Settings = {
  reminderTime: "18:00",
  defaults: { assignment: [2, 1], exam: [5, 2] },
  classAlerts: "all",
};

export interface PlannedReminder {
  offsetDays: number;
  fireAt: number;
}

/**
 * Reminders fire `offset` days before the due date at the configured time of day.
 * Reminders that would land in the past, or at/after the deadline itself, are dropped.
 */
export function planReminders(
  dueAt: string,
  offsets: number[],
  reminderTime: string,
  tz: string,
  now: number,
): PlannedReminder[] {
  const [dueDate, dueTime] = splitLocal(dueAt);
  const dueUtc = zonedToUtc(dueDate, dueTime, tz);
  const unique = [...new Set(offsets)].filter((n) => Number.isInteger(n) && n >= 0 && n <= 60);
  return unique
    .map((offsetDays) => ({ offsetDays, fireAt: zonedToUtc(addDays(dueDate, -offsetDays), reminderTime, tz) }))
    .filter((r) => r.fireAt < dueUtc && r.fireAt > now)
    .sort((a, b) => a.fireAt - b.fireAt);
}

/** "today", "tomorrow", "in 3 days" relative to the local date of `now`. */
export function relativeDay(dueDate: string, now: number, tz: string): string {
  const today = utcToZoned(now, tz).date;
  const n = daysBetween(today, dueDate);
  if (n <= 0) return "today";
  if (n === 1) return "tomorrow";
  return `in ${n} days`;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function humanDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[(wd + 6) % 7]} ${d} ${MONTHS[m - 1]}`;
}

/**
 * Classes starting within the next 15 minutes (after `now`, up to and including now + 15 min).
 * The cron runs every 15 minutes on the quarter hour, so each class falls in exactly one run.
 */
export function classesStartingSoon(s: Schedule, mode: ClassAlerts, now: number, tz: string): Occurrence[] {
  if (mode === "off") return [];
  const from = utcToZoned(now, tz).date;
  const to = utcToZoned(now + CLASS_ALERT_LEAD_MS, tz).date;
  return occurrences(s, from, to).filter((o) => {
    if (mode === "mandatory" && !o.mandatory) return false;
    const lead = zonedToUtc(o.date, o.start, tz) - now;
    return lead > 0 && lead <= CLASS_ALERT_LEAD_MS;
  });
}
