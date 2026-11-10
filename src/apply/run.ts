/**
 * The apply loop: for each job, open its form, have Claude map the fields from
 * your profile, fill them, read every value back, and send only a form that is
 * clean, only with --submit, and never twice. Anything else is left for you
 * with the reason.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { ApplicationState, Store, StoredJob } from "../db.js";
import { claudeCodeJson, type Runner } from "../model/claude-code.js";
import { FatalRaterError } from "../model/rating.js";
import { ROOT } from "../paths.js";
import type { Profile } from "../profile/schema.js";
import { fillForm, openForm, submitForm, type FieldResult, type Session } from "./browser.js";
import type { FormField } from "./form.js";
import { checkPlan, planJsonSchema, PlanSchema, promptFor, SYSTEM, type MappedForm } from "./map.js";

export type ApplyOptions = {
  ids?: string[];
  count?: number;
  submit: boolean;
  session: () => Promise<Session>;
  /** Swapped out in tests. */
  map?: (job: StoredJob, fields: FormField[], profile: Profile) => Promise<MappedForm>;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

export type JobOutcome = { job: StoredJob; state: ApplicationState; detail: string; fields: FieldResult[]; leftOpen: boolean };

/** Asks Claude Code what goes in each field, then checks the answer in code. */
export async function mapWithClaude(job: StoredJob, fields: FormField[], profile: Profile, run?: Runner): Promise<MappedForm> {
  const { value, usage } = await claudeCodeJson({
    command: profile.rating.command,
    model: profile.apply.model,
    effort: profile.apply.effort,
    system: SYSTEM,
    prompt: promptFor(job, fields, profile),
    schema: planJsonSchema(),
    run,
  });
  const plan = PlanSchema.safeParse(value);
  if (!plan.success) throw new Error("Claude's answer for this form could not be read");
  return { ...checkPlan(plan.data, fields, job, profile), usage };
}

export function resumeFile(profile: Profile): string | null {
  if (!profile.resumePath) return null;
  const file = path.isAbsolute(profile.resumePath) ? profile.resumePath : path.join(ROOT, profile.resumePath);
  return existsSync(file) ? file : null;
}

/** Jobs to apply to: those named, or the best ones not yet tried that have a form the tool can fill. */
export function pickJobs(store: Store, opts: { ids?: string[]; count?: number }): { jobs: StoredJob[]; notes: string[] } {
  const notes: string[] = [];
  if (opts.ids?.length) {
    const jobs: StoredJob[] = [];
    for (const id of opts.ids) {
      const job = store.get(id);
      if (!job) notes.push(`${id}: no such job`);
      else if (store.wasSent(id)) notes.push(`${id}: already sent (${job.company}: ${job.title}), not sent again`);
      else jobs.push(job);
    }
    return { jobs, notes };
  }
  const tried = (id: string) => store.applications(id, 1).length > 0;
  const candidates = store
    .visible(["shortlisted", "new"], 2000)
    .filter((j) => j.applyUrl && !tried(j.id))
    .sort((a, b) => (a.status === "shortlisted" ? 0 : 1) - (b.status === "shortlisted" ? 0 : 1) || b.score - a.score);
  return { jobs: candidates.slice(0, opts.count ?? 1), notes };
}

export async function applyJobs(store: Store, profile: Profile, opts: ApplyOptions): Promise<{ outcomes: JobOutcome[]; notes: string[]; stopped: string | null }> {
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const map = opts.map ?? ((job, fields, p) => mapWithClaude(job, fields, p));
  const resume = resumeFile(profile);
  if (!resume) return { outcomes: [], notes: [], stopped: `No resume found at "${profile.resumePath}". Set resumePath in your profile to your resume PDF.` };
  if (!profile.contact.email || !profile.contact.firstName) return { outcomes: [], notes: [], stopped: "Your profile has no contact details. Fill in contact (name, email, phone) first." };

  const { jobs, notes } = pickJobs(store, opts);
  const outcomes: JobOutcome[] = [];
  if (!jobs.length) return { outcomes, notes, stopped: null };

  const session = await opts.session();
  let lastSent = 0;
  let stopped: string | null = null;
  for (const job of jobs) {
    const record = (o: Omit<JobOutcome, "job">) => {
      store.addApplication({ jobId: job.id, mode: opts.submit ? "submit" : "dry", state: o.state, detail: o.detail, fields: o.fields });
      outcomes.push({ job, ...o });
      log(`${job.id}  ${o.state.toUpperCase().replace("_", " ")}  ${job.company}: ${job.title}\n           ${o.detail}`);
    };
    if (!job.applyUrl) {
      record({ state: "blocked", detail: `no form the tool can fill (${job.source} is not supported yet); apply at ${job.url}`, fields: [], leftOpen: false });
      continue;
    }
    if (opts.submit && store.sentToday() >= profile.apply.maxPerDay) {
      stopped = `reached today's limit of ${profile.apply.maxPerDay} applications (apply.maxPerDay)`;
      break;
    }

    let page;
    try {
      const opened = await openForm(session, job.applyUrl);
      page = opened.page;
      const { dump } = opened;
      if (dump.hasPassword) {
        await page.close();
        record({ state: "blocked", detail: "the form is behind a sign-in; apply yourself at " + job.url, fields: [], leftOpen: false });
        continue;
      }
      if (!dump.fields.length || !dump.submit) {
        await page.close();
        record({ state: "blocked", detail: "no application form found on the page", fields: [], leftOpen: false });
        continue;
      }

      const mapped = await map(job, dump.fields, profile);
      if (mapped.verdict === "skip") {
        await page.close();
        record({ state: "skipped", detail: mapped.reason, fields: [], leftOpen: false });
        continue;
      }
      const results = await fillForm(page, mapped.fields, resume);
      const problems = [...mapped.problems];
      for (const r of results) if (!r.ok) problems.push(`"${r.label}" shows "${r.shows}" instead of "${r.wanted}"`);
      for (const r of results) if (r.required && !r.shows && !r.wanted) problems.push(`"${r.label}" is required and empty`);
      const unique = [...new Set(problems)];

      if (unique.length) {
        record({ state: "left_for_you", detail: unique.slice(0, 6).join("; "), fields: results, leftOpen: true });
        continue;
      }
      if (!opts.submit) {
        record({ state: "ready", detail: "filled and checked; not sent (run with --submit to send)", fields: results, leftOpen: true });
        continue;
      }

      const gap = profile.apply.submitGapSeconds * 1000 - (Date.now() - lastSent);
      if (lastSent && gap > 0) await sleep(gap);
      const sent = await submitForm(page, dump.submit);
      lastSent = Date.now();
      if (sent.state === "submitted") {
        store.setStatus(job.id, "applied", "applied by the tool");
        await page.close();
      }
      record({ state: sent.state, detail: sent.detail, fields: results, leftOpen: sent.state !== "submitted" });
    } catch (err) {
      if (err instanceof FatalRaterError) {
        stopped = err.message;
        await page?.close().catch(() => {});
        break;
      }
      await page?.close().catch(() => {});
      record({ state: "blocked", detail: `something went wrong: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, fields: [], leftOpen: false });
    }
  }
  return { outcomes, notes, stopped };
}
