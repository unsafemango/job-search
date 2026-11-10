/**
 * All state in one SQLite file: every job seen, its score, where it stands
 * with you, and the history of what happened to it.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dedupeKey, type Job } from "./jobs/job.js";
import type { ScoreParts } from "./jobs/score.js";
import type { Rating, Usage } from "./model/rating.js";

export const STATUSES = ["new", "shortlisted", "applied", "replied", "interview", "offer", "rejected", "dismissed"] as const;
export type Status = (typeof STATUSES)[number];

export type StoredJob = Job & {
  level: string;
  score: number;
  reasons: string[];
  /** Why the filters dropped it, or null when it was kept. */
  filteredReason: string | null;
  status: Status;
  firstSeen: string;
  lastSeen: string;
};

export type JobEvent = { at: string; kind: string; note: string };

/** How a go at a job's form ended. */
export type ApplicationState =
  | "ready" // filled and checked, not sent (dry run)
  | "left_for_you" // filled, but something needs you before it can be sent
  | "skipped" // the form wants something the tool does not give (a cover letter, references)
  | "blocked" // no form could be filled: a sign-in, an unsupported board, an error page
  | "submitted" // sent, and the page confirmed it
  | "needs_you" // sent, waiting on a robot check or emailed code you finish in the window
  | "rejected" // the page refused the submission
  | "unconfirmed"; // Submit was clicked but no confirmation was seen

export type Application = { id: number; jobId: string; at: string; mode: string; state: ApplicationState; detail: string; fields: unknown };

/** An application still waiting on a reply, and how long it has waited. */
export type FollowUp = {
  job: StoredJob;
  /** When you applied or last followed up, whichever is later. */
  since: string;
  days: number;
  /** How many times you have followed up already. */
  followUps: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const STOP = new Set("a an the and or of to in for on at with your you do are is be by this that what which please any".split(" "));
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));

/** A question with the filler taken out, so the same question asked two ways shares a key. */
export function questionKey(q: string): string {
  return [...new Set(words(q))].sort().join(" ");
}

