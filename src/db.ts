/**
 * All state in one SQLite file: every job seen, its score, where it stands
 * with you, and the history of what happened to it.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Job } from "./jobs/job.js";

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
  }

  close(): void {
    this.db.close();
  }

  /** Adds a job or refreshes it. Your status and the date it was first seen are kept. Returns true when it is new. */
  upsert(job: Job, rated: { level: string; score: number; reasons: string[]; filteredReason: string | null }, now = new Date()): boolean {
    const isNew = !this.db.prepare("SELECT 1 FROM jobs WHERE id = ?").get(job.id);
    const at = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs (id, source, company, title, url, locations, remote, posted_at, description, level, score, reasons, filtered_reason, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           company = excluded.company, title = excluded.title, url = excluded.url, locations = excluded.locations,
           remote = excluded.remote, posted_at = excluded.posted_at, description = excluded.description,
           level = excluded.level, score = excluded.score, reasons = excluded.reasons,
           filtered_reason = excluded.filtered_reason, last_seen = excluded.last_seen`,
      )
      .run(
        job.id, job.source, job.company, job.title, job.url, JSON.stringify(job.locations), job.remote ? 1 : 0,
        job.postedAt, job.description, rated.level, rated.score, JSON.stringify(rated.reasons), rated.filteredReason, at, at,
      );
    if (isNew) this.addEvent(job.id, "seen", "", now);
    return isNew;
  }

  get(id: string): StoredJob | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? fromRow(row) : null;
  }

  /** Kept jobs with this status, best first. */
  list(status: Status, limit = 20): StoredJob[] {
    return this.db
      .prepare("SELECT * FROM jobs WHERE status = ? AND filtered_reason IS NULL ORDER BY score DESC, posted_at DESC LIMIT ?")
      .all(status, limit)
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

  /** How many kept jobs are in each status. */
  counts(): Record<Status, number> {
    const out = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM jobs WHERE filtered_reason IS NULL GROUP BY status").all();
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
