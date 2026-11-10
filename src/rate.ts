/**
 * Rate the best unrated jobs with a model, within the run's job and spend caps.
 * A posting that has not changed is never rated twice: ratings are cached by
 * `ratingKey`, and the next discover reuses them.
 */
import type { Store } from "./db.js";
import { scoreJob } from "./jobs/score.js";
import { FatalRaterError, ratingKey, type Rater } from "./model/rating.js";
import type { Profile } from "./profile/schema.js";

export type RateOptions = {
  /** At most this many jobs; the profile's maxJobsPerRun if not given. */
  limit?: number;
  /** Decides whether an error should stop the whole run, and says why. */
  isFatal?: (err: unknown) => string | null;
  onProgress?: (line: string) => void;
  now?: Date;
};

export type RateResult = {
  rated: number;
  /** Jobs the model could not rate, with why. */
  failed: { id: string; title: string; reason: string }[];
  /** Jobs left unrated because a cap was reached. */
  remaining: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Why the run stopped early, if it did. */
  stopped: string | null;
};

/** After this many failures in a row, something is wrong beyond one posting. */
const MAX_FAILURES_IN_A_ROW = 3;
/** Ratings only matter for jobs you have not acted on yet. */
const STATUSES = ["new", "shortlisted"] as const;
/** How many visible jobs to look through for unrated ones. */
const SCAN = 2000;

export async function rateJobs(store: Store, profile: Profile, rater: Rater, opts: RateOptions = {}): Promise<RateResult> {
  const now = opts.now ?? new Date();
  const cap = profile.rating.maxSpendPerRunUsd;
  const limit = opts.limit ?? profile.rating.maxJobsPerRun;
  const log = opts.onProgress ?? (() => {});

  const unrated = store
    .visible([...STATUSES], SCAN)
    .filter((job) => !store.rating(ratingKey(job, profile, rater.model)));
  const todo = unrated.slice(0, limit);
  const result: RateResult = { rated: 0, failed: [], remaining: unrated.length, costUsd: 0, inputTokens: 0, outputTokens: 0, stopped: null };

  let failuresInARow = 0;
  for (const job of todo) {
    // A Claude plan is not billed per token, so only a billed provider has a dollar cap.
    if (rater.billed && result.costUsd >= cap) {
      result.stopped = `reached the spend cap of $${cap.toFixed(2)}`;
      break;
    }
    let outcome;
    try {
      outcome = await rater.rate(job, profile);
    } catch (err) {
      const fatal = err instanceof FatalRaterError ? err.message : opts.isFatal?.(err);
      if (fatal) {
        result.stopped = fatal;
        break;
      }
      outcome = { ok: false as const, reason: err instanceof Error ? err.message : String(err), costUsd: 0, usage: null };
    }
    result.costUsd += outcome.costUsd;
    // Tokens read from the prompt cache are still input the model read.
    const u = outcome.usage;
    result.inputTokens += u ? u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens : 0;
    result.outputTokens += outcome.usage?.outputTokens ?? 0;

    if (!outcome.ok) {
      result.failed.push({ id: job.id, title: `${job.company}: ${job.title}`, reason: outcome.reason });
      log(`  ${job.id}  could not rate: ${outcome.reason}`);
      if (++failuresInARow >= MAX_FAILURES_IN_A_ROW) {
        result.stopped = `${MAX_FAILURES_IN_A_ROW} jobs in a row could not be rated`;
        break;
      }
      continue;
    }
    failuresInARow = 0;
    store.saveRating(ratingKey(job, profile, rater.model), job.id, outcome.model, outcome.rating, outcome.usage, outcome.costUsd, now);
    const { score, reasons } = scoreJob(job, profile, now, outcome.rating);
    store.setScore(job.id, score, reasons);
    store.addEvent(job.id, "rated", `fit ${outcome.rating.fit} by ${outcome.model}`, now);
    result.rated++;
    log(`  ${job.id}  ${String(outcome.rating.fit).padStart(3)}  ${job.company}: ${job.title}`);
  }
  result.remaining = unrated.length - result.rated - result.failed.length;
  return result;
}
