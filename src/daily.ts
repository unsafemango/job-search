/**
 * The daily run: the jobs your Weekly Rhythm found today, applied to
 * automatically, using the resume and cover letter it already wrote for each.
 * Jobs on boards the app cannot fill are listed for you; if fewer than the
 * daily count can be filled, the best new jobs from your own boards make up
 * the rest. Nothing is sent unless asked, and only forms that checked out.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { applyJobs, type ApplyOptions, type JobDocuments, type JobOutcome } from "./apply/run.js";
import type { Store, StoredJob } from "./db.js";
import { applyUrlFor, jobId, type Job } from "./jobs/job.js";
import type { Profile } from "./profile/schema.js";
import { coverLetterText, existingDocuments, prepareDocuments } from "./resume/documents.js";
import { splitPlaces } from "./sources/common.js";

const ItemSchema = z.object({
  id: z.string().min(1),
  company: z.string().min(1),
  role: z.string().min(1),
  apply: z.string().url(),
  location: z.string().default(""),
  pay: z.string().default(""),
  resumePdf: z.string().default(""),
  coverPdf: z.string().default(""),
  resumePdfName: z.string().default(""),
  coverPdfName: z.string().default(""),
});
export type RhythmItem = z.infer<typeof ItemSchema>;
export type RhythmDoc = { date: string; items: RhythmItem[] };

/** Reads a day's jobs as saved from the Weekly Rhythm; items that are not usable are left out. */
export function parseRhythm(text: string): RhythmDoc {
  const raw = JSON.parse(text) as { date?: unknown; items?: unknown; data?: { date?: unknown; items?: unknown } };
  const body = raw.items ? raw : (raw.data ?? {});
  const date = typeof body.date === "string" ? body.date : "";
  const items = (Array.isArray(body.items) ? body.items : []).flatMap((i) => {
    const parsed = ItemSchema.safeParse(i);
    return parsed.success && /^https:\/\//.test(parsed.data.apply) ? [parsed.data] : [];
  });
  return { date, items };
}

/** The asset id in "/_blob/<id>", or null. */
export function blobId(url: string): string | null {
  return /^\/_blob\/([A-Za-z0-9_-]+)$/.exec(url)?.[1] ?? null;
}

/** Where a downloaded PDF is kept. */
export function blobFile(filesDir: string, url: string): string | null {
  const id = blobId(url);
  return id ? path.join(filesDir, `${id}.pdf`) : null;
}

export function rhythmJob(item: RhythmItem, date: string): Job {
  const locations = splitPlaces(item.location);
  return {
    id: jobId("rhythm", "weekly", `${date}:${item.id}`),
    source: "rhythm",
    company: item.company,
    title: item.role,
    url: item.apply,
    applyUrl: applyUrlFor(item.apply, item.company),
    locations,
    remote: /remote/i.test(item.location),
    postedAt: date ? `${date}T00:00:00.000Z` : null,
    description: "",
    level: /\b(senior|sr\.?|lead|staff|principal)\b/i.test(item.role) ? "senior" : "mid",
  };
}

export type PlanEntry = { item: RhythmItem; job: StoredJob };
export type Skipped = { item: RhythmItem; job: StoredJob; reason: string };
export type Plan = { date: string; fillable: PlanEntry[]; skipped: Skipped[] };

/**
 * Sorts a day's jobs into those the app can fill and those it cannot, and
 * never plans one that is already ticked in the Weekly Rhythm or was already
 * sent (even as another posting of the same job or the same form). Pure
 * apart from storing the jobs.
 */
export function planDaily(store: Store, doc: RhythmDoc, appliedIds: string[], now = new Date()): Plan {
  const fillable: PlanEntry[] = [];
  const skipped: Skipped[] = [];
  const stored = doc.items.map((item) => {
    const job = rhythmJob(item, doc.date);
    store.upsert(job, { level: job.level ?? "mid", score: 100, reasons: ["from your Weekly Rhythm"], filteredReason: null }, now);
    return { item, job: store.get(job.id)! };
  });
  for (const { item, job } of stored) {
    const skip = (reason: string) => skipped.push({ item, job, reason });
    if (appliedIds.includes(item.id)) skip("already ticked as applied in your Weekly Rhythm");
    else if (store.wasSent(job.id) || store.sentDuplicate(job.id)) skip("already applied to");
    else if (!job.applyUrl) skip(`${new URL(item.apply).host} is not a board the app can fill`);
    else fillable.push({ item, job });
  }
  return { date: doc.date, fillable, skipped };
}

/** The best new jobs from your own boards that the app can fill, for when the day's list falls short. */
export function pickTopUp(store: Store, need: number, exclude: StoredJob[]): StoredJob[] {
  if (need <= 0) return [];
  const taken = new Set(exclude.map((j) => j.applyUrl).filter(Boolean));
  const ids = new Set(exclude.map((j) => j.id));
  return store
    .visible(["shortlisted", "new"], 2000)
    .filter((j) => j.applyUrl && !ids.has(j.id) && !taken.has(j.applyUrl) && store.applications(j.id, 1).length === 0 && !store.sentDuplicate(j.id))
    .sort((a, b) => (a.status === "shortlisted" ? 0 : 1) - (b.status === "shortlisted" ? 0 : 1) || b.score - a.score)
    .slice(0, need);
}

