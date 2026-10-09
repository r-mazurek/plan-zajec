// Date helpers. Dates are 'YYYY-MM-DD' strings, times are 'HH:MM' strings,
// both in the schedule's local time zone (Europe/Warsaw). Instants are epoch ms (UTC).

const DAY_MS = 86_400_000;

function parseDate(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return formatDate(parseDate(date) + days * DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
}

/** ISO weekday: Monday = 1 … Sunday = 7 */
export function weekday(date: string): number {
  const d = new Date(parseDate(date)).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: string): string {
  return addDays(date, 1 - weekday(date));
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

function zonedParts(ms: number, tz: string) {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    second: Number(parts.second),
  };
}

/** Offset of `tz` from UTC at instant `ms`, in ms (Warsaw summer time = +7_200_000). */
function offsetAt(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const [h, min] = p.time.split(":").map(Number);
  const asUtc = parseDate(p.date) + h * 3_600_000 + min * 60_000 + p.second * 1000;
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Local wall-clock date + time in `tz` → UTC instant. */
export function zonedToUtc(date: string, time: string, tz: string): number {
  const [h, m] = time.split(":").map(Number);
  const wall = parseDate(date) + h * 3_600_000 + m * 60_000;
  let utc = wall - offsetAt(wall, tz);
  const second = wall - offsetAt(utc, tz);
  if (second !== utc) utc = second;
  return utc;
}

/** UTC instant → local date and time in `tz`. */
export function utcToZoned(ms: number, tz: string): { date: string; time: string } {
  const { date, time } = zonedParts(ms, tz);
  return { date, time };
}

/** 'YYYY-MM-DDTHH:MM' local → [date, time] */
export function splitLocal(dt: string): [string, string] {
  const [d, t] = dt.split("T");
  return [d, (t ?? "00:00").slice(0, 5)];
}

export const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const isTime = (s: unknown): s is string => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const isLocalDateTime = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(s);
