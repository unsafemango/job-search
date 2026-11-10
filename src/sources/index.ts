/**
 * Where jobs come from. Greenhouse, Lever and Ashby have one public JSON
 * response per company: each has a `parse` (pure, tested offline) and a `url`.
 * GitHub lists and Workday sites need more requests and live in their own
 * files. CSV files are imported by hand (csv.ts).
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { applyUrlFor, htmlToText, jobId, type Job } from "../jobs/job.js";
import type { Profile } from "../profile/schema.js";
import { CompanySchema, isRemoteText, splitPlaces, str, unique, USER_AGENT, type Company } from "./common.js";
import { fetchGithub } from "./github.js";
import { fetchWorkday } from "./workday.js";

export { CompanySchema, type Company } from "./common.js";

export function loadCompanies(file: string): Company[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`No company list at ${file}. Run "npm run job -- init" and edit it.`);
  }
  return z.array(CompanySchema).parse(JSON.parse(text));
}

type Source = { url: (slug: string) => string; parse: (body: unknown, company: Company) => Job[] };

const greenhouse: Source = {
  url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
  parse(body, company) {
    const jobs = (body as { jobs?: unknown[] })?.jobs ?? [];
    return (jobs as Record<string, any>[]).map((j) => {
      const locations = splitPlaces(str(j.location?.name));
      return {
        id: jobId("greenhouse", company.slug, String(j.id)),
        source: "greenhouse",
        company: company.name,
        title: str(j.title).trim(),
        url: str(j.absolute_url),
        locations,
        remote: locations.some(isRemoteText),
        postedAt: str(j.first_published) || str(j.updated_at) || null,
        description: htmlToText(str(j.content)),
        // The board's own form, even when the posting links to the company's careers site.
        applyUrl: `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(company.slug)}&token=${String(j.id)}`,
      };
    });
  },
};

const lever: Source = {
  url: (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
  parse(body, company) {
    const jobs = Array.isArray(body) ? (body as Record<string, any>[]) : [];
    return jobs.map((j) => {
      const all = Array.isArray(j.categories?.allLocations) ? (j.categories.allLocations as unknown[]).map(str) : [];
      const locations = unique([...splitPlaces(str(j.categories?.location)), ...all].filter(Boolean));
      return {
        id: jobId("lever", company.slug, String(j.id)),
        source: "lever",
        company: company.name,
        title: str(j.text).trim(),
        url: str(j.hostedUrl),
        locations,
        remote: str(j.workplaceType) === "remote" || locations.some(isRemoteText),
        postedAt: typeof j.createdAt === "number" ? new Date(j.createdAt).toISOString() : null,
        description: str(j.descriptionPlain).trim() || htmlToText(str(j.description)),
        applyUrl: str(j.applyUrl) || applyUrlFor(str(j.hostedUrl)),
      };
    });
  },
};

const ashby: Source = {
  url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
  parse(body, company) {
    const jobs = (body as { jobs?: unknown[] })?.jobs ?? [];
    return (jobs as Record<string, any>[])
      .filter((j) => j.isListed !== false)
      .map((j) => {
        const secondary = Array.isArray(j.secondaryLocations)
          ? (j.secondaryLocations as Record<string, unknown>[]).map((s) => str(s.location))
          : [];
        const locations = unique([str(j.location), ...secondary].filter(Boolean));
        return {
          id: jobId("ashby", company.slug, String(j.id)),
          source: "ashby",
          company: company.name,
          title: str(j.title).trim(),
          url: str(j.jobUrl) || str(j.applyUrl),
          locations,
          remote: j.isRemote === true || locations.some(isRemoteText),
          postedAt: str(j.publishedAt) || null,
          description: str(j.descriptionPlain).trim() || htmlToText(str(j.descriptionHtml)),
          applyUrl: applyUrlFor(str(j.jobUrl)) ?? (str(j.applyUrl) || null),
        };
      });
  },
};

/** Boards with one JSON response per company. */
export const SOURCES = { greenhouse, lever, ashby } satisfies Record<string, Source>;

export async function fetchCompany(company: Company, fetchFn: typeof fetch = fetch, profile?: Profile): Promise<Job[]> {
  const ctx = { fetchFn, profile };
  let jobs: Job[];
  if (company.source === "github") jobs = await fetchGithub(company, ctx);
  else if (company.source === "workday") jobs = await fetchWorkday(company, ctx);
  else {
    const source = SOURCES[company.source];
    const res = await fetchFn(source.url(company.slug), {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${company.source} returned ${res.status} for "${company.slug}"`);
    jobs = source.parse(await res.json(), company);
  }
  return jobs.filter((j) => j.title && j.url);
}
