import { addDays, daysBetween, startOfWeek, weekday } from "./time";

export type Kind = "lecture" | "lab";

export interface Subject {
  id: string;
  /** Very short label for narrow columns, e.g. 'APSI'. */
  abbr?: string;
  name: string;
  short: string;
}

export interface Session {
  id: string;
  subject: string;
  kind: Kind;
  remote?: boolean;
  /** ISO weekday, Monday = 1 */
  day: number;
  start: string;
  end: string;
  room?: string;
  teacher?: string;
  group?: string;
  /** 1 = every week (default), 2 = every other week counted from `anchor` */
  every?: 1 | 2;
  /** A date on which a biweekly session takes place. */
  anchor?: string;
  mandatory: boolean;
}

export interface Schedule {
  timezone: string;
  semester: {
    name: string;
    classesFrom: string;
    classesTo: string;
    examSession?: { from: string; to: string };
    breaks: { from: string; to: string; label: string }[];
    daysOff: { date: string; label: string }[];
    /** Days that run another weekday's timetable, e.g. a Thursday with Monday classes. */
    swaps?: { date: string; follows: number; label: string }[];
  };
  subjects: Subject[];
  sessions: Session[];
  pending: { subject: string; note: string }[];
}

export interface Occurrence {
  id: string;
  sessionId: string;
  subject: string;
  kind: Kind;
  remote: boolean;
  date: string;
  start: string;
  end: string;
  room?: string;
  teacher?: string;
  group?: string;
  mandatory: boolean;
  biweekly: boolean;
}

export interface DayNote {
  date: string;
  label: string;
}

/** Why there are no classes on `date`, or null if it is a normal teaching day. */
export function dayOffReason(s: Schedule, date: string): string | null {
  const sem = s.semester;
  const off = sem.daysOff.find((d) => d.date === date);
  if (off) return off.label;
  const br = sem.breaks.find((b) => date >= b.from && date <= b.to);
  if (br) return br.label;
  if (sem.examSession && date >= sem.examSession.from && date <= sem.examSession.to) return "Exam session";
  if (date < sem.classesFrom || date > sem.classesTo) return "No classes";
  return null;
}

function runsOn(s: Schedule, session: Session, date: string): boolean {
  const swap = s.semester.swaps?.find((x) => x.date === date);
  const effective = swap ? swap.follows : weekday(date);
  if (effective !== session.day) return false;
  if ((session.every ?? 1) === 2 && session.anchor) {
    // On a swapped day, use the week's real date of the followed weekday for the every-other-week check.
    const parityDate = swap ? addDays(startOfWeek(date), swap.follows - 1) : date;
    const weeks = Math.round(daysBetween(session.anchor, parityDate) / 7);
    return ((weeks % 2) + 2) % 2 === 0;
  }
  return true;
}

/** All class occurrences between `from` and `to` (inclusive), in chronological order. */
export function occurrences(s: Schedule, from: string, to: string): Occurrence[] {
  const out: Occurrence[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (dayOffReason(s, date)) continue;
    for (const ses of s.sessions) {
      if (!runsOn(s, ses, date)) continue;
      out.push({
        id: `${ses.id}@${date}`,
        sessionId: ses.id,
        subject: ses.subject,
        kind: ses.kind,
        remote: !!ses.remote,
        date,
        start: ses.start,
        end: ses.end,
        room: ses.room,
        teacher: ses.teacher,
        group: ses.group,
        mandatory: ses.mandatory,
        biweekly: (ses.every ?? 1) === 2,
      });
    }
  }
  return out.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

/** Weekdays in range that have no classes because of a break or day off (only within the semester). */
export function dayNotes(s: Schedule, from: string, to: string): DayNote[] {
  const out: DayNote[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (weekday(date) > 5) continue;
    const reason = dayOffReason(s, date);
    if (reason) out.push({ date, label: reason });
  }
  return out;
}

/** Days in range that follow another weekday's timetable. */
export function swapNotes(s: Schedule, from: string, to: string): DayNote[] {
  return (s.semester.swaps ?? []).filter((x) => x.date >= from && x.date <= to).map(({ date, label }) => ({ date, label }));
}

export function findOccurrence(s: Schedule, id: string): Occurrence | null {
  const [, date] = id.split("@");
  if (!date) return null;
  return occurrences(s, date, date).find((o) => o.id === id) ?? null;
}

/** 1-based teaching week of the semester, or null outside the teaching period. */
export function semesterWeek(s: Schedule, date: string): number | null {
  const { classesFrom, classesTo } = s.semester;
  if (date < classesFrom || date > classesTo) return null;
  const firstMonday = addDays(classesFrom, 1 - weekday(classesFrom));
  return Math.floor(daysBetween(firstMonday, date) / 7) + 1;
}