export type DailyResult = {
  /** Rhythm item id, or null for a job added from your own boards. */
  itemId: string | null;
  jobId: string;
  company: string;
  role: string;
  state: string;
  detail: string;
  apply: string;
};

export type DailyOptions = {
  doc: RhythmDoc | null;
  appliedIds: string[];
  filesDir: string;
  count: number;
  submit: boolean;
  headless: boolean;
  /** Add jobs from your own boards when the day's list has fewer fillable jobs than `count`. */
  topUp: boolean;
  /** Called once, only if a top-up is needed, to find new jobs first. */
  refresh?: () => Promise<void>;
  session: ApplyOptions["session"];
  log?: (line: string) => void;
  /** Swapped out in tests. */
  map?: ApplyOptions["map"];
  now?: Date;
};

export async function runDaily(store: Store, profile: Profile, opts: DailyOptions): Promise<{ results: DailyResult[]; skipped: Skipped[]; notes: string[]; stopped: string | null }> {
  const log = opts.log ?? (() => {});
  const plan = opts.doc ? planDaily(store, opts.doc, opts.appliedIds, opts.now) : { date: "", fillable: [], skipped: [] };
  const todo = plan.fillable.slice(0, opts.count);
  const itemOf = new Map(todo.map((e) => [e.job.id, e.item]));

  // Jobs the app cannot fill are put on your Needs you list, once, with the link.
  for (const s of plan.skipped) {
    if (s.reason.startsWith("already")) continue;
    if (store.applications(s.job.id, 1).length === 0) {
      store.addApplication({ jobId: s.job.id, mode: opts.submit ? "submit" : "dry", state: "blocked", detail: `${s.reason}; apply yourself at ${s.item.apply}`, fields: [] });
    }
  }

  let topUp: StoredJob[] = [];
  const need = opts.count - todo.length;
  if (opts.topUp && need > 0) {
    await opts.refresh?.();
    topUp = pickTopUp(store, need, [...plan.fillable.map((e) => e.job), ...plan.skipped.map((s) => s.job)]);
  }
  log(`${todo.length} from your Weekly Rhythm, ${plan.skipped.length} skipped${need > 0 ? `, ${topUp.length} added from your own boards` : ""}.`);

  const ids = [...todo.map((e) => e.job.id), ...topUp.map((j) => j.id)];
  if (!ids.length) return { results: [], skipped: plan.skipped, notes: [], stopped: null };

  // A rhythm job brings its own resume and cover letter; a job added from your boards uses your resume,
  // and gets a written cover letter only when its form needs one.
  const docsFor = (job: StoredJob): JobDocuments | null => {
    const item = itemOf.get(job.id);
    if (!item) return null;
    const resume = blobFile(opts.filesDir, item.resumePdf);
    const cover = blobFile(opts.filesDir, item.coverPdf);
    return {
      resume: resume && existsSync(resume) ? resume : null,
      coverLetter: cover && existsSync(cover) ? cover : null,
      coverText: null,
      ...(item.resumePdfName ? { resumeName: item.resumePdfName } : {}),
      ...(item.coverPdfName ? { coverName: item.coverPdfName } : {}),
    };
  };
  const prepare = async (job: StoredJob, cover: boolean): Promise<JobDocuments> => {
    const own = docsFor(job);
    if (own) return own;
    if (!cover) return { resume: null, coverLetter: null, coverText: null };
    await prepareDocuments(job, profile, { cover: true });
    const have = existingDocuments(profile, job.id);
    return { resume: have.resume, coverLetter: have.coverLetter, coverText: have.coverLetter ? coverLetterText(job.id, profile) : null };
  };
  const cleanup = (job: StoredJob) => {
    const item = itemOf.get(job.id);
    if (!item) return;
    for (const url of [item.resumePdf, item.coverPdf]) {
      const file = blobFile(opts.filesDir, url);
      if (file) rmSync(file, { force: true });
    }
  };

  const applied = await applyJobs(store, profile, {
    ids,
    submit: opts.submit,
    headless: opts.headless,
    tailor: false,
    session: opts.session,
    log: opts.log,
    prepare,
    cleanup,
    ...(opts.map ? { map: opts.map } : {}),
  });
  const results = applied.outcomes.map((o: JobOutcome): DailyResult => ({
    itemId: itemOf.get(o.job.id)?.id ?? null,
    jobId: o.job.id,
    company: o.job.company,
    role: o.job.title,
    state: o.state,
    detail: o.detail,
    apply: o.job.url,
  }));
  return { results, skipped: plan.skipped, notes: applied.notes, stopped: applied.stopped };
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
