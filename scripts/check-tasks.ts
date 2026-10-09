// Runs before `npm run deploy`: checks open tasks in the remote D1 database
// against data/schedule.json and stops the deploy if an edit to the timetable
// would unlink a task from its class or leave it at the class's old time.
// `npm run check-tasks -- --local` checks the local dev database instead.
import { execFileSync } from "node:child_process";
import scheduleData from "../data/schedule.json";
import { findOccurrence, type Schedule } from "../src/schedule";

const schedule = scheduleData as Schedule;
const where = process.argv.includes("--local") ? "--local" : "--remote";

interface Row {
  id: string;
  title: string;
  due_at: string;
  occurrence_id: string;
}

const out = execFileSync(
  "npx",
  [
    "wrangler", "d1", "execute", "plan-zajec", where, "--json",
    "--command", "SELECT id, title, due_at, occurrence_id FROM tasks WHERE done = 0 AND occurrence_id IS NOT NULL",
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
const rows: Row[] = JSON.parse(out)[0].results;

const problems: string[] = [];
for (const t of rows) {
  const occ = findOccurrence(schedule, t.occurrence_id);
  if (!occ) problems.push(`"${t.title}": its class ${t.occurrence_id} is no longer in the timetable`);
  else if (t.due_at !== `${occ.date}T${occ.start}`)
    problems.push(`"${t.title}": due ${t.due_at.replace("T", " ")}, but the class now starts ${occ.date} ${occ.start}`);
}

if (problems.length) {
  console.error(`\n${problems.length} open task(s) don't match data/schedule.json:\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nUndo the timetable change, or deploy anyway with `npx wrangler deploy` and re-pick the class for these tasks in the app.\n");
  process.exit(1);
}
console.log(`Checked ${rows.length} open task(s) linked to classes: all match the timetable.`);
