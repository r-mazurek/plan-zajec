// Plan zajęć — single-page app, no build step.
const TZ = "Europe/Warsaw";
const HOUR_START = 8;
const HOUR_END = 20;

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- dates (all local Europe/Warsaw, 'YYYY-MM-DD' / 'HH:MM') ----------
const DAY = 86_400_000;
const parseD = (d) => {
  const [y, m, dd] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, dd);
};
const fmtD = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => fmtD(parseD(d) + n * DAY);
const weekday = (d) => {
  const w = new Date(parseD(d)).getUTCDay();
  return w === 0 ? 7 : w;
};
const startOfWeek = (d) => addDays(d, 1 - weekday(d));
const daysBetween = (a, b) => Math.round((parseD(b) - parseD(a)) / DAY);
const toMin = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WD_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayNum = (d) => Number(d.slice(8, 10));
const human = (d) => `${WD[weekday(d) - 1]} ${dayNum(d)} ${MON[Number(d.slice(5, 7)) - 1]}`;

const nowFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function nowLocal() {
  const p = Object.fromEntries(nowFmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}`;
  return { date, time, stamp: `${date}T${time}` };
}
const nextWeekday = (d) => (weekday(d) > 5 ? addDays(d, 8 - weekday(d)) : d);
function shiftWeekday(d, dir) {
  let x = addDays(d, dir);
  while (weekday(x) > 5) x = addDays(x, dir);
  return x;
}

function relDay(date) {
  const n = daysBetween(nowLocal().date, date);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  if (n < 0) return `${-n} days ago`;
  return `in ${n} days`;
}

// ---------- state ----------
const state = {
  boot: null,
  occ: [],
  occById: new Map(),
  notes: new Map(),
  swaps: new Map(),
  tasks: [],
  view: "plan", // narrow layout: 'plan' | 'tasks'
  mode: "day", // narrow plan: 'day' | 'week'
  date: null,
  week: null,
  group: "date",
  showDone: false,
};
const wide = matchMedia("(min-width: 960px)");
const subj = (id) => state.boot.subjects.find((s) => s.id === id) ?? { id, name: id, short: id };

// ---------- api ----------
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

async function load() {
  const boot = await api("/api/bootstrap");
  state.boot = boot;
  const sem = boot.semester;
  const today = nowLocal().date;
  let from = startOfWeek(sem.classesFrom < today ? sem.classesFrom : today);
  let to = sem.examSession?.to ?? sem.classesTo;
  if (to < addDays(today, 60)) to = addDays(today, 60);
  if (daysBetween(from, to) > 200) from = addDays(to, -200);
  const [o] = await Promise.all([api(`/api/occurrences?from=${from}&to=${to}`), loadTasks()]);
  state.occ = o.occurrences;
  state.occById = new Map(o.occurrences.map((x) => [x.id, x]));
  state.notes = new Map(o.dayNotes.map((n) => [n.date, n.label]));
  state.swaps = new Map((o.swaps ?? []).map((n) => [n.date, n.label]));
  if (!state.date) {
    state.date = nextWeekday(today);
    state.week = startOfWeek(state.date);
  }
}

async function loadTasks() {
  state.tasks = (await api("/api/tasks")).tasks;
}

// ---------- task helpers ----------
const dueDate = (t) => t.dueAt.slice(0, 10);
const dueTime = (t) => t.dueAt.slice(11, 16);
const openTasks = () => state.tasks.filter((t) => !t.done);
const kindLabel = (o) => (o.remote ? "Remote" : o.kind === "lab" ? "Lab" : "Lecture");

function dueLabel(t) {
  const occ = t.occurrenceId && state.occById.get(t.occurrenceId);
  if (occ) return `${kindLabel(occ).toLowerCase()} ${human(occ.date)}, ${occ.start}`;
  return `${human(dueDate(t))}, ${dueTime(t)}`;
}

function tasksForOcc(id) {
  return openTasks().filter((t) => t.occurrenceId === id);
}

function looseTasksOn(date) {
  return openTasks().filter((t) => dueDate(t) === date && !(t.occurrenceId && state.occById.has(t.occurrenceId)));
}

// ---------- rendering ----------
function render() {
  const app = $("#app");
  const side = $(".side");
  const sideScroll = side ? side.scrollTop : 0;
  const isWide = wide.matches;
  app.className = `app ${isWide ? "is-wide" : "is-narrow"}`;
  if (isWide) {
    app.innerHTML = `${headerWide()}<div class="layout"><main class="main">${weekView()}${pendingNote()}</main><aside class="side">${tasksPanel()}</aside></div>`;
    const s = $(".side");
    if (s) s.scrollTop = sideScroll;
  } else {
    const main =
      state.view === "tasks" ? tasksPanel() : state.mode === "day" ? dayView() + pendingNote() : weekView() + pendingNote();
    app.innerHTML = `${headerNarrow()}<main class="main">${main}</main>${bottomNav()}`;
  }
  updateNow();
}

function semesterWeekLabel(date) {
  const sem = state.boot.semester;
  if (date < sem.classesFrom || date > sem.classesTo) {
    if (sem.examSession && date >= sem.examSession.from && date <= sem.examSession.to) return "Exam session";
    return "Outside the teaching period";
  }
  const first = startOfWeek(sem.classesFrom);
  return `Week ${Math.floor(daysBetween(first, date) / 7) + 1}`;
}

const icon = {
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/></svg>',
};

function headerNarrow() {
  const plan = state.view === "plan";
  const date = plan && state.mode === "week" ? state.week : state.date;
  return `
  <header class="top">
    <div class="top-row">
      <p class="term">${esc(semesterWeekLabel(plan ? date : nowLocal().date))}</p>
      <div class="top-actions">
        ${plan ? `<div class="seg" role="group" aria-label="Plan view">
          <button class="${state.mode === "day" ? "on" : ""}" data-action="mode" data-mode="day" aria-pressed="${state.mode === "day"}">Day</button>
          <button class="${state.mode === "week" ? "on" : ""}" data-action="mode" data-mode="week" aria-pressed="${state.mode === "week"}">Week</button>
        </div>` : ""}
        <button class="icon-btn" data-action="settings" aria-label="Settings">${icon.gear}</button>
      </div>
    </div>
    ${plan && state.mode === "day" ? weekStrip() : ""}
    ${plan && state.mode === "week" ? weekNav() : ""}
  </header>`;
}

function headerWide() {
  return `
  <header class="top top-wide">
    <div class="top-row">
      <div class="wide-title">
        <h1>${esc(weekRange(state.week))}</h1>
        <p class="term">${esc(semesterWeekLabel(addDays(state.week, 2)))}</p>
      </div>
      <div class="top-actions">
        <div class="week-nav">
          <button class="icon-btn" data-action="week" data-dir="-1" aria-label="Previous week">${icon.left}</button>
          <button class="ghost" data-action="today">Today</button>
          <button class="icon-btn" data-action="week" data-dir="1" aria-label="Next week">${icon.right}</button>
        </div>
        <button class="icon-btn" data-action="settings" aria-label="Settings">${icon.gear}</button>
      </div>
    </div>
  </header>`;
}

function weekRange(monday) {
  const fri = addDays(monday, 4);
  const m1 = MON_LONG[Number(monday.slice(5, 7)) - 1];
  const m2 = MON_LONG[Number(fri.slice(5, 7)) - 1];
  return m1 === m2 ? `${dayNum(monday)}–${dayNum(fri)} ${m1}` : `${dayNum(monday)} ${m1} – ${dayNum(fri)} ${m2}`;
}

function weekNav() {
  return `<div class="week-nav-row">
    <button class="icon-btn" data-action="week" data-dir="-1" aria-label="Previous week">${icon.left}</button>
    <button class="ghost week-label" data-action="today">${esc(weekRange(state.week))}</button>
    <button class="icon-btn" data-action="week" data-dir="1" aria-label="Next week">${icon.right}</button>
  </div>`;
}

function weekStrip() {
  const monday = startOfWeek(state.date);
  const today = nowLocal().date;
  let cells = "";
  for (let i = 0; i < 5; i++) {
    const d = addDays(monday, i);
    const due = openTasks().some((t) => dueDate(t) === d);
    const off = state.notes.has(d);
    cells += `<button class="strip-day ${d === state.date ? "on" : ""} ${d === today ? "today" : ""} ${off ? "off" : ""}"
      data-action="day" data-date="${d}" aria-pressed="${d === state.date}" aria-label="${WD_LONG[i]} ${dayNum(d)}${due ? ", tasks due" : ""}">
      <span class="sd-wd">${WD[i]}</span><span class="sd-num">${dayNum(d)}</span><span class="sd-dot ${due ? "show" : ""}"></span>
    </button>`;
  }
  return `<div class="strip">
    <button class="icon-btn small" data-action="shift-week" data-dir="-1" aria-label="Previous week">${icon.left}</button>
    <div class="strip-days">${cells}</div>
    <button class="icon-btn small" data-action="shift-week" data-dir="1" aria-label="Next week">${icon.right}</button>
  </div>`;
}

function bottomNav() {
  const n = openTasks().length;
  return `<nav class="bottom" aria-label="Sections">
    <button class="${state.view === "plan" ? "on" : ""}" data-action="view" data-view="plan">${icon.calendar}<span>Plan</span></button>
    <button class="${state.view === "tasks" ? "on" : ""}" data-action="view" data-view="tasks">${icon.list}<span>Tasks${n ? ` <b class="count">${n}</b>` : ""}</span></button>
    <button class="add" data-action="new-task">${icon.plus}<span>Add task</span></button>
  </nav>`;
}

// ----- day view -----
function dayView() {
  const d = state.date;
  const occ = state.occ.filter((o) => o.date === d);
  const note = state.notes.get(d);
  const loose = looseTasksOn(d);
  let summary;
  if (note) summary = `No classes: ${note}`;
  else if (!occ.length) summary = "No classes";
  else {
    const mins = occ.reduce((n, o) => n + toMin(o.end) - toMin(o.start), 0);
    const mandMins = occ.filter((o) => o.mandatory).reduce((n, o) => n + toMin(o.end) - toMin(o.start), 0);
    summary = `${occ.length} ${occ.length === 1 ? "class" : "classes"}, ${occ[0].start}–${occ[occ.length - 1].end}, ${fmtHours(mins)} in total${mandMins ? `, ${fmtHours(mandMins)} mandatory` : ""}`;
  }
  if (state.swaps.has(d)) summary = `${state.swaps.get(d)}. ${summary}`;
  return `<section class="day" data-swipe>
    <h1 class="day-title">
      <span class="dt-num">${dayNum(d)}</span>
      <span class="dt-words"><span class="dt-wd">${WD_LONG[weekday(d) - 1]}</span><span class="dt-mon">${MON_LONG[Number(d.slice(5, 7)) - 1]} · ${esc(relDay(d))}</span></span>
    </h1>
    <p class="day-summary">${esc(summary)}</p>
    ${loose.length ? `<div class="due-list"><h2 class="due-head">Due this day</h2>${loose.map(dueChip).join("")}</div>` : ""}
    ${occ.length ? timeline([d], true) : emptyDay(d, note)}
  </section>`;
}

function emptyDay(d, note) {
  const next = state.occ.find((o) => o.date > d);
  return `<div class="empty-day"><p>${note ? "Enjoy the day off." : "Nothing on the plan."}</p>
    ${next ? `<button class="next-class" data-action="day" data-date="${next.date}">Next class: ${esc(subj(next.subject).short)}, ${esc(human(next.date))}, ${next.start}</button>` : ""}
  </div>`;
}

function fmtHours(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function dueChip(t) {
  return `<button class="due-chip ${t.kind}" data-action="edit" data-id="${t.id}">
    <span class="dc-time">${dueTime(t)}</span>
    <span class="dc-body"><span class="dc-title">${t.kind === "exam" ? '<span class="tag-exam">Exam</span>' : ""}${esc(t.title)}</span>
    <span class="dc-sub">${esc(subj(t.subjectId).short)}${t.location ? `, ${esc(t.location)}` : ""}</span></span>
  </button>`;
}

// ----- timeline (shared by day and week) -----
function lanes(list) {
  const sorted = [...list].sort((a, b) => toMin(a.start) - toMin(b.start));
  const out = [];
  let group = [];
  let groupEnd = -1;
  const flush = () => {
    const laneEnds = [];
    for (const o of group) {
      let lane = laneEnds.findIndex((end) => end <= toMin(o.start));
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = toMin(o.end);
      out.push({ o, lane });
    }
    const n = laneEnds.length;
    for (const x of out.slice(out.length - group.length)) x.lanes = n;
    group = [];
  };
  for (const o of sorted) {
    if (group.length && toMin(o.start) >= groupEnd) flush();
    group.push(o);
    groupEnd = Math.max(groupEnd, toMin(o.end));
  }
  if (group.length) flush();
  return out;
}

function timeline(dates, detailed) {
  let from = HOUR_START;
  let to = HOUR_END;
  if (detailed) {
    const day = state.occ.filter((o) => dates.includes(o.date));
    from = Math.min(...day.map((o) => Math.floor(toMin(o.start) / 60)));
    to = Math.max(...day.map((o) => Math.ceil(toMin(o.end) / 60)));
  }
  const hours = [];
  for (let h = from; h < to; h++) hours.push(h);
  const today = nowLocal().date;
  const cols = dates
    .map((d) => {
      const items = lanes(state.occ.filter((o) => o.date === d));
      const note = state.notes.get(d);
      return `<div class="tl-col ${d === today ? "is-today" : ""}" data-date="${d}">
        ${note && !detailed ? `<div class="tl-off"><span>${esc(note)}</span></div>` : ""}
        ${items.map(({ o, lane, lanes: n }) => block(o, lane, n, detailed, from)).join("")}
        ${d === today ? '<div class="now-line" aria-hidden="true"></div>' : ""}
      </div>`;
    })
    .join("");
  return `<div class="tl ${detailed ? "tl-day" : "tl-week"}" style="--hours:${to - from}" data-from="${from}" data-to="${to}">
    <div class="tl-hours" aria-hidden="true">${hours.map((h) => `<span>${String(h).padStart(2, "0")}:00</span>`).join("")}</div>
    <div class="tl-cols">${cols}</div>
  </div>`;
}

function block(o, lane, n, detailed, fromHour) {
  const s = subj(o.subject);
  const top = (toMin(o.start) - fromHour * 60) / 60;
  const len = (toMin(o.end) - toMin(o.start)) / 60;
  const tasks = tasksForOcc(o.id);
  const exam = tasks.some((t) => t.kind === "exam");
  const k = o.remote ? "k-remote" : `k-${o.kind}`;
  const room = o.room && !o.remote ? o.room : "";
  const taskLine = tasks.length
    ? detailed
      ? `<span class="b-tasks">${tasks.slice(0, 2).map((t) => `<span class="b-task ${t.kind}">${esc(t.title)}</span>`).join("")}${tasks.length > 2 ? `<span class="b-more">+${tasks.length - 2} more</span>` : ""}</span>`
      : `<span class="b-badge ${exam ? "exam" : ""}" aria-label="${tasks.length} due">${tasks.length}</span>`
    : "";
  return `<button class="block ${k} ${o.mandatory ? "" : "optional"} ${exam ? "has-exam" : ""} ${len <= 1 ? "short" : ""}"
    style="--top:${top};--len:${len};--lane:${lane};--lanes:${n}" data-action="occ" data-id="${esc(o.id)}"
    aria-label="${esc(`${s.name}, ${kindLabel(o)}, ${o.start} to ${o.end}${o.room ? `, room ${o.room}` : ""}${o.mandatory ? "" : ", not mandatory"}${tasks.length ? `, ${tasks.length} due` : ""}`)}">
    <span class="b-time">${o.start}–${o.end}${room ? `<span class="b-room"> · ${esc(room)}</span>` : ""}</span>
    <span class="b-name" lang="pl">${esc(s.short)}</span>
    <span class="b-abbr">${esc(s.abbr ?? s.short)}</span>
    <span class="b-meta"><span class="b-kind">${kindLabel(o)}</span>${room ? `<span class="b-rm"><span class="b-sep"> · </span>${esc(room)}</span>` : ""}</span>
    ${taskLine}
  </button>`;
}

// ----- week view -----
function weekView() {
  const days = [0, 1, 2, 3, 4].map((i) => addDays(state.week, i));
  const today = nowLocal().date;
  const isWide = wide.matches;
  const head = days
    .map(
      (d, i) => `<button class="wk-head ${d === today ? "today" : ""}" data-action="open-day" data-date="${d}">
      <span class="wk-wd">${isWide ? WD_LONG[i] : WD[i]}</span><span class="wk-num">${dayNum(d)}</span>
      ${state.swaps.has(d) ? `<span class="wk-swap">${esc(isWide ? state.swaps.get(d) : `${state.swaps.get(d).slice(0, 3)} plan`)}</span>` : ""}
    </button>`,
    )
    .join("");
  const due = days
    .map((d) => {
      const loose = looseTasksOn(d);
      if (!loose.length) return '<div class="wk-due"></div>';
      return `<div class="wk-due">${loose
        .map(
          (t) => `<button class="wk-chip ${t.kind}" data-action="edit" data-id="${t.id}" title="${esc(`${t.title} (${dueTime(t)})`)}">
          ${isWide ? `<span class="wkc-time">${dueTime(t)}</span><span class="wkc-title">${esc(t.title)}</span>` : `<span class="wkc-title">${esc(t.kind === "exam" ? "Exam" : t.title)}</span>`}
        </button>`,
        )
        .join("")}</div>`;
    })
    .join("");
  const anyDue = days.some((d) => looseTasksOn(d).length);
  return `<section class="week">
    <div class="wk-grid-head"><div class="wk-gutter"></div>${head}</div>
    ${anyDue ? `<div class="wk-grid-due"><div class="wk-gutter wk-due-label">Due</div>${due}</div>` : ""}
    ${timeline(days, false)}
    ${legend()}
  </section>`;
}

function legend() {
  return `<div class="legend">
    <span><i class="sw k-lecture"></i>Lecture</span>
    <span><i class="sw k-lab"></i>Lab</span>
    <span><i class="sw k-remote"></i>Remote</span>
    <span><i class="sw optional"></i>Not mandatory</span>
  </div>`;
}

function pendingNote() {
  const p = state.boot.pending ?? [];
  if (!p.length) return "";
  return `<aside class="pending">
    <h2>Not in the plan yet</h2>
    <ul>${p.map((x) => `<li><span>${esc(subj(x.subject).name)}</span><small>${esc(x.note)}</small></li>`).join("")}</ul>
  </aside>`;
}

// ----- tasks panel -----
function tasksPanel() {
  const open = openTasks().sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const done = state.tasks.filter((t) => t.done).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  let body;
  if (!open.length) {
    body = `<div class="empty"><p class="empty-title">Nothing due</p>
      <p>Add an assignment or exam and you'll get reminders on your phone before it's due.</p>
      <button class="primary" data-action="new-task">${icon.plus}Add task</button></div>`;
  } else if (state.group === "subject") {
    const bySubj = new Map();
    for (const t of open) {
      if (!bySubj.has(t.subjectId)) bySubj.set(t.subjectId, []);
      bySubj.get(t.subjectId).push(t);
    }
    body = [...bySubj.entries()]
      .sort((a, b) => subj(a[0]).short.localeCompare(subj(b[0]).short, "pl"))
      .map(([id, list]) => group(subj(id).short, list, true))
      .join("");
  } else {
    const now = nowLocal();
    const today = now.date;
    const endOfWeek = addDays(startOfWeek(today), 6);
    const endOfNext = addDays(endOfWeek, 7);
    const buckets = [
      ["Overdue", (t) => t.dueAt < now.stamp],
      ["Today", (t) => dueDate(t) === today],
      ["Tomorrow", (t) => dueDate(t) === addDays(today, 1)],
      ["This week", (t) => dueDate(t) <= endOfWeek],
      ["Next week", (t) => dueDate(t) <= endOfNext],
      ["Later", () => true],
    ];
    const used = new Set();
    body = buckets
      .map(([label, test]) => {
        const list = open.filter((t) => !used.has(t.id) && test(t));
        list.forEach((t) => used.add(t.id));
        return list.length ? group(label, list, false, label === "Overdue") : "";
      })
      .join("");
  }
  return `<section class="tasks">
    <div class="tasks-head">
      <h2 class="tasks-title">Tasks</h2>
      <div class="seg" role="group" aria-label="Group tasks">
        <button class="${state.group === "date" ? "on" : ""}" data-action="group" data-group="date" aria-pressed="${state.group === "date"}">By date</button>
        <button class="${state.group === "subject" ? "on" : ""}" data-action="group" data-group="subject" aria-pressed="${state.group === "subject"}">By subject</button>
      </div>
      ${wide.matches ? `<button class="primary" data-action="new-task">${icon.plus}Add task</button>` : ""}
    </div>
    ${body}
    ${done.length ? `<button class="ghost done-toggle" data-action="toggle-done" aria-expanded="${state.showDone}">${state.showDone ? "Hide" : "Show"} done (${done.length})</button>
      ${state.showDone ? `<div class="group done">${done.map((t) => taskRow(t, false)).join("")}</div>` : ""}` : ""}
  </section>`;
}

const capitalize = (x) => x.charAt(0).toUpperCase() + x.slice(1);

function group(label, list, bySubject, alert = false) {
  return `<div class="group ${alert ? "alert" : ""}"><h3 class="group-title">${esc(label)}</h3>${list.map((t) => taskRow(t, bySubject)).join("")}</div>`;
}

function taskRow(t, bySubject) {
  const rel = relDay(dueDate(t));
  const pendingReminders = t.reminders.filter((r) => !r.sentAt).length;
  return `<div class="task ${t.kind} ${t.done ? "is-done" : ""}">
    <button class="check" data-action="toggle" data-id="${t.id}" aria-label="${t.done ? "Mark as not done" : "Mark as done"}" aria-pressed="${t.done}">${icon.check}</button>
    <button class="task-body" data-action="edit" data-id="${t.id}">
      <span class="t-title">${t.kind === "exam" ? '<span class="tag-exam">Exam</span>' : ""}${esc(t.title)}</span>
      <span class="t-meta">${bySubject ? esc(capitalize(dueLabel(t))) : `${esc(subj(t.subjectId).short)}, ${esc(dueLabel(t))}`}</span>
    </button>
    <span class="t-side">
      <span class="t-when">${esc(rel)}</span>
      ${!t.done && pendingReminders ? `<span class="t-bell" title="${pendingReminders} reminder${pendingReminders > 1 ? "s" : ""} scheduled">${icon.bell}${pendingReminders}</span>` : ""}
    </span>
  </div>`;
}

// ---------- now line ----------
function updateNow() {
  const n = nowLocal();
  for (const el of document.querySelectorAll(".now-line")) {
    const col = el.closest(".tl-col");
    const tl = el.closest(".tl");
    const from = Number(tl.dataset.from);
    const mins = toMin(n.time) - from * 60;
    const visible = col && col.dataset.date === n.date && mins >= 0 && mins <= (Number(tl.dataset.to) - from) * 60;
    el.style.display = visible ? "block" : "none";
    el.style.setProperty("--top", mins / 60);
  }
}

// ---------- sheets ----------
const sheet = $("#sheet");
function openSheet(html, mount) {
  sheet.innerHTML = `<div class="sheet-inner">${html}</div>`;
  if (!sheet.open) sheet.showModal();
  mount?.(sheet);
}
function closeSheet() {
  if (sheet.open) sheet.close();
}
sheet.addEventListener("click", (e) => {
  if (e.target === sheet) closeSheet();
});

function sheetHead(title) {
  return `<div class="sheet-head"><h2 id="sheet-title">${esc(title)}</h2>
    <button class="icon-btn" data-close aria-label="Close">${icon.close}</button></div>`;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast show ${isError ? "error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), isError ? 5000 : 2400);
}

// ----- class detail -----
function openOccurrence(id) {
  const o = state.occById.get(id);
  if (!o) return;
  const s = subj(o.subject);
  const tasks = tasksForOcc(id);
  const rows = [
    ["When", `${WD_LONG[weekday(o.date) - 1]} ${dayNum(o.date)} ${MON_LONG[Number(o.date.slice(5, 7)) - 1]}, ${o.start}–${o.end}`],
    ["Type", `${o.kind === "lab" ? "Lab" : "Lecture"}${o.remote ? ", remote" : ""}${o.biweekly ? ", every other week" : ""}`],
    ["Room", o.room],
    ["Group", o.group],
    ["Teacher", o.teacher],
    ["Attendance", o.mandatory ? "Mandatory" : "Not mandatory"],
  ].filter(([, v]) => v);
  openSheet(
    `${sheetHead(s.name)}
    <div class="occ-band ${o.remote ? "k-remote" : `k-${o.kind}`} ${o.mandatory ? "" : "optional"}"></div>
    <dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    <h3 class="sheet-sub">Due at this class</h3>
    ${tasks.length ? `<div class="group">${tasks.map((t) => taskRow(t, true)).join("")}</div>` : '<p class="muted">Nothing due at this class.</p>'}
    <div class="sheet-actions"><button class="primary" data-action="new-task" data-subject="${o.subject}" data-occ="${esc(o.id)}">${icon.plus}Add task for this class</button></div>`,
  );
}

// ----- task form -----
function upcomingOccurrences(subjectId, includeId) {
  const now = nowLocal().stamp;
  return state.occ
    .filter((o) => o.subject === subjectId && (`${o.date}T${o.start}` > now || o.id === includeId))
    .slice(0, 12);
}

function offsetsLabel(n) {
  return n === 0 ? "On the day" : n === 1 ? "1 day before" : `${n} days before`;
}

function openTaskForm(task, preset = {}) {
  const settings = state.boot.settings;
  const f = {
    subjectId: task?.subjectId ?? preset.subjectId ?? "",
    title: task?.title ?? "",
    notes: task?.notes ?? "",
    kind: task?.kind ?? "assignment",
    dueType: task ? (task.occurrenceId ? "class" : "date") : "class",
    occurrenceId: task?.occurrenceId ?? preset.occurrenceId ?? "",
    date: task ? dueDate(task) : addDays(nowLocal().date, 7),
    time: task ? dueTime(task) : "23:59",
    location: task?.location ?? "",
    offsets: task ? [...task.reminderOffsets] : [...settings.defaults.assignment],
    offsetsTouched: !!task,
  };

  const draw = () => {
    const occs = f.subjectId ? upcomingOccurrences(f.subjectId, f.occurrenceId) : [];
    const canClass = occs.length > 0;
    if (!canClass && f.dueType === "class") f.dueType = "date";
    if (f.dueType === "class" && !occs.some((o) => o.id === f.occurrenceId)) f.occurrenceId = occs[0]?.id ?? "";
    const dueAt = f.dueType === "class" ? (() => {
      const o = state.occById.get(f.occurrenceId);
      return o ? `${o.date}T${o.start}` : null;
    })() : `${f.date}T${f.time}`;
    const subjects = state.boot.subjects;
    openSheet(
      `${sheetHead(task ? "Edit task" : "New task")}
      <form class="form" novalidate>
        <label class="field"><span>Subject</span>
          <select name="subjectId" required>
            <option value="" ${f.subjectId ? "" : "selected"} disabled>Choose a subject</option>
            ${subjects.map((s) => `<option value="${s.id}" ${s.id === f.subjectId ? "selected" : ""}>${esc(s.short)}</option>`).join("")}
          </select></label>
        <label class="field"><span>Title</span>
          <input name="title" value="${esc(f.title)}" placeholder="Lab report 3" autocomplete="off" required></label>
        <div class="field"><span>Type</span>
          <div class="seg wide-seg" role="group">
            <button type="button" class="${f.kind === "assignment" ? "on" : ""}" data-f="kind" data-v="assignment">Assignment</button>
            <button type="button" class="${f.kind === "exam" ? "on" : ""}" data-f="kind" data-v="exam">Exam</button>
          </div></div>
        <div class="field"><span>Due</span>
          <div class="seg wide-seg" role="group">
            <button type="button" class="${f.dueType === "class" ? "on" : ""}" data-f="dueType" data-v="class" ${canClass ? "" : "disabled"}>At a class</button>
            <button type="button" class="${f.dueType === "date" ? "on" : ""}" data-f="dueType" data-v="date">On a date</button>
          </div>
          ${!canClass && f.subjectId ? '<small class="hint">This subject has no upcoming classes in the plan, so pick a date.</small>' : ""}
        </div>
        ${f.dueType === "class" && canClass ? `<label class="field"><span>Class</span>
          <select name="occurrenceId">${occs.map((o) => `<option value="${esc(o.id)}" ${o.id === f.occurrenceId ? "selected" : ""}>${esc(`${kindLabel(o)}, ${human(o.date)}, ${o.start}`)}${o === occs[0] ? " (next)" : ""}</option>`).join("")}</select></label>` : ""}
        ${f.dueType === "date" ? `<div class="field-row">
          <label class="field"><span>Date</span><input type="date" name="date" value="${f.date}" required></label>
          <label class="field"><span>Time</span><input type="time" name="time" value="${f.time}" required></label>
        </div>` : ""}
        ${f.kind === "exam" ? `<label class="field"><span>Room <small>optional</small></span><input name="location" value="${esc(f.location)}" placeholder="1.14" autocomplete="off"></label>` : ""}
        <div class="field"><span>Reminders</span>
          <div class="rem-list">
            ${f.offsets.length ? f.offsets.sort((a, b) => b - a).map((n) => `<span class="rem-chip">${esc(offsetsLabel(n))}<small>${esc(reminderPreview(dueAt, n))}</small>
              <button type="button" data-remove-offset="${n}" aria-label="Remove reminder ${esc(offsetsLabel(n))}">${icon.close}</button></span>`).join("") : '<span class="muted">No reminders</span>'}
          </div>
          <div class="rem-add">
            <input type="number" min="0" max="60" inputmode="numeric" name="newOffset" placeholder="3" aria-label="Days before">
            <span>days before</span>
            <button type="button" class="ghost" data-add-offset>Add reminder</button>
          </div>
          <small class="hint">Reminders arrive at ${esc(settings.reminderTime)}.</small>
        </div>
        <label class="field"><span>Notes <small>optional</small></span><textarea name="notes" rows="3">${esc(f.notes)}</textarea></label>
        <p class="form-error" role="alert"></p>
        <div class="sheet-actions">
          ${task ? `<button type="button" class="danger ghost" data-delete>Delete</button>
            <button type="button" class="ghost" data-done>${task.done ? "Mark as not done" : "Mark as done"}</button>` : ""}
          <button type="submit" class="primary">${task ? "Save task" : "Add task"}</button>
        </div>
      </form>`,
      (root) => mountTaskForm(root, f, task, draw),
    );
  };
  draw();
}

function reminderPreview(dueAt, n) {
  if (!dueAt) return "";
  const date = addDays(dueAt.slice(0, 10), -n);
  const at = `${date}T${state.boot.settings.reminderTime}`;
  if (at >= dueAt) return "after the deadline, skipped";
  if (at <= nowLocal().stamp) return "already passed";
  return `${human(date)}, ${state.boot.settings.reminderTime}`;
}

function mountTaskForm(root, f, task, redraw) {
  const form = $("form", root);
  const sync = () => {
    const fd = new FormData(form);
    f.title = fd.get("title") ?? f.title;
    f.notes = fd.get("notes") ?? f.notes;
    if (fd.has("subjectId")) f.subjectId = fd.get("subjectId") ?? "";
    if (fd.has("occurrenceId")) f.occurrenceId = fd.get("occurrenceId");
    if (fd.has("date")) f.date = fd.get("date");
    if (fd.has("time")) f.time = fd.get("time");
    if (fd.has("location")) f.location = fd.get("location");
  };
  form.addEventListener("change", (e) => {
    if (["subjectId", "occurrenceId", "date", "time"].includes(e.target.name)) {
      sync();
      redraw();
    }
  });
  form.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.f) {
      sync();
      if (b.dataset.f === "kind" && f.kind !== b.dataset.v) {
        f.kind = b.dataset.v;
        if (!f.offsetsTouched) f.offsets = [...state.boot.settings.defaults[f.kind]];
        if (f.dueType === "date" && !task) f.time = f.kind === "exam" ? "09:00" : "23:59";
      } else f[b.dataset.f] = b.dataset.v;
      redraw();
    } else if (b.dataset.removeOffset !== undefined) {
      sync();
      f.offsets = f.offsets.filter((n) => n !== Number(b.dataset.removeOffset));
      f.offsetsTouched = true;
      redraw();
    } else if (b.hasAttribute("data-add-offset")) {
      const input = form.elements.newOffset;
      const n = Number(input.value);
      if (input.value === "" || !Number.isInteger(n) || n < 0 || n > 60) {
        showFormError(form, "Enter a whole number of days between 0 and 60.");
        input.focus();
        return;
      }
      sync();
      if (!f.offsets.includes(n)) f.offsets.push(n);
      f.offsetsTouched = true;
      redraw();
    } else if (b.hasAttribute("data-delete")) {
      if (!confirm(`Delete “${task.title}”? This can't be undone.`)) return;
      await act(async () => {
        await api(`/api/tasks/${task.id}`, { method: "DELETE" });
        state.tasks = state.tasks.filter((t) => t.id !== task.id);
        closeSheet();
        toast("Task deleted");
      });
    } else if (b.hasAttribute("data-done")) {
      await setDone(task.id, !task.done);
      closeSheet();
    }
  });
  form.addEventListener("input", () => showFormError(form, ""));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    sync();
    if (!f.subjectId) return showFormError(form, "Choose a subject.");
    if (!f.title.trim()) return showFormError(form, "Give the task a title.");
    if (f.dueType === "date" && (!f.date || !f.time)) return showFormError(form, "Enter the due date and time.");
    const body = {
      subjectId: f.subjectId,
      title: f.title.trim(),
      notes: f.notes,
      kind: f.kind,
      due: f.dueType === "class" ? { type: "class", occurrenceId: f.occurrenceId } : { type: "date", at: `${f.date}T${f.time}` },
      location: f.kind === "exam" ? f.location : "",
      reminderOffsets: f.offsets,
    };
    const btn = $('button[type="submit"]', form);
    btn.disabled = true;
    try {
      const { task: saved } = task
        ? await api(`/api/tasks/${task.id}`, { method: "PATCH", body })
        : await api("/api/tasks", { method: "POST", body });
      state.tasks = [...state.tasks.filter((t) => t.id !== saved.id), saved];
      closeSheet();
      render();
      toast(task ? "Task saved" : "Task added");
    } catch (err) {
      showFormError(form, err.message);
    } finally {
      btn.disabled = false;
    }
  });
  if (!task && !f.subjectId) $("select[name=subjectId]", form)?.focus();
}

