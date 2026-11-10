/**
 * A model-rated fit: what a model makes of one posting against your profile.
 * Providers implement `Rater`; everything else only sees this shape.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Job } from "../jobs/job.js";
import { LEVELS, type Profile } from "../profile/schema.js";

export const RatingSchema = z.object({
  fit: z.number().int().min(0).max(100).describe("Overall fit of this job for the candidate, 0 (none) to 100 (ideal)"),
  level: z.enum(LEVELS).describe("The level the job is really hiring for, judged from the whole posting, not just the title"),
  stack: z.array(z.string()).describe("The candidate's skills that this job uses"),
  unmet: z
    .array(z.string())
    .describe("Hard requirements in the posting that the profile shows the candidate does not meet, e.g. '5+ years of experience' or 'US citizenship required'. Empty when none."),
  summary: z.string().describe("One plain sentence on why the fit is what it is"),
});
export type Rating = z.infer<typeof RatingSchema>;

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export type RaterResult =
  | { ok: true; rating: Rating; usage: Usage; costUsd: number; model: string }
  | { ok: false; reason: string; usage: Usage; costUsd: number };

export interface Rater {
  /** The model ratings are cached under. */
  readonly model: string;
  rate(job: Job, profile: Profile): Promise<RaterResult>;
}

/** Bump when the prompt or schema changes in a way that should re-rate everything. */
export const RATING_VERSION = 1;

/**
 * The cache key: the posting as the model sees it, the parts of the profile the
 * model sees, and the model. Change any of them and the job is rated again.
 */
export function ratingKey(job: Job, profile: Profile, model: string): string {
  const posting = { company: job.company, title: job.title, locations: job.locations, remote: job.remote, description: job.description };
  return createHash("sha256")
    .update(JSON.stringify([RATING_VERSION, model, posting, profileForModel(profile)]))
    .digest("hex")
    .slice(0, 32);
}

/** What the model is told about you. Your name is left out. */
export function profileForModel(profile: Profile) {
  return {
    targetTitles: profile.target.titles,
    levels: profile.target.levels,
    skills: profile.skills,
    places: profile.locations.include.map((p) => p.match),
    openToRemote: profile.locations.remote,
    background: profile.background,
  };
}
