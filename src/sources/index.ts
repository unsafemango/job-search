/**
 * Job boards with a public, documented posting API. Each source has a
 * `parse` (pure, tested offline) and a `url`; fetching is shared.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { htmlToText, jobId, type Job, type SourceName } from "../jobs/job.js";

export const CompanySchema = z.object({
  source: z.enum(["greenhouse", "lever", "ashby"]),
  /** The company's name in the board's URL, e.g. boards.greenhouse.io/<slug>. */
  slug: z.string().min(1),
  name: z.string().min(1),
});
export type Company = z.infer<typeof CompanySchema>;

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

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isRemoteText = (s: string): boolean => /\bremote\b/i.test(s);
/** "Toronto, ON; Remote - Canada" and "A | B" are several places. */
const splitPlaces = (s: string): string[] => s.split(/\s*[;|•]\s*/).map((p) => p.trim()).filter(Boolean);
const unique = (xs: string[]): string[] => [...new Set(xs)];

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
        };
      });
  },
};

export const SOURCES: Record<SourceName, Source> = { greenhouse, lever, ashby };

export async function fetchCompany(company: Company, fetchFn: typeof fetch = fetch): Promise<Job[]> {
  const source = SOURCES[company.source];
  const res = await fetchFn(source.url(company.slug), {
    headers: { accept: "application/json", "user-agent": "job-search-tool" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${company.source} returned ${res.status} for "${company.slug}"`);
  return source.parse(await res.json(), company).filter((j) => j.title && j.url);
}
