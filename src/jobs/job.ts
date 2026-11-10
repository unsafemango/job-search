import { createHash } from "node:crypto";
import type { Level } from "../profile/schema.js";

export type SourceName = "greenhouse" | "lever" | "ashby" | "github" | "workday" | "csv" | "rhythm";

/** One posting, in the same shape whichever board it came from. */
export type Job = {
  id: string;
  source: SourceName;
  company: string;
  title: string;
  url: string;
  locations: string[];
  remote: boolean;
  /** ISO date, or null when the board does not say. */
  postedAt: string | null;
  /** Plain text. Empty when the board gives none. */
  description: string;
  /** The level the source says this job is, used when the title states none (e.g. a new-grad list). */
  level?: Level;
  /** The application form itself, when the board has one `apply` can fill. */
  applyUrl?: string | null;
};

/**
 * The form for a posting link on a board `apply` can fill (Greenhouse, Lever,
 * Ashby), or null.
 */
export function applyUrlFor(url: string, company?: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  // A company's own careers page that embeds Greenhouse carries the posting id as gh_jid. The board is
  // usually named after the company, so that is tried; a wrong guess just finds no form and is left for you.
  const ghJid = u.searchParams.get("gh_jid");
  if (ghJid && /^\d+$/.test(ghJid) && company && !/greenhouse\.io$/.test(u.hostname)) {
    const board = company.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return board ? `https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${ghJid}` : null;
  }
  const parts = u.pathname.split("/").filter(Boolean);
  if (/(^|\.)greenhouse\.io$/.test(u.hostname)) {
    const token = u.searchParams.get("token") ?? (parts[1] === "jobs" ? parts[2] : undefined);
    const board = u.searchParams.get("for") ?? parts[0];
    return board && token && /^\d+$/.test(token) ? `https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${token}` : null;
  }
  if (u.hostname === "jobs.lever.co" && parts.length >= 2) return `https://jobs.lever.co/${parts[0]}/${parts[1]}/apply`;
  if (u.hostname === "jobs.ashbyhq.com" && parts.length >= 2) return `https://jobs.ashbyhq.com/${parts[0]}/${parts[1]}/application`;
  return null;
}

/** A short, stable id: the same posting gets the same id on every run. */
export function jobId(source: SourceName, slug: string, externalId: string): string {
  return createHash("sha1").update(`${source}:${slug}:${externalId}`).digest("hex").slice(0, 8);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** HTML, possibly entity-escaped (Greenhouse escapes it once), to plain text. */
export function htmlToText(html: string): string {
  const unescaped = /&lt;\w/.test(html) ? decodeEntities(html) : html;
  return decodeEntities(unescaped.replace(/<(br|\/p|\/li|\/h\d|\/div)[^>]*>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Lowercase, no accents, no punctuation, single spaces. */
function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();
}

const COMPANY_SUFFIX = /\s+(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc)$/;

/**
 * The same posting on two boards, or posted twice on one, gets the same key:
 * company, title and places, ignoring case, punctuation, accents and order.
 */
export function dedupeKey(job: Pick<Job, "company" | "title" | "locations" | "remote">): string {
  const company = normalize(job.company).replace(COMPANY_SUFFIX, "");
  const places = [...new Set(job.locations.map(normalize).filter(Boolean))].sort();
  const where = places.length ? places.join(";") : job.remote ? "remote" : "";
  return `${company}|${normalize(job.title)}|${where}`;
}

export function ageDays(job: Pick<Job, "postedAt">, now = new Date()): number | null {
  if (!job.postedAt) return null;
  const t = Date.parse(job.postedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/** True when `term` appears in `text` as a whole word. Works for "C++", "C#" and ".NET". */
export function hasTerm(text: string, term: string): boolean {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i").test(text);
}
