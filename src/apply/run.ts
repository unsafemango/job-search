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
import { PATHS, ROOT } from "../paths.js";
import type { Profile } from "../profile/schema.js";
import { coverLetterName, coverLetterText, deleteDocuments, existingDocuments, prepareDocuments, resumeName } from "../resume/documents.js";
import { fillForm, isLocationField, openForm, submitForm, type FieldResult, type Session, type Uploads } from "./browser.js";
import type { FormField } from "./form.js";
import { checkPlan, isCoverField, planJsonSchema, PlanSchema, promptFor, SYSTEM, type CoverAnswer, type MappedForm, type Remembered } from "./map.js";

const CONTACT = /\b(name|e-?mail|phone|linkedin|github|website|portfolio|url|twitter|location|city|address|country|province|state|postal|zip|company|title|pronouns?)\b/i;

/** A field whose answer is worth remembering: a written question, not a contact detail. */
export function isQuestion(f: FormField): boolean {
  return (f.kind === "textarea" || f.kind === "text") && f.label.length > 25 && !CONTACT.test(f.label.split(/[?.]/)[0]!.slice(0, 40));
}

export type ApplyOptions = {
  ids?: string[];
  count?: number;
  submit: boolean;
  session: () => Promise<Session>;
  /** Write a resume (and a cover letter when needed) for each job first. Default: on, when data/resume.json exists. */
  tailor?: boolean;
  /** Swapped out in tests. */
  map?: (job: StoredJob, fields: FormField[], profile: Profile, memory: Remembered[], cover?: CoverAnswer) => Promise<MappedForm>;
  /** Swapped out in tests: the documents for one job. */
  prepare?: (job: StoredJob, cover: boolean) => Promise<JobDocuments>;
  /** Called once a job's application is confirmed sent, to delete what was made for it. */
  cleanup?: (job: StoredJob) => void;
  /** Nobody is watching the window: a robot check cannot be passed, so the form is left for you instead. */
  headless?: boolean;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

/** What a job's form gets: a resume (tailored, or your own), and a cover letter if one was written. */
export type JobDocuments = {
  resume: string | null;
  coverLetter: string | null;
  coverText: string | null;
  /** The names employers see on the uploads; First_Last_Resume.pdf and First_Last_Cover_Letter.pdf when not given. */
  resumeName?: string;
  coverName?: string;
};

export type JobOutcome = { job: StoredJob; state: ApplicationState; detail: string; fields: FieldResult[]; leftOpen: boolean };

/** Asks Claude Code what goes in each field, then checks the answer in code. */
export async function mapWithClaude(
  job: StoredJob,
  fields: FormField[],
  profile: Profile,
  memory: Remembered[] = [],
  cover?: CoverAnswer,
  run?: Runner,
): Promise<MappedForm> {
  const { value, usage } = await claudeCodeJson({
    command: profile.rating.command,
    model: profile.apply.model,
    effort: profile.apply.effort,
    system: SYSTEM,
    prompt: promptFor(job, fields, profile, memory),
    schema: planJsonSchema(),
    run,
  });
  const plan = PlanSchema.safeParse(value);
  if (!plan.success) throw new Error("Claude's answer for this form could not be read");
  return { ...checkPlan(plan.data, fields, job, profile, cover), usage };
}

/** Your own resume file, from the profile. */
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
  const map = opts.map ?? ((job, fields, p, memory, cover) => mapWithClaude(job, fields, p, memory, cover));
  const resume = resumeFile(profile);
  const tailor = opts.tailor ?? existsSync(PATHS.resumeData);
  // A resume written for each job, and a cover letter when the form needs one; your own resume otherwise.
  const prepare =
    opts.prepare ??
    (async (job: StoredJob, cover: boolean): Promise<JobDocuments> => {
      if (!tailor) return { resume, coverLetter: null, coverText: null };
      let have = existingDocuments(profile, job.id);
      if (!have.resume || (cover && !have.coverLetter)) {
        log(`${job.id}  writing a resume${cover ? " and cover letter" : ""} for ${job.company}...`);
        await prepareDocuments(job, profile, { cover });
        have = existingDocuments(profile, job.id);
      }
      return { resume: have.resume ?? resume, coverLetter: have.coverLetter, coverText: have.coverLetter ? coverLetterText(job.id, profile) : null };
    });
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

      // A cover letter goes in whenever the form has a box for one, even an optional one. A job that already
      // has its own (from your Weekly Rhythm) is only attached; otherwise one is written, and checked.
      const coverField = dump.fields.find(isCoverField);
      const docs = await prepare(job, !!coverField);
      const cover: CoverAnswer | undefined =
        coverField && docs.coverLetter
          ? { id: coverField.id, values: coverField.kind === "file" ? ["cover_letter"] : docs.coverText ? [docs.coverText] : [] }
          : undefined;
      const uploads: Uploads = {
        resume: { path: docs.resume ?? resume, name: docs.resumeName ?? resumeName(profile) },
        ...(docs.coverLetter ? { cover: { path: docs.coverLetter, name: docs.coverName ?? coverLetterName(profile) } } : {}),
      };

      const questions = dump.fields.filter(isQuestion).map((f) => f.label);
      // A required question the reader could not read cannot be answered, so the form is not sent.
      const unread = dump.unread.map((q) => `a required question could not be read: "${q.slice(0, 80)}"`);
      const mapped = await map(job, dump.fields, profile, store.recall(questions), cover);
      if (coverField?.required && !cover) mapped.problems.push("the form needs a cover letter, and none could be written that your facts support");
      if (mapped.verdict === "skip") {
        await page.close();
        record({ state: "skipped", detail: mapped.reason, fields: [], leftOpen: false });
        continue;
      }
      // A location box that picks from a list may not have your city: nearby places from your profile are tried after it.
      for (const plan of mapped.fields) {
        if (isLocationField(plan.field) && plan.values.length) plan.values = [...plan.values, ...profile.contact.fallbackLocations];
      }
      const results = await fillForm(page, mapped.fields, uploads);
      const problems = [...mapped.problems, ...unread];
      // A field you did not have to fill, left empty by the page, is not worth holding the application for;
      // one that shows a different value than wanted is.
      for (const r of results) if (!r.ok && (r.required || r.shows)) problems.push(`"${r.label}" shows "${r.shows}" instead of "${r.wanted}"`);
      for (const r of results) if (r.required && !r.shows && !r.wanted) problems.push(`"${r.label}" is required and empty`);
      const unique = [...new Set(problems)].map((p) => (p.length > 240 ? `${p.slice(0, 237)}...` : p));

      if (unique.length) {
        record({ state: "left_for_you", detail: unique.slice(0, 6).join("; "), fields: results, leftOpen: true });
        continue;
      }
      // Free-text answers that filled cleanly are remembered for the next form that asks.
      for (const plan of mapped.fields) if (isQuestion(plan.field) && plan.values[0]) store.remember(plan.field.label, plan.values[0]);
      if (!opts.submit) {
        record({ state: "ready", detail: "filled and checked; not sent (run with --submit to send)", fields: results, leftOpen: true });
        continue;
      }

      const gap = profile.apply.submitGapSeconds * 1000 - (Date.now() - lastSent);
      if (lastSent && gap > 0) await sleep(gap);
      const sent = await submitForm(page, dump.submit);
      lastSent = Date.now();
      // With nobody at the window a robot check cannot be passed; it was not sent, so it stays open to try again.
      if (opts.headless && sent.state === "needs_you" && /robot check/i.test(sent.detail)) {
        await page.close();
        record({ state: "left_for_you", detail: `${sent.detail}. Apply yourself at ${job.url}`, fields: results, leftOpen: false });
        continue;
      }
      if (sent.state === "submitted") {
        store.setStatus(job.id, "applied", "applied by the tool");
        await page.close();
        // The resume and cover letter were made for this one application; it is sent, so they go.
        if (deleteDocuments(job.id)) log(`${job.id}  deleted its tailored resume and cover letter`);
        opts.cleanup?.(job);
      }
      record({ state: sent.state, detail: sent.detail, fields: results, leftOpen: sent.state !== "submitted" });
    } catch (err) {
      if (err instanceof FatalRaterError) {
        stopped = err.message;
        await page?.close().catch(() => {});
        break;
      }
      await page?.close().catch(() => {});
      // The first lines of a browser error name what it was doing ("waiting for locator(...)"), which says what failed.
      const why = err instanceof Error ? err.message.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" ") : String(err);
      record({ state: "blocked", detail: `something went wrong: ${why.slice(0, 300)}`, fields: [], leftOpen: false });
    }
  }
  return { outcomes, notes, stopped };
}
