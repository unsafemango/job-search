/**
 * Jobs from a CSV file you made or exported, for boards with no API.
 * The header row names the columns; only company, title and url are required.
 */
import { jobId, type Job } from "../jobs/job.js";
import { LEVELS, type Level } from "../profile/schema.js";
import { isRemoteText, splitPlaces } from "./common.js";

export const CSV_COLUMNS = ["company", "title", "url", "location", "remote", "posted", "description", "level"] as const;
const REQUIRED = ["company", "title", "url"] as const;
const ALIASES: Record<string, (typeof CSV_COLUMNS)[number]> = {
  locations: "location",
  link: "url",
  "posted at": "posted",
  date: "posted",
  role: "title",
  "job title": "title",
};

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim()));
}

export type CsvResult = { jobs: Job[]; errors: { line: number; error: string }[] };

export function parseCsvJobs(text: string): CsvResult {
  const [header, ...rows] = parseCsv(text);
  if (!header) return { jobs: [], errors: [{ line: 1, error: "the file is empty" }] };
  const names = header.map((h) => {
    const n = h.trim().toLowerCase();
    return ALIASES[n] ?? n;
  });
  const missing = REQUIRED.filter((r) => !names.includes(r));
  if (missing.length) return { jobs: [], errors: [{ line: 1, error: `missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}` }] };

  const out: CsvResult = { jobs: [], errors: [] };
  rows.forEach((cells, i) => {
    const line = i + 2;
    const get = (col: string): string => (cells[names.indexOf(col)] ?? "").trim();
    const empty = REQUIRED.filter((r) => !get(r));
    if (empty.length) return out.errors.push({ line, error: `no ${empty.join(", ")}` });

    const posted = get("posted");
    const postedMs = posted ? Date.parse(posted) : NaN;
    if (posted && Number.isNaN(postedMs)) return out.errors.push({ line, error: `"${posted}" is not a date` });
    const level = get("level").toLowerCase().replace(/[\s-]+/g, "_");
    if (level && !(LEVELS as readonly string[]).includes(level)) {
      return out.errors.push({ line, error: `level "${get("level")}" is not one of ${LEVELS.join(", ")}` });
    }

    const locations = splitPlaces(get("location"));
    out.jobs.push({
      id: jobId("csv", "import", get("url")),
      source: "csv",
      company: get("company"),
      title: get("title"),
      url: get("url"),
      locations,
      remote: /^(y|yes|true|1|remote)$/i.test(get("remote")) || locations.some(isRemoteText),
      postedAt: Number.isNaN(postedMs) ? null : new Date(postedMs).toISOString(),
      description: get("description"),
      ...(level ? { level: level as Level } : {}),
    });
  });
  return out;
}