function showFormError(form, msg) {
  const p = $(".form-error", form);
  if (p) p.textContent = msg;
}

async function act(fn) {
  try {
    await fn();
  } catch (err) {
    toast(err.message, true);
  }
  render();
}

async function setDone(id, done) {
  await act(async () => {
    const { task } = await api(`/api/tasks/${id}`, { method: "PATCH", body: { done } });
    state.tasks = state.tasks.map((t) => (t.id === id ? task : t));
    toast(done ? "Marked as done" : "Marked as not done");
  });
}

// ----- settings -----
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

function b64ToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function notificationsBlock() {
  if (isIOS() && !isStandalone()) {
    return `<p>On iPhone, notifications only work in the Home Screen app.</p>
      <ol class="steps"><li>In Safari, tap the Share button.</li><li>Choose Add to Home Screen.</li><li>Open Plan from your Home Screen and come back here.</li></ol>`;
  }
  if (!pushSupported()) return "<p>This browser can't receive push notifications.</p>";
  if (!state.boot.vapidPublicKey) return "<p>Push keys aren't configured on the server yet.</p>";
  if (Notification.permission === "denied") {
    return "<p>Notifications are blocked for this app. Allow them in your device settings, then come back here.</p>";
  }
  const sub = await currentSubscription();
  let known = false;
  if (sub) {
    try {
      known = (await api("/api/push/status", { method: "POST", body: { endpoint: sub.endpoint } })).subscribed;
    } catch {}
  }
  if (sub && known) {
    return `<p class="status-on">${icon.bell}Notifications are on for this device.</p>
      <div class="sheet-actions left"><button class="ghost" data-push="test">Send test notification</button><button class="ghost" data-push="off">Turn off</button></div>`;
  }
  return `<p>Turn on notifications to get task reminders on this device.</p>
    <div class="sheet-actions left"><button class="primary" data-push="on">${icon.bell}Turn on notifications</button></div>`;
}

