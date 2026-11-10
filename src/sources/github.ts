/**
 * Job lists kept on GitHub in the SimplifyJobs format, such as
 * SimplifyJobs/New-Grad-Positions and SimplifyJobs/Summer2026-Internships.
 * One list covers many companies. The lists have no job descriptions.
 */
import { applyUrlFor, jobId, type Job } from "../jobs/job.js";
import { getJson, isRemoteText, str, type Company, type FetchContext } from "./common.js";

const REPO = /^[\w.-]+\/[\w.-]+$/;
const BRANCHES = ["dev", "main", "master"];

export function githubUrl(repo: string, branch: string): string {
  return `https://raw.githubusercontent.com/${repo}/${branch}/.github/scripts/listings.json`;
}

/** Only postings that are still open and shown on the list. */
export function parseGithub(body: unknown, company: Company): Job[] {
  const items = Array.isArray(body) ? (body as Record<string, any>[]) : [];
  return items
    .filter((j) => j.active !== false && j.is_visible !== false)
    .map((j) => {
      const locations = Array.isArray(j.locations) ? (j.locations as unknown[]).map(str).filter(Boolean) : [];
      return {
        id: jobId("github", company.slug, String(j.id)),
        source: "github" as const,
        company: str(j.company_name).trim(),
        title: str(j.title).trim(),
        url: str(j.url),
        applyUrl: applyUrlFor(str(j.url)),
        locations,
        remote: locations.some(isRemoteText),
        postedAt: typeof j.date_posted === "number" ? new Date(j.date_posted * 1000).toISOString() : null,
        description: "",
        ...(company.level ? { level: company.level } : {}),
      };
    })
    .filter((j) => j.company);
}

export async function fetchGithub(company: Company, ctx: FetchContext): Promise<Job[]> {
  if (!REPO.test(company.slug)) throw new Error(`"${company.slug}" is not a GitHub repo. Use "owner/repo".`);
  // Lists keep their data on different branches; try the usual ones.
  for (const branch of BRANCHES) {
    const { status, body } = await getJson(ctx, githubUrl(company.slug, branch), `GitHub (${company.slug})`, { timeoutMs: 60_000 });
    if (status !== 404) return parseGithub(body, company);
  }
  throw new Error(`no listings.json found in ${company.slug} (tried ${BRANCHES.join(", ")})`);
}
