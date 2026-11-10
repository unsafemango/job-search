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
} as const;