async function openSettings() {
  const s = state.boot.settings;
  const chips = (kind) =>
    `<div class="rem-list">${[...s.defaults[kind]].sort((a, b) => b - a).map((n) => `<span class="rem-chip">${esc(offsetsLabel(n))}
      <button type="button" data-def-remove="${kind}:${n}" aria-label="Remove">${icon.close}</button></span>`).join("") || '<span class="muted">No reminders</span>'}</div>
      <div class="rem-add"><input type="number" min="0" max="60" inputmode="numeric" data-def-input="${kind}" placeholder="3" aria-label="Days before"><span>days before</span>
      <button type="button" class="ghost" data-def-add="${kind}">Add</button></div>`;
  openSheet(
    `${sheetHead("Settings")}
    <section class="set-block"><h3 class="sheet-sub">Notifications</h3><div data-push-block><p class="muted">Checking…</p></div></section>
    <section class="set-block"><h3 class="sheet-sub">Reminders</h3>
      <label class="field"><span>Time of day</span><input type="time" name="reminderTime" value="${s.reminderTime}"></label>
      <div class="field"><span>Default for assignments</span>${chips("assignment")}</div>
      <div class="field"><span>Default for exams</span>${chips("exam")}</div>
      <small class="hint">Defaults apply to new tasks. You can change reminders on each task.</small>
      <p class="form-error" role="alert"></p>
    </section>
    <section class="set-block"><h3 class="sheet-sub">Semester</h3>
      <p class="muted">${esc(state.boot.semester.name)}: classes ${esc(human(state.boot.semester.classesFrom))} to ${esc(human(state.boot.semester.classesTo))}.</p>
    </section>`,
    (root) => mountSettings(root),
  );
}

