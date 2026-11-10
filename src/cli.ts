import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { STATUSES, Store, type Status, type StoredJob } from "./db.js";
import { discover } from "./discover.js";
import { ageDays } from "./jobs/job.js";
import { PATHS } from "./paths.js";
import { loadProfile } from "./profile/schema.js";
import { loadCompanies } from "./sources/index.js";

const program = new Command().name("job").description("Find well-matched jobs and track your applications.");

function line(job: StoredJob): string {
  const age = ageDays(job);
  const where = job.locations.join("; ") || (job.remote ? "Remote" : "location not stated");
  return `${job.id}  ${String(job.score).padStart(3)}  ${job.company}: ${job.title}\n               ${where}${age === null ? "" : `, ${age}d old`}`;
}

function asStatus(value: string): Status {
  if (!(STATUSES as readonly string[]).includes(value)) {
    throw new Error(`"${value}" is not a status. Use one of: ${STATUSES.join(", ")}.`);
  }
  return value as Status;
}

program
  .command("init")
  .description("Create data/profile.json and data/companies.json from the examples")
  .action(() => {
    for (const [target, example] of [[PATHS.profile, PATHS.profileExample], [PATHS.companies, PATHS.companiesExample]] as const) {
      if (existsSync(target)) {
        console.log(`Kept     ${target}`);
        continue;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(example, target);
      console.log(`Created  ${target}`);
    }
    console.log("\nEdit both files, then run: npm run job -- discover");
  });

program
  .command("discover")
  .description("Read the company boards, filter and score the postings")
  .action(async () => {
    const profile = loadProfile(PATHS.profile);
    const companies = loadCompanies(PATHS.companies);
    const store = new Store(PATHS.db);
    const result = await discover(companies, profile, store);
    console.log(`Read ${result.fetched} postings from ${companies.length - result.failures.length} of ${companies.length} boards.`);
    console.log(`${result.kept} match your profile, ${result.newKept} of them new.`);
    for (const f of result.failures) console.log(`  Could not read ${f.company}: ${f.error}`);
    const dropped = store.filteredCounts();
    if (dropped.length) {
      console.log("\nDropped:");
      for (const d of dropped) console.log(`  ${String(d.n).padStart(5)}  ${d.reason}`);
    }
    store.close();
    if (result.failures.length === companies.length && companies.length > 0) process.exitCode = 1;
  });

program
  .command("list")
  .description("Show jobs, best first")
  .option("-s, --status <status>", "which jobs", "new")
  .option("-n, --limit <n>", "how many", "20")
  .action((opts: { status: string; limit: string }) => {
    const store = new Store(PATHS.db);
    const jobs = store.list(asStatus(opts.status), Number(opts.limit) || 20);
    if (!jobs.length) console.log(`No jobs with status "${opts.status}".`);
    for (const job of jobs) console.log(line(job));
    store.close();
  });

program
  .command("show <id>")
  .description("Show one job: why it scored what it did, and its history")
  .action((id: string) => {
    const store = new Store(PATHS.db);
    const job = store.get(id);
    if (!job) throw new Error(`No job with id ${id}.`);
    console.log(line(job));
    console.log(`\n${job.url}\nStatus: ${job.status}   Level: ${job.level}`);
    if (job.filteredReason) console.log(`Dropped: ${job.filteredReason}`);
    for (const r of job.reasons) console.log(`  - ${r}`);
    console.log("\nHistory:");
    for (const e of store.events(id)) console.log(`  ${e.at.slice(0, 10)}  ${e.kind}${e.note ? `: ${e.note}` : ""}`);
    store.close();
  });

program
  .command("mark <id> <status>")
  .description(`Set where a job stands: ${STATUSES.join(", ")}`)
  .option("--note <text>", "a note to keep with it", "")
  .action((id: string, status: string, opts: { note: string }) => {
    const store = new Store(PATHS.db);
    store.setStatus(id, asStatus(status), opts.note);
    const job = store.get(id)!;
    console.log(`${job.company}: ${job.title} is now ${status}.`);
    store.close();
  });

program
  .command("stats")
  .description("Where your search stands")
  .action(() => {
    const store = new Store(PATHS.db);
    const c = store.counts();
    for (const s of STATUSES) console.log(`${String(c[s]).padStart(5)}  ${s}`);
    // A job that moved past "applied" was still an application.
    const sent = c.applied + c.replied + c.interview + c.offer + c.rejected;
    const positive = c.replied + c.interview + c.offer;
    if (sent > 0) console.log(`\n${sent} sent, ${positive} with a positive reply (${Math.round((100 * positive) / sent)}%).`);
    store.close();
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
