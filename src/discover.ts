/** Fetch every company's board, filter and score each posting, and store the lot. */
import type { Store } from "./db.js";
import { filterJob, jobLevel } from "./jobs/filters.js";
import type { Job } from "./jobs/job.js";
import { scoreJob } from "./jobs/score.js";
import { ratingKey } from "./model/rating.js";
import type { Profile } from "./profile/schema.js";
import { fetchCompany, type Company } from "./sources/index.js";

export type DiscoverResult = {
  fetched: number;
  kept: number;
  newKept: number;
  /** Matching postings hidden because they are the same job as another one. */
  duplicates: number;
  failures: { company: string; error: string }[];
};

type IngestResult = { kept: number; newKept: number; duplicates: number };

/** Rates and stores jobs already fetched. Separate from the network so it can be tested. */
export function ingest(jobs: Job[], profile: Profile, store: Store, now = new Date()): IngestResult {
  const out: IngestResult = { kept: 0, newKept: 0, duplicates: 0 };
  for (const job of jobs) {
    const filteredReason = filterJob(job, profile, now);
    // A rating made earlier still counts while the posting and your profile are unchanged.
    const rating = filteredReason ? null : store.rating(ratingKey(job, profile, profile.rating.model));
    const { score, reasons } = filteredReason ? { score: 0, reasons: [] } : scoreJob(job, profile, now, rating);
    const isNew = store.upsert(job, { level: jobLevel(job), score, reasons, filteredReason }, now);
    if (filteredReason) continue;
    if (store.isHiddenDuplicate(job.id)) {
      out.duplicates++;
      continue;
    }
    out.kept++;
    if (isNew) out.newKept++;
  }
  return out;
}

const BATCH = 5;

export async function discover(
  companies: Company[],
  profile: Profile,
  store: Store,
  fetchOne: (c: Company) => Promise<Job[]> = (c) => fetchCompany(c, fetch, profile),
  now = new Date(),
): Promise<DiscoverResult> {
  const result: DiscoverResult = { fetched: 0, kept: 0, newKept: 0, duplicates: 0, failures: [] };
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
      const { kept, newKept, duplicates } = ingest(s.value, profile, store, now);
      result.kept += kept;
      result.newKept += newKept;
      result.duplicates += duplicates;
    });
  }
  return result;
}