async function refreshPushBlock(root) {
  const el = $("[data-push-block]", root);
  if (el) el.innerHTML = await notificationsBlock();
}

function mountSettings(root) {
  refreshPushBlock(root);
  const save = async (patch) => {
    try {
      const { settings } = await api("/api/settings", { method: "PUT", body: patch });
      state.boot.settings = settings;
      await loadTasks();
      openSettings();
      toast("Settings saved");
    } catch (err) {
      const p = $(".form-error", root);
      if (p) p.textContent = err.message;
    }
  };
  root.addEventListener("change", (e) => {
    if (e.target.name === "reminderTime" && e.target.value) save({ reminderTime: e.target.value });
  });
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const s = state.boot.settings;
    if (b.dataset.defRemove) {
      const [kind, n] = b.dataset.defRemove.split(":");
      save({ defaults: { [kind]: s.defaults[kind].filter((x) => x !== Number(n)) } });
    } else if (b.dataset.defAdd) {
      const kind = b.dataset.defAdd;
      const input = $(`[data-def-input="${kind}"]`, root);
      const n = Number(input.value);
      if (input.value === "" || !Number.isInteger(n) || n < 0 || n > 60) {
        $(".form-error", root).textContent = "Enter a whole number of days between 0 and 60.";
        return;
      }
      save({ defaults: { [kind]: [...new Set([...s.defaults[kind], n])] } });
    } else if (b.dataset.push) {
      b.disabled = true;
      try {
        await pushAction(b.dataset.push);
      } catch (err) {
        toast(err.message, true);
      }
      await refreshPushBlock(root);
    }
  });
}

