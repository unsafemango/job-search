import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where your files live. JOB_SEARCH_DATA points it elsewhere (tests, a second profile). */
export const DATA = process.env.JOB_SEARCH_DATA ?? path.join(ROOT, "data");

export const PATHS = {
  profile: path.join(DATA, "profile.json"),
  profileExample: path.join(ROOT, "data", "profile.example.json"),
  companies: path.join(DATA, "companies.json"),
  companiesExample: path.join(ROOT, "data", "companies.example.json"),
  db: path.join(DATA, "jobs.db"),
  /** Your resume as data, the source of every tailored resume. */
  resumeData: path.join(DATA, "resume.json"),
  /** How you write (optional), for tailored resumes and cover letters. */
  voice: path.join(DATA, "voice.md"),
  /** Your answer bank (optional): saved answers and facts that written form answers draw on. */
  answers: path.join(DATA, "answers.md"),
  /** Your LinkedIn connections export, for `referrals`. */
  connections: path.join(DATA, "connections.csv"),
  /** Tailored resumes, one folder per job. */
  tailored: path.join(DATA, "tailored"),
  /** The Weekly Rhythm's jobs for today, their PDFs, and what the daily run did. */
  rhythm: path.join(DATA, "rhythm"),
  /** The apply browser's own profile: its cookies and sign-ins, apart from your everyday browser. */
  browser: path.join(DATA, "browser"),
} as const;
