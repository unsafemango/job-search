/**
 * Workday careers sites (<tenant>.wdN.myworkdayjobs.com/<site>). The search
 * returns titles, links and a rough "Posted N Days Ago"; the place, exact date
 * and description need one more request per job. So the board is searched for
 * your target titles, and details are fetched only for postings whose title
 * you would keep.
 */
import { titleReason } from "../jobs/filters.js";
import { htmlToText, jobId, type Job } from "../jobs/job.js";
import { getJson, isRemoteText, str, unique, type Company, type FetchContext } from "./common.js";

const PAGE = 20;
/** Pages read per search term. */
const MAX_PAGES = 5;
/** Postings whose details are fetched, per board. */
const MAX_DETAILS = 40;
const CONCURRENCY = 4;
const DAY_MS = 86_400_000;

export type WorkdayBoard = { host: string; tenant: string; site: string };

/** Reads "https://acme.wd5.myworkdayjobs.com/en-US/Careers" or "acme.wd5.myworkdayjobs.com/Careers". */
export function workdayBoard(slug: string): WorkdayBoard {
  const url = new URL(/^https?:\/\//.test(slug) ? slug : `https://${slug}`);
  const site = url.pathname.split("/").filter((p) => p && !/^[a-z]{2}-[A-Z]{2}$/.test(p))[0];
  if (!url.hostname.endsWith(".myworkdayjobs.com") || !site) {
    throw new Error(`"${slug}" is not a Workday careers site. Use a URL like acme.wd5.myworkdayjobs.com/Careers.`);
  }
  return { host: url.hostname, tenant: url.hostname.split(".")[0]!, site };
}

const api = (b: WorkdayBoard): string => `https://${b.host}/wday/cxs/${b.tenant}/${b.site}`;
const publicUrl = (b: WorkdayBoard, path: string): string => `https://${b.host}/${b.site}${path}`;

/** "Posted Today", "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago" to a date. */
export function parsePostedOn(text: string, now = new Date()): string | null {
  const t = text.toLowerCase();
  const days = /today/.test(t) ? 0 : /yesterday/.test(t) ? 1 : Number(/(\d+)\+?\s*days?/.exec(t)?.[1] ?? NaN);
  if (!Number.isFinite(days)) return null;
  return new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10) + "T00:00:00.000Z";
}

type ListItem = { title: string; externalPath: string; locationsText: string; postedOn: string };

/** A posting from the search alone. "2 Locations" is not a place, so it is left out. */
export function parseWorkdayItem(item: ListItem, board: WorkdayBoard, company: Company, now = new Date()): Job {
  const place = /^\d+ locations?$/i.test(item.locationsText.trim()) ? [] : [item.locationsText.trim()].filter(Boolean);
  return {
    id: jobId("workday", `${board.tenant}/${board.site}`, item.externalPath),
    source: "workday",
    company: company.name,
    title: item.title.trim(),
    url: publicUrl(board, item.externalPath),
    locations: place,
    remote: place.some(isRemoteText),
    postedAt: parsePostedOn(item.postedOn, now),
    description: "",
    ...(company.level ? { level: company.level } : {}),
  };
}

/** Fills in the place, date and description from a posting's detail response. */
export function applyWorkdayDetail(job: Job, body: unknown): Job {
  const info = (body as { jobPostingInfo?: Record<string, any> })?.jobPostingInfo;
  if (!info) return job;
  const extra = Array.isArray(info.additionalLocations) ? (info.additionalLocations as unknown[]).map(str) : [];
  const locations = unique([str(info.location), ...extra].map((s) => s.trim()).filter(Boolean));
  const start = str(info.startDate);
  return {
    ...job,
    title: str(info.title).trim() || job.title,
    locations: locations.length ? locations : job.locations,
    remote: /remote/i.test(str(info.remoteType)) || (locations.length ? locations : job.locations).some(isRemoteText),
    postedAt: /^\d{4}-\d{2}-\d{2}/.test(start) ? `${start.slice(0, 10)}T00:00:00.000Z` : job.postedAt,
    description: htmlToText(str(info.jobDescription)),
  };
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export async function fetchWorkday(company: Company, ctx: FetchContext, now = new Date()): Promise<Job[]> {
  const board = workdayBoard(company.slug);
  const label = `Workday (${board.tenant}/${board.site})`;
  const terms = ctx.profile?.target.titles.length ? ctx.profile.target.titles : [""];

  const found = new Map<string, ListItem>();
  for (const searchText of terms) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const { status, body } = await getJson(ctx, `${api(board)}/jobs`, label, {
        method: "POST",
        body: { appliedFacets: {}, limit: PAGE, offset: page * PAGE, searchText },
      });
      if (status === 404) throw new Error(`${label} was not found; check the careers site URL`);
      const res = body as { total?: number; jobPostings?: Record<string, unknown>[] };
      const items = res?.jobPostings ?? [];
      for (const j of items) {
        const item = { title: str(j.title), externalPath: str(j.externalPath), locationsText: str(j.locationsText), postedOn: str(j.postedOn) };
        if (item.title && item.externalPath) found.set(item.externalPath, item);
      }
      if (items.length < PAGE || (page + 1) * PAGE >= (res?.total ?? 0)) break;
    }
  }

  const jobs = [...found.values()].map((item) => parseWorkdayItem(item, board, company, now));
  const profile = ctx.profile;
  const wanted = profile ? jobs.filter((j) => titleReason(j, profile) === null) : jobs;
  const toDetail = new Set(wanted.slice(0, MAX_DETAILS).map((j) => j.id));
  return pool(jobs, CONCURRENCY, async (job) => {
    if (!toDetail.has(job.id)) return job;
    const path = new URL(job.url).pathname.slice(board.site.length + 1);
    try {
      const { body } = await getJson(ctx, `${api(board)}${path}`, label);
      return applyWorkdayDetail(job, body);
    } catch {
      return job; // The search result is still worth keeping.
    }
  });
}