async function pushAction(what) {
  if (what === "on") {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notifications weren't allowed.");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(state.boot.vapidPublicKey) });
    }
    await api("/api/push/subscribe", { method: "POST", body: sub.toJSON() });
    toast("Notifications turned on");
  } else if (what === "off") {
    const sub = await currentSubscription();
    if (sub) {
      await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
    }
    toast("Notifications turned off");
  } else if (what === "test") {
    const { sent } = await api("/api/push/test", { method: "POST" });
    toast(sent ? "Test notification sent" : "No device accepted the notification. Try turning notifications off and on.", !sent);
  }
}

// ---------- events ----------
document.addEventListener("click", async (e) => {
  const closer = e.target.closest("[data-close]");
  if (closer) return closeSheet();
  const b = e.target.closest("[data-action]");
  if (!b) return;
  const a = b.dataset.action;
  switch (a) {
    case "mode":
      state.mode = b.dataset.mode;
      if (state.mode === "week") state.week = startOfWeek(state.date);
      break;
    case "view":
      state.view = b.dataset.view;
      window.scrollTo(0, 0);
      break;
    case "day":
      state.date = b.dataset.date;
      state.week = startOfWeek(state.date);
      break;
    case "shift-week":
      state.date = addDays(state.date, 7 * Number(b.dataset.dir));
      state.week = startOfWeek(state.date);
      break;
    case "week":
      state.week = addDays(state.week, 7 * Number(b.dataset.dir));
      state.date = state.week;
      break;
    case "today":
      state.date = nextWeekday(nowLocal().date);
      state.week = startOfWeek(state.date);
      break;
    case "open-day":
      if (wide.matches) return;
      state.date = b.dataset.date;
      state.mode = "day";
      break;
    case "group":
      state.group = b.dataset.group;
      break;
    case "toggle-done":
      state.showDone = !state.showDone;
      break;
    case "settings":
      return openSettings();
    case "occ":
      return openOccurrence(b.dataset.id);
    case "new-task":
      return openTaskForm(null, { subjectId: b.dataset.subject, occurrenceId: b.dataset.occ });
    case "edit": {
      const t = state.tasks.find((x) => x.id === b.dataset.id);
      return t && openTaskForm(t);
    }
    case "toggle": {
      const t = state.tasks.find((x) => x.id === b.dataset.id);
      if (!t) return;
      const inSheet = sheet.contains(b);
      await setDone(t.id, !t.done);
      if (inSheet) closeSheet();
      return;
    }
    default:
      return;
  }
  render();
});