/** How alike two questions are, 0 to 1, by the words they share. */
export function similarity(a: string, b: string): number {
  const x = new Set(words(a));
  const y = new Set(words(b));
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/**
 * Kept jobs with duplicates hidden. Among jobs with the same dedupe key, the
 * one you have acted on wins, then the one seen first. A job you have acted on
 * (any status but "new") is never hidden.
 */
const VISIBLE = `
  SELECT * FROM (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY dedupe_key ORDER BY (status <> 'new') DESC, first_seen, id
    ) AS dup_rank
    FROM jobs WHERE filtered_reason IS NULL
  ) WHERE NOT (status = 'new' AND dup_rank > 1)`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  locations TEXT NOT NULL,
  remote INTEGER NOT NULL,
  posted_at TEXT,
  description TEXT NOT NULL,
  level TEXT NOT NULL,
  score INTEGER NOT NULL,
  reasons TEXT NOT NULL,
  filtered_reason TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_by_status ON jobs (status, score DESC);
CREATE TABLE IF NOT EXISTS ratings (
  key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  model TEXT NOT NULL,
  rating TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  rated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  at TEXT NOT NULL,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  detail TEXT NOT NULL,
  fields TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS applications_by_job ON applications (job_id);
CREATE TABLE IF NOT EXISTS answer_memory (
  key TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
`;

function fromRow(r: Record<string, any>): StoredJob {
  return {
    id: r.id,
    source: r.source,
    company: r.company,
    title: r.title,
    url: r.url,
    locations: JSON.parse(r.locations),
    remote: r.remote === 1,
    postedAt: r.posted_at,
    applyUrl: r.apply_url ?? null,
    description: r.description,
    level: r.level,
    score: r.score,
    reasons: JSON.parse(r.reasons),
    filteredReason: r.filtered_reason,
    status: r.status,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  };
}

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Brings a database made by an older version up to date. */
  private migrate(): void {
    const columns = (this.db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("dedupe_key")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN dedupe_key TEXT");
      const rows = this.db.prepare("SELECT * FROM jobs").all() as Record<string, any>[];
      const set = this.db.prepare("UPDATE jobs SET dedupe_key = ? WHERE id = ?");
      for (const r of rows) set.run(dedupeKey(fromRow(r)), r.id);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS jobs_by_dedupe_key ON jobs (dedupe_key)");
    if (!columns.includes("apply_url")) this.db.exec("ALTER TABLE jobs ADD COLUMN apply_url TEXT");
    if (!columns.includes("parts")) this.db.exec("ALTER TABLE jobs ADD COLUMN parts TEXT");
  }

  close(): void {
    this.db.close();
  }

  /** Adds a job or refreshes it. Your status and the date it was first seen are kept. Returns true when it is new. */
  upsert(job: Job, rated: { level: string; score: number; reasons: string[]; filteredReason: string | null; parts?: ScoreParts }, now = new Date()): boolean {
    const isNew = !this.db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(job.id);
    const at = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs (id, source, company, title, url, locations, remote, posted_at, description, level, score, reasons, filtered_reason, first_seen, last_seen, dedupe_key, apply_url, parts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           dedupe_key = excluded.dedupe_key, apply_url = excluded.apply_url, parts = COALESCE(excluded.parts, parts),
           company = excluded.company, title = excluded.title, url = excluded.url, locations = excluded.locations,
           remote = excluded.remote, posted_at = excluded.posted_at, description = excluded.description,
           level = excluded.level, score = excluded.score, reasons = excluded.reasons,
           filtered_reason = excluded.filtered_reason, last_seen = excluded.last_seen`,
      )
      .run(
        job.id, job.source, job.company, job.title, job.url, JSON.stringify(job.locations), job.remote ? 1 : 0,
        job.postedAt, job.description, rated.level, rated.score, JSON.stringify(rated.reasons), rated.filteredReason, at, at,
        dedupeKey(job),
        job.applyUrl ?? null,
        rated.parts ? JSON.stringify(rated.parts) : null,
      );
    if (isNew) this.addEvent(job.id, "seen", "", now);
    return isNew;
  }

  get(id: string): StoredJob | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? fromRow(row) : null;
  }

  /** Kept jobs with this status, best first, without duplicates. */
  list(status: Status, limit = 20): StoredJob[] {
    return this.db
      .prepare(`${VISIBLE} AND status = ? ORDER BY score DESC, posted_at DESC LIMIT ?`)
      .all(status, limit)
      .map(fromRow);
  }

  /** True when this job is kept but hidden because another posting is the same job. */
  isHiddenDuplicate(id: string): boolean {
    const job = this.db.prepare("SELECT filtered_reason FROM jobs WHERE id = ?").get(id) as { filtered_reason: string | null } | undefined;
    if (!job || job.filtered_reason !== null) return false;
    return !this.db.prepare(`SELECT 1 FROM (${VISIBLE}) WHERE id = ?`).get(id);
  }

  /** Other kept postings of the same job. */
  duplicatesOf(id: string): StoredJob[] {
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE filtered_reason IS NULL AND id <> ?
           AND dedupe_key = (SELECT dedupe_key FROM jobs WHERE id = ?) ORDER BY first_seen, id`,
      )
      .all(id, id)
      .map(fromRow);
  }

  setStatus(id: string, status: Status, note = "", now = new Date()): void {
    const result = this.db.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, id);
    if (result.changes === 0) throw new Error(`No job with id ${id}.`);
    this.addEvent(id, status, note, now);
  }

  addEvent(id: string, kind: string, note = "", now = new Date()): void {
    this.db.prepare("INSERT INTO events (job_id, at, kind, note) VALUES (?, ?, ?, ?)").run(id, now.toISOString(), kind, note);
  }

  events(id: string): JobEvent[] {
    return this.db.prepare("SELECT at, kind, note FROM events WHERE job_id = ? ORDER BY id").all(id) as JobEvent[];
  }

  /** Records that you followed up on an application. Its status stays the same; the wait starts again. */
  followedUp(id: string, note = "", now = new Date()): void {
    if (!this.get(id)) throw new Error(`No job with id ${id}.`);
    this.addEvent(id, "followed_up", note, now);
  }

  /**
   * Applications with no reply where at least `afterDays` have passed since you
   * applied or last followed up, longest wait first. A job you applied to stays
   * here even if a later discover drops it (for example, because the posting is
   * now too old).
   */
  followUps(afterDays: number, now = new Date()): FollowUp[] {
    const rows = this.db
      .prepare(
        `SELECT j.*,
           (SELECT MAX(at) FROM events e WHERE e.job_id = j.id AND e.kind IN ('applied', 'followed_up')) AS since,
           (SELECT COUNT(*) FROM events e WHERE e.job_id = j.id AND e.kind = 'followed_up') AS follow_ups
         FROM jobs j WHERE j.status = 'applied'`,
      )
      .all() as Record<string, any>[];
    return rows
      .filter((r) => r.since)
      .map((r) => ({
        job: fromRow(r),
        since: r.since as string,
        days: Math.floor((now.getTime() - new Date(r.since).getTime()) / DAY_MS),
        followUps: Number(r.follow_ups),
      }))
      .filter((f) => f.days >= afterDays)
      .sort((a, b) => b.days - a.days || b.job.score - a.job.score);
  }

  /** Records one go at a job's form. */
  addApplication(a: { jobId: string; mode: "dry" | "submit"; state: ApplicationState; detail: string; fields: unknown }, now = new Date()): void {
    this.db
      .prepare("INSERT INTO applications (job_id, at, mode, state, detail, fields) VALUES (?, ?, ?, ?, ?, ?)")
      .run(a.jobId, now.toISOString(), a.mode, a.state, a.detail, JSON.stringify(a.fields));
  }

  /** Every go at forms, newest first; one job's when `jobId` is given. */
  applications(jobId?: string, limit = 50): Application[] {
    const rows = (jobId
      ? this.db.prepare("SELECT * FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT ?").all(jobId, limit)
      : this.db.prepare("SELECT * FROM applications ORDER BY id DESC LIMIT ?").all(limit)) as Record<string, any>[];
    return rows.map((r) => ({ id: r.id, jobId: r.job_id, at: r.at, mode: r.mode, state: r.state, detail: r.detail, fields: JSON.parse(r.fields) }));
  }

  /**
   * Whether a job's form was sent, or may have been: submitted, waiting on
   * you, or clicked without a confirmation. Such a job is never sent again.
   */
  wasSent(jobId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM applications WHERE job_id = ? AND state IN ('submitted', 'needs_you', 'unconfirmed') LIMIT 1")
      .get(jobId);
  }

  /**
   * True when another posting of the same job (same company, title and places, or the very same
   * application form) was already sent or applied to.
   */
  sentDuplicate(id: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM jobs me, jobs j WHERE me.id = ? AND j.id <> me.id
           AND (j.dedupe_key = me.dedupe_key OR (me.apply_url IS NOT NULL AND j.apply_url = me.apply_url))
           AND (j.status IN ('applied', 'replied', 'interview', 'offer', 'rejected')
                OR EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id AND a.state IN ('submitted', 'needs_you', 'unconfirmed'))) LIMIT 1`,
      )
      .get(id);
    return !!row;
  }

  /** Applications sent since local midnight. */
  sentToday(now = new Date()): number {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM applications WHERE state IN ('submitted', 'needs_you', 'unconfirmed') AND at >= ?")
      .get(midnight.toISOString()) as { n: number };
    return row.n;
  }

  /** Remembers an answer you gave to a form question, so later forms can reuse it. */
  remember(question: string, answer: string, now = new Date()): void {
    const key = questionKey(question);
    if (!key || !answer.trim()) return;
    this.db
      .prepare(
        `INSERT INTO answer_memory (key, question, answer, uses, updated_at) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT (key) DO UPDATE SET answer = excluded.answer, uses = uses + 1, updated_at = excluded.updated_at`,
      )
      .run(key, question.trim(), answer.trim(), now.toISOString());
  }

  /** Remembered answers to questions like these, closest first. */
  recall(questions: string[], limit = 12): { question: string; answer: string }[] {
    const rows = this.db.prepare("SELECT question, answer FROM answer_memory ORDER BY updated_at DESC").all() as { question: string; answer: string }[];
    const scored = rows
      .map((r) => ({ ...r, score: Math.max(0, ...questions.map((q) => similarity(q, r.question))) }))
      .filter((r) => r.score >= 0.5)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ question, answer }) => ({ question, answer }));
  }

  /** Every remembered answer, or those whose question or answer contains `text`. */
  memory(text = ""): { question: string; answer: string; uses: number }[] {
    return this.db
      .prepare("SELECT question, answer, uses FROM answer_memory WHERE question LIKE ? OR answer LIKE ? ORDER BY updated_at DESC")
      .all(`%${text}%`, `%${text}%`) as { question: string; answer: string; uses: number }[];
  }

  /** Forgets the remembered answers whose question or answer contains `text`; returns how many. */
  forget(text: string): number {
    return Number(this.db.prepare("DELETE FROM answer_memory WHERE question LIKE ? OR answer LIKE ?").run(`%${text}%`, `%${text}%`).changes);
  }

  /** A cached rating, by `ratingKey`. */
  rating(key: string): Rating | null {
    const row = this.db.prepare("SELECT rating FROM ratings WHERE key = ?").get(key) as { rating: string } | undefined;
    return row ? (JSON.parse(row.rating) as Rating) : null;
  }

  saveRating(key: string, jobId: string, model: string, rating: Rating, usage: Usage, costUsd: number, now = new Date()): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ratings (key, job_id, model, rating, input_tokens, output_tokens, cost_usd, rated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(key, jobId, model, JSON.stringify(rating), usage.inputTokens, usage.outputTokens, costUsd, now.toISOString());
  }

  /** Every rating ever made, and what they cost. */
  ratingTotals(): { n: number; costUsd: number } {
    const row = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost FROM ratings").get() as { n: number; cost: number };
    return { n: row.n, costUsd: row.cost };
  }

  /** Kept, visible jobs in these statuses, best first: the ones worth rating. */
  visible(statuses: Status[], limit: number): StoredJob[] {
    const marks = statuses.map(() => "?").join(", ");
    return this.db
      .prepare(`${VISIBLE} AND status IN (${marks}) ORDER BY score DESC, posted_at DESC LIMIT ?`)
      .all(...statuses, limit)
      .map(fromRow);
  }

  setScore(id: string, score: number, reasons: string[], parts?: ScoreParts): void {
    this.db
      .prepare("UPDATE jobs SET score = ?, reasons = ?, parts = COALESCE(?, parts) WHERE id = ?")
      .run(score, JSON.stringify(reasons), parts ? JSON.stringify(parts) : null, id);
  }

  /** Sent applications with their score parts and whether they got a positive reply, for `learn`. */
  outcomes(): { id: string; status: Status; parts: ScoreParts; positive: boolean }[] {
    const rows = this.db
      .prepare("SELECT id, status, parts FROM jobs WHERE status IN ('applied', 'replied', 'interview', 'offer', 'rejected') AND parts IS NOT NULL")
      .all() as { id: string; status: Status; parts: string }[];
    return rows.map((r) => ({ id: r.id, status: r.status, parts: JSON.parse(r.parts) as ScoreParts, positive: ["replied", "interview", "offer"].includes(r.status) }));
  }

  /** How many kept jobs are in each status, without duplicates. */
  counts(): Record<Status, number> {
    const out = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM (${VISIBLE}) GROUP BY status`).all();
    for (const r of rows as { status: Status; n: number }[]) out[r.status] = r.n;
    return out;
  }

  /** Why jobs were dropped, most common first. */
  filteredCounts(): { reason: string; n: number }[] {
    return this.db
      .prepare(
        `SELECT CASE WHEN filtered_reason LIKE 'posted %' THEN 'too old' ELSE filtered_reason END AS reason, COUNT(*) AS n
         FROM jobs WHERE filtered_reason IS NOT NULL GROUP BY reason ORDER BY n DESC`,
      )
      .all() as { reason: string; n: number }[];
  }
}
