/** Fetch every company's board, filter and score each posting, and store the lot. */
import type { Store } from "./db.js";
import { filterJob, levelOf } from "./jobs/filters.js";
import type { Job } from "./jobs/job.js";
import { scoreJob } from "./jobs/score.js";
import type { Profile } from "./profile/schema.js";
import { fetchCompany, type Company } from "./sources/index.js";

export type DiscoverResult = {
  fetched: number;
  kept: number;
  newKept: number;
  failures: { company: string; error: string }[];
};

/** Rates and stores jobs already fetched. Separate from the network so it can be tested. */
export function ingest(jobs: Job[], profile: Profile, store: Store, now = new Date()): { kept: number; newKept: number } {
  let kept = 0;
  let newKept = 0;
  for (const job of jobs) {
    const filteredReason = filterJob(job, profile, now);
    const { score, reasons } = filteredReason ? { score: 0, reasons: [] } : scoreJob(job, profile, now);
    const isNew = store.upsert(job, { level: levelOf(job.title), score, reasons, filteredReason }, now);
    if (!filteredReason) {
      kept++;
      if (isNew) newKept++;
    }
  }
  return { kept, newKept };
}

const BATCH = 5;

export async function discover(
  companies: Company[],
  profile: Profile,
  store: Store,
  fetchOne: (c: Company) => Promise<Job[]> = fetchCompany,
  now = new Date(),
): Promise<DiscoverResult> {
  const result: DiscoverResult = { fetched: 0, kept: 0, newKept: 0, failures: [] };
  for (let i = 0; i < companies.length; i += BATCH) {
    const batch = companies.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map((c) => fetchOne(c)));
    settled.forEach((s, k) => {
      const company = batch[k]!;
      if (s.status === "rejected") {
        result.failures.push({ company: company.name, error: s.reason instanceof Error ? s.reason.message : String(s.reason) });
        return;
      }
      result.fetched += s.value.length;
      const { kept, newKept } = ingest(s.value, profile, store, now);
      result.kept += kept;
      result.newKept += newKept;
    });
  }
  return result;
}