// swipe between days on the phone
let touch = null;
document.addEventListener("touchstart", (e) => {
  if (!e.target.closest("[data-swipe]")) return (touch = null);
  touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
document.addEventListener("touchend", (e) => {
  if (!touch) return;
  const dx = e.changedTouches[0].clientX - touch.x;
  const dy = e.changedTouches[0].clientY - touch.y;
  touch = null;
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  state.date = shiftWeekday(state.date, dx < 0 ? 1 : -1);
  state.week = startOfWeek(state.date);
  render();
});

document.addEventListener("keydown", (e) => {
  if (sheet.open || e.target.closest("input, textarea, select")) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const dir = e.key === "ArrowLeft" ? -1 : 1;
  if (wide.matches || state.mode === "week") {
    state.week = addDays(state.week, 7 * dir);
    state.date = state.week;
  } else {
    state.date = shiftWeekday(state.date, dir);
    state.week = startOfWeek(state.date);
  }
  render();
});

wide.addEventListener("change", render);
setInterval(updateNow, 30_000);
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !state.boot) return;
  try {
    await loadTasks();
    if (!sheet.open) render();
    else updateNow();
  } catch {}
});

// ---------- start ----------
async function start() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  try {
    await load();
  } catch (err) {
    $("#app").innerHTML = `<div class="fatal"><p class="empty-title">Couldn't load your plan</p><p>${esc(err.message)}</p>
      <button class="primary" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  render();
  const params = new URLSearchParams(location.search);
  const taskId = params.get("task");
  if (taskId) {
    history.replaceState(null, "", "/");
    const t = state.tasks.find((x) => x.id === taskId);
    if (t) openTaskForm(t);
  }
}

navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.type === "open-task") {
    const t = state.tasks.find((x) => x.id === e.data.id);
    if (t) openTaskForm(t);
  }
});

start();
