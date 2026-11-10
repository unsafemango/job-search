import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { STATUSES, Store, type Status, type StoredJob } from "./db.js";
import { discover, ingest } from "./discover.js";
import { ageDays } from "./jobs/job.js";
import { ClaudeCodeRater } from "./model/claude-code.js";
import { ClaudeRater, isFatal } from "./model/claude.js";
import { PATHS, ROOT } from "./paths.js";
import { loadProfile } from "./profile/schema.js";
import { rateJobs } from "./rate.js";
import { openSession } from "./apply/browser.js";
import { applyJobs, tailoredFile } from "./apply/run.js";
import { renderPdf } from "./resume/render.js";
import { loadResume } from "./resume/schema.js";
import { tailorResume, trimOnce } from "./resume/tailor.js";
import { createInterface } from "node:readline/promises";
import { CSV_COLUMNS, parseCsvJobs } from "./sources/csv.js";
import { loadCompanies } from "./sources/index.js";

// Your API key can live in .env (git-ignored) instead of your shell.
const ENV_FILE = path.join(ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

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
    if (result.duplicates) console.log(`${result.duplicates} more were the same job posted again, and are hidden.`);
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
  .command("import <file>")
  .description(`Add jobs from a CSV file (columns: ${CSV_COLUMNS.join(", ")}; company, title and url required)`)
  .action((file: string) => {
    const profile = loadProfile(PATHS.profile);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw new Error(`Could not read ${file}.`);
    }
    const { jobs, errors } = parseCsvJobs(text);
    for (const e of errors) console.log(`  Skipped line ${e.line}: ${e.error}`);
    const store = new Store(PATHS.db);
    const { kept, newKept, duplicates } = ingest(jobs, profile, store);
    console.log(`Read ${jobs.length} job${jobs.length === 1 ? "" : "s"} from ${file}.`);
    console.log(`${kept} match your profile, ${newKept} of them new.`);
    if (duplicates) console.log(`${duplicates} more were the same job as one you already have, and are hidden.`);
    const dropped = jobs.flatMap((j) => {
      const reason = store.get(j.id)?.filteredReason;
      return reason ? [`  ${j.company}: ${j.title}  (${reason})`] : [];
    });
    store.close();
    if (dropped.length) console.log(`\nDid not match your profile:\n${dropped.join("\n")}`);
    if (errors.length && !jobs.length) process.exitCode = 1;
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
    if (store.isHiddenDuplicate(id)) console.log("Hidden: the same job as another posting below.");
    for (const r of job.reasons) console.log(`  - ${r}`);
    const dups = store.duplicatesOf(id);
    if (dups.length) {
      console.log("\nAlso posted as:");
      for (const d of dups) console.log(`  ${d.id}  ${d.status.padEnd(11)}  ${d.url}`);
    }
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
  .command("rate")
  .description("Have Claude rate how well your best unrated jobs fit you (your local Claude Code by default)")
  .option("-n, --limit <n>", "how many jobs at most (default: rating.maxJobsPerRun in your profile)")
  .action(async (opts: { limit?: string }) => {
    const profile = loadProfile(PATHS.profile);
    const limit = opts.limit === undefined ? undefined : Number(opts.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error(`--limit must be a whole number above 0, not "${opts.limit}".`);
    }
    const { provider, command, model, effort, maxSpendPerRunUsd } = profile.rating;
    const rater = provider === "api" ? new ClaudeRater({ model, effort }) : new ClaudeCodeRater({ model, effort, command });
    const store = new Store(PATHS.db);
    console.log(
      provider === "api"
        ? `Rating with ${model} through the Anthropic API (effort: ${effort}), stopping at $${maxSpendPerRunUsd.toFixed(2)}.`
        : `Rating with ${model} through your local Claude Code (effort: ${effort}). This uses your Claude plan, not an API key.`,
    );
    try {
      const r = await rateJobs(store, profile, rater, {
        limit,
        isFatal,
        onProgress: (l) => console.log(l),
      });
      const tokens = `${r.inputTokens.toLocaleString()} tokens in, ${r.outputTokens.toLocaleString()} out`;
      const cost = rater.billed ? ` for about $${r.costUsd.toFixed(2)}` : "";
      console.log(`\nRated ${r.rated} job${r.rated === 1 ? "" : "s"}${cost} (${tokens}).`);
      if (r.failed.length) console.log(`${r.failed.length} could not be rated; they will be tried again next run.`);
      if (r.stopped) console.log(`Stopped early: ${r.stopped}`);
      if (r.remaining > 0) console.log(`${r.remaining} more job${r.remaining === 1 ? "" : "s"} still unrated. Run rate again to continue.`);
      if (r.rated) console.log("See the new order with: npm run job -- list");
      if (r.stopped && r.rated === 0) process.exitCode = 1;
    } finally {
      store.close();
    }
  });

program
  .command("apply [ids...]")
  .description("Fill application forms (Greenhouse, Lever, Ashby) in a Chrome window; sends only with --submit")
  .option("-n, --count <n>", "how many of your best untried jobs, when no ids are given", "1")
  .option("--submit", "send each form that filled cleanly (without it, nothing is sent)")
  .option("--headless", "run without a visible window (forms needing you are then closed, not left open)")
  .action(async (ids: string[], opts: { count: string; submit?: boolean; headless?: boolean }) => {
    const profile = loadProfile(PATHS.profile);
    const count = Number(opts.count);
    if (!Number.isInteger(count) || count < 1) throw new Error(`--count must be a whole number above 0, not "${opts.count}".`);
    const store = new Store(PATHS.db);
    let session: Awaited<ReturnType<typeof openSession>> | null = null;
    try {
      console.log(opts.submit ? "Applying, and sending each form that fills cleanly." : "Dry run: forms are filled and checked, nothing is sent.");
      const r = await applyJobs(store, profile, {
        ids,
        count,
        submit: !!opts.submit,
        session: async () => (session = await openSession(PATHS.browser, { headless: !!opts.headless })),
        log: (l) => console.log(l),
      });
      for (const n of r.notes) console.log(`  ${n}`);
      if (!r.outcomes.length && !r.stopped) console.log("No jobs to apply to: none untried with a form the tool can fill. Name one with: npm run job -- apply <id>");
      if (r.stopped) console.log(`Stopped: ${r.stopped}`);
      const tally = new Map<string, number>();
      for (const o of r.outcomes) tally.set(o.state, (tally.get(o.state) ?? 0) + 1);
      if (tally.size) console.log(`\n${[...tally].map(([s, n]) => `${n} ${s.replace("_", " ")}`).join(", ")}. Details: npm run job -- applications`);
      const open = r.outcomes.filter((o) => o.leftOpen);
      if (session && !opts.headless && open.length && process.stdin.isTTY) {
        console.log(`\n${open.length} form${open.length === 1 ? " is" : "s are"} open in the window for you to check or finish.`);
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        await rl.question("Press Enter to close the browser. ");
        rl.close();
      }
    } finally {
      await (session as Awaited<ReturnType<typeof openSession>> | null)?.close().catch(() => {});
      store.close();
    }
  });

program
  .command("tailor <ids...>")
  .description("Write a resume tailored to each job from data/resume.json (only reorders and picks; every claim checked)")
  .action(async (ids: string[]) => {
    const profile = loadProfile(PATHS.profile);
    const resume = loadResume(PATHS.resumeData);
    const store = new Store(PATHS.db);
    try {
      for (const id of ids) {
        const job = store.get(id);
        if (!job) {
          console.log(`${id}: no such job`);
          continue;
        }
        const t = await tailorResume(resume, job, profile);
        const file = tailoredFile(profile, id);
        mkdirSync(path.dirname(file), { recursive: true });
        // Trim the least relevant bullets until it fits on two pages, like most experienced resumes.
        let pages = await renderPdf(t.resume, file);
        for (let next = trimOnce(t.resume); pages > 2 && next; next = trimOnce(t.resume)) {
          t.resume = next;
          pages = await renderPdf(t.resume, file);
        }
        writeFileSync(file.replace(/\.pdf$/, ".json"), JSON.stringify({ plan: t.plan, refused: t.refused, resume: t.resume }, null, 2));
        const kept = t.resume.experience.reduce((n, e) => n + e.bullets.length, 0);
        const all = resume.experience.reduce((n, e) => n + e.bullets.length, 0);
        console.log(`${id}  ${job.company}: ${job.title}`);
        console.log(`           ${file}`);
        console.log(`           ${pages} page${pages === 1 ? "" : "s"}, ${kept} of ${all} bullets, ${t.resume.projects.length} project${t.resume.projects.length === 1 ? "" : "s"}`);
        if (t.refused.length) console.log(`           Summary kept as yours: the rewrite named things your resume does not (${t.refused.join(", ")})`);
        else console.log(`           Summary: ${t.resume.summary}`);
        store.addEvent(id, "tailored", path.basename(file));
      }
      console.log("\napply attaches a job's tailored resume automatically.");
    } finally {
      store.close();
    }
  });

program
  .command("applications [id]")
  .description("Show what happened to recent applications, or every field of one job's last attempt")
  .action((id?: string) => {
    const store = new Store(PATHS.db);
    const apps = store.applications(id, id ? 1 : 30);
    if (!apps.length) console.log(id ? `No applications for ${id}.` : "No applications yet. Try: npm run job -- apply");
    for (const a of apps) {
      const job = store.get(a.jobId);
      console.log(`${a.at.slice(0, 16).replace("T", " ")}  ${a.jobId}  ${a.state.padEnd(12)} ${a.mode.padEnd(6)} ${job ? `${job.company}: ${job.title}` : ""}`);
      console.log(`                  ${a.detail}`);
      if (id) {
        for (const f of a.fields as { label: string; wanted: string; shows: string; ok: boolean; required: boolean }[]) {
          console.log(`    ${f.ok ? "ok " : "!! "}${f.required ? "*" : " "} ${f.label.slice(0, 60).padEnd(60)}  ${f.shows || (f.wanted ? "" : "(left empty)")}`);
        }
      }
    }
    store.close();
  });

program
  .command("followups")
  .description("Show applications with no reply that are due a follow-up")
  .option("-d, --days <n>", "days to wait before following up (default: followUpAfterDays in your profile)")
  .action((opts: { days?: string }) => {
    const afterDays = opts.days === undefined ? loadProfile(PATHS.profile).followUpAfterDays : Number(opts.days);
    if (!Number.isInteger(afterDays) || afterDays < 0) throw new Error(`--days must be a whole number, not "${opts.days}".`);
    const store = new Store(PATHS.db);
    const due = store.followUps(afterDays);
    if (!due.length) console.log(`No applications have waited ${afterDays}+ days without a reply.`);
    for (const f of due) {
      const what = f.followUps === 0 ? "applied" : `followed up (${f.followUps}x)`;
      console.log(`${f.job.id}  ${f.job.company}: ${f.job.title}\n               ${what} ${f.days}d ago`);
    }
    if (due.length) {
      console.log(`\nAfter you follow up:   npm run job -- followed-up <id>`);
      console.log(`If they replied:       npm run job -- mark <id> replied`);
    }
    store.close();
  });

program
  .command("followed-up <id>")
  .description("Record that you followed up on an application; the wait starts again")
  .option("--note <text>", "a note to keep with it", "")
  .action((id: string, opts: { note: string }) => {
    const store = new Store(PATHS.db);
    store.followedUp(id, opts.note);
    const job = store.get(id)!;
    console.log(`Recorded a follow-up for ${job.company}: ${job.title}.`);
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
    const rated = store.ratingTotals();
    if (rated.n > 0) {
      const spent = rated.costUsd > 0 ? `, about $${rated.costUsd.toFixed(2)} of it billed through the API` : "";
      console.log(`${rated.n} job${rated.n === 1 ? "" : "s"} rated by a model so far${spent}.`);
    }
    if (c.applied > 0 && existsSync(PATHS.profile)) {
      const due = store.followUps(loadProfile(PATHS.profile).followUpAfterDays).length;
      if (due > 0) console.log(`${due} due a follow-up. See: npm run job -- followups`);
    }
    store.close();
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
