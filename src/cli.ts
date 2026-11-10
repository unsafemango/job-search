import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { STATUSES, Store, type Status, type StoredJob } from "./db.js";
import { discover, ingest } from "./discover.js";
import { ageDays } from "./jobs/job.js";
import { ClaudeCodeRater, claudeCodeJson } from "./model/claude-code.js";
import { loadConnections, referralsFor } from "./referrals.js";
import { startDashboard } from "./dashboard.js";
import { classifyEmail, isProgress, learnWeights, type Email } from "./learn.js";
import { WEIGHTS } from "./jobs/score.js";
import { ClaudeRater, isFatal } from "./model/claude.js";
import { PATHS, ROOT } from "./paths.js";
import { loadProfile } from "./profile/schema.js";
import { rateJobs } from "./rate.js";
import { openSession } from "./apply/browser.js";
import { applyJobs } from "./apply/run.js";
import { blobId, parseRhythm, planDaily, readJson, runDaily } from "./daily.js";
import { prepareDocuments } from "./resume/documents.js";
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
  .option("--no-tailor", "attach your own resume instead of writing one for each job")
  .action(async (ids: string[], opts: { count: string; submit?: boolean; headless?: boolean; tailor: boolean }) => {
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
        ...(opts.tailor === false ? { tailor: false } : {}),
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
  .description("Write a resume for each job in your voice from data/resume.json, plus a cover letter with --cover (every claim checked)")
  .option("--cover", "also write a cover letter")
  .action(async (ids: string[], opts: { cover?: boolean }) => {
    const profile = loadProfile(PATHS.profile);
    const store = new Store(PATHS.db);
    try {
      for (const id of ids) {
        const job = store.get(id);
        if (!job) {
          console.log(`${id}: no such job`);
          continue;
        }
        const docs = await prepareDocuments(job, profile, { cover: !!opts.cover });
        console.log(`${id}  ${job.company}: ${job.title}`);
        console.log(`           Resume (${docs.pages} page${docs.pages === 1 ? "" : "s"}): ${docs.resume}`);
        if (opts.cover) console.log(docs.coverLetter ? `           Cover letter: ${docs.coverLetter}` : "           No cover letter: too little was left after checking it against your facts.");
        console.log(`           Notes (keywords, gaps, numbers to add): ${docs.notes}`);
        if (docs.dropped.length) console.log(`           Left out ${docs.dropped.length} line(s) your facts don't support; see the notes.`);
        store.addEvent(id, "tailored", opts.cover ? "resume and cover letter" : "resume");
      }
      console.log("\napply attaches these automatically, and deletes them once the application is sent.");
    } finally {
      store.close();
    }
  });

program
  .command("referrals <id>")
  .description("People you know at this job's company, from data/connections.csv (your LinkedIn export), with a message to send")
  .option("--draft", "have Claude draft a short message to each (uses your Claude plan)")
  .action(async (id: string, opts: { draft?: boolean }) => {
    const store = new Store(PATHS.db);
    const job = store.get(id);
    store.close();
    if (!job) throw new Error(`No job with id ${id}.`);
    const people = referralsFor(job.company, loadConnections(PATHS.connections));
    if (!people.length) {
      console.log(`No connections at ${job.company}.`);
      return;
    }
    console.log(`${people.length} connection${people.length === 1 ? "" : "s"} at ${job.company} for "${job.title}":`);
    const profile = opts.draft ? loadProfile(PATHS.profile) : null;
    for (const p of people) {
      console.log(`\n  ${p.name}, ${p.position || "?"} at ${p.company}\n  ${p.url}`);
      if (profile) {
        const { value } = await claudeCodeJson({
          command: profile.rating.command,
          model: profile.apply.model,
          effort: "low",
          system:
            "You write one short, warm LinkedIn message from a job seeker to a connection who works at the company they are applying to, asking whether they would be open to a quick chat or a referral. Three or four plain sentences, no flattery, no made-up shared history, nothing the candidate's background does not support. Mention the role by its title.",
          prompt: JSON.stringify({ candidate: profile.background, firstName: profile.contact.firstName, connection: p, role: job.title, company: job.company, link: job.url }),
          schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
        });
        const message = (value as { message?: string } | null)?.message;
        if (message) console.log(`\n${message.split("\n").map((l) => `    ${l}`).join("\n")}`);
      }
    }
    console.log("\nNothing was sent. Copy a message to LinkedIn yourself if you want to reach out.");
  });

program
  .command("dashboard")
  .description("Open a local page to approve jobs, see what needs you, and track replies")
  .option("-p, --port <port>", "port on 127.0.0.1", "4317")
  .action((opts: { port: string }) => {
    loadProfile(PATHS.profile);
    const { url } = startDashboard(() => ({ store: new Store(PATHS.db), profile: loadProfile(PATHS.profile) }), Number(opts.port));
    console.log(`Dashboard: ${url}\nOnly this computer can open it, and only with that link. Press Ctrl+C to stop.`);
  });

program
  .command("learn")
  .description("Compare jobs that got replies with those that did not, and suggest score weights; --save uses them")
  .option("--save", "write the learned weights to your profile (only once there are enough outcomes)")
  .action((opts: { save?: boolean }) => {
    const profile = loadProfile(PATHS.profile);
    const store = new Store(PATHS.db);
    const l = learnWeights(store.outcomes(), profile.scoreWeights ?? { ...WEIGHTS });
    store.close();
    console.log(`${l.sent} sent applications with a score breakdown, ${l.positive} with a positive reply.`);
    if (l.sent) {
      console.log("\npart       replied  no reply   weight  learned");
      for (const p of l.parts) {
        console.log(`${p.part.padEnd(10)} ${p.positive.toFixed(2).padStart(7)}  ${p.negative.toFixed(2).padStart(8)}  ${String(p.weight).padStart(7)}  ${String(p.learned).padStart(7)}`);
      }
    }
    if (!l.ready) return console.log(`\nNot learning yet: ${l.why}.`);
    if (!opts.save) return console.log("\nRun with --save to use the learned weights, then discover to rescore.");
    const raw = JSON.parse(readFileSync(PATHS.profile, "utf8"));
    raw.scoreWeights = l.weights;
    writeFileSync(PATHS.profile, JSON.stringify(raw, null, 2) + "\n");
    console.log(`\nSaved to ${PATHS.profile} as scoreWeights. Run discover to rescore your jobs. Delete scoreWeights to go back to the defaults.`);
  });

program
  .command("inbox <emails.json>")
  .description("Read replies (a JSON list of {from, subject, snippet, date}) and propose status changes; --apply makes them")
  .option("--apply", "make the proposed changes")
  .action((file: string, opts: { apply?: boolean }) => {
    const emails = JSON.parse(readFileSync(file, "utf8")) as Email[];
    if (!Array.isArray(emails)) throw new Error(`${file} must hold a JSON list of emails.`);
    const store = new Store(PATHS.db);
    try {
      const tracked = (["applied", "replied", "interview", "offer"] as const).flatMap((s) => store.list(s, 1000));
      let changes = 0;
      for (const c of emails.map((e) => classifyEmail(e, tracked))) {
        if (!c.job) continue;
        const change = c.status && isProgress(c.job.status, c.status) ? c.status : null;
        console.log(`${c.job.id}  ${c.job.company}: ${c.job.title}\n           "${c.email.subject}" looks like ${c.label}${change ? `: ${c.job.status} -> ${change}` : ""}`);
        if (change) {
          changes++;
          if (opts.apply) {
            store.setStatus(c.job.id, change, `from email: ${c.email.subject.slice(0, 120)}`);
            c.job.status = change;
          }
        }
      }
      if (!changes) console.log("No status changes.");
      else console.log(opts.apply ? `\nMade ${changes} change(s).` : `\n${changes} change(s) proposed. Run again with --apply to make them.`);
    } finally {
      store.close();
    }
  });

program
  .command("memory")
  .description("Answers written for past forms that apply reuses; --forget removes some")
  .option("--forget <text>", "forget answers whose question or answer contains this")
  .action((opts: { forget?: string }) => {
    const store = new Store(PATHS.db);
    if (opts.forget) console.log(`Forgot ${store.forget(opts.forget)} answer(s).`);
    else {
      const all = store.memory();
      if (!all.length) console.log("No remembered answers yet. apply remembers written answers from forms that filled cleanly.");
      for (const m of all) console.log(`${m.question}  (used ${m.uses}x)\n    ${m.answer}\n`);
    }
    store.close();
  });

program
  .command("daily [file]")
  .description("Apply to today's jobs from your Weekly Rhythm, using the resume and cover letter it wrote for each (see /daily)")
  .option("-n, --count <n>", "how many applications at most (default: apply.maxPerDay in your profile)")
  .option("--submit", "send each form that filled cleanly (without it, nothing is sent)")
  .option("--headless", "run without a visible window; a robot check is then left for you")
  .option("--no-top-up", "do not add jobs from your own boards when the day's list has fewer fillable jobs")
  .option("--no-discover", "do not look for new jobs on your own boards first")
  .option("--plan", "only print which of the day's jobs can be filled and which PDFs are needed, as JSON")
  .action(async (file: string | undefined, opts: { count?: string; submit?: boolean; headless?: boolean; topUp: boolean; discover: boolean; plan?: boolean }) => {
    const profile = loadProfile(PATHS.profile);
    const jobsFile = file ?? path.join(PATHS.rhythm, "jobs.json");
    const filesDir = path.join(PATHS.rhythm, "files");
    const count = opts.count === undefined ? profile.apply.maxPerDay : Number(opts.count);
    if (!Number.isInteger(count) || count < 1) throw new Error(`--count must be a whole number above 0, not "${opts.count}".`);
    const doc = existsSync(jobsFile) ? parseRhythm(readFileSync(jobsFile, "utf8")) : null;
    if (!doc) console.log(`No jobs file at ${jobsFile}; only jobs from your own boards will be used.`);
    const appliedIds = readJson<string[]>(path.join(PATHS.rhythm, "applied.json"), []);
    const store = new Store(PATHS.db);
    let session: Awaited<ReturnType<typeof openSession>> | null = null;
    try {
      if (opts.plan) {
        const plan = doc ? planDaily(store, doc, appliedIds) : { date: "", fillable: [], skipped: [] };
        const out = {
          date: plan.date,
          fillable: plan.fillable.slice(0, count).map((e) => ({ id: e.item.id, company: e.item.company, role: e.item.role, resumeBlob: blobId(e.item.resumePdf), coverBlob: blobId(e.item.coverPdf) })),
          skipped: plan.skipped.map((s) => ({ id: s.item.id, company: s.item.company, reason: s.reason })),
        };
        console.log(JSON.stringify(out, null, 2));
        return;
      }
      console.log(opts.submit ? "Daily run: sending each form that fills cleanly." : "Daily run (dry): forms are filled and checked, nothing is sent.");
      const r = await runDaily(store, profile, {
        doc,
        appliedIds,
        filesDir,
        count,
        submit: !!opts.submit,
        // With a hidden window, or no terminal to wait in, nobody can pass a robot check: it is left for you.
        headless: !!opts.headless || !process.stdin.isTTY,
        topUp: opts.topUp,
        refresh: opts.discover
          ? async () => {
              console.log("Looking for new jobs on your own boards...");
              const found = await discover(loadCompanies(PATHS.companies), profile, store);
              console.log(`  ${found.newKept} new match${found.newKept === 1 ? "" : "es"}.`);
            }
          : undefined,
        session: async () => (session = await openSession(PATHS.browser, { headless: !!opts.headless })),
        log: (l) => console.log(l),
      });
      for (const s of r.skipped) console.log(`  Skipped ${s.item.company}: ${s.item.role} (${s.reason})`);
      if (r.stopped) console.log(`Stopped: ${r.stopped}`);
      const tally = new Map<string, number>();
      for (const x of r.results) tally.set(x.state, (tally.get(x.state) ?? 0) + 1);
      console.log(tally.size ? `\n${[...tally].map(([s, n]) => `${n} ${s.replace("_", " ")}`).join(", ")}.` : "\nNothing to apply to today.");
      mkdirSync(PATHS.rhythm, { recursive: true });
      writeFileSync(
        path.join(PATHS.rhythm, "result.json"),
        JSON.stringify(
          { date: doc?.date ?? "", ranAt: new Date().toISOString(), submit: !!opts.submit, stopped: r.stopped, results: r.results, skipped: r.skipped.map((s) => ({ id: s.item.id, company: s.item.company, role: s.item.role, reason: s.reason, apply: s.item.apply })) },
          null,
          2,
        ),
      );
    } finally {
      await (session as Awaited<ReturnType<typeof openSession>> | null)?.close().catch(() => {});
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
