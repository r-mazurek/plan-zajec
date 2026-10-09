import { addDays, daysBetween, splitLocal, utcToZoned, zonedToUtc } from "./time";

export type TaskKind = "assignment" | "exam";

export interface Settings {
  reminderTime: string;
  defaults: Record<TaskKind, number[]>;
}

export const DEFAULT_SETTINGS: Settings = {
  reminderTime: "18:00",
  defaults: { assignment: [2, 1], exam: [5, 2] },
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
