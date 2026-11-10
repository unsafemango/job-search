/**
 * The profile: who you are and what you are looking for. Every filter and
 * every score reads from here, so nothing about one person lives in code.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

export const LEVELS = ["internship", "new_grad", "mid", "senior"] as const;
export type Level = (typeof LEVELS)[number];

const Place = z.object({
  /** Text looked for in a posting's location: a city, a region or a country. */
  match: z.string().min(1),
  /** How much you want to work there, 0 to 1. */
  weight: z.number().min(0).max(1).default(1),
});

export const ProfileSchema = z.object({
  name: z.string().min(1),
  target: z.object({
    /** A job is kept when its title contains one of these. */
    titles: z.array(z.string().min(1)).min(1),
    /** A job is dropped when its title contains one of these. */
    excludeKeywords: z.array(z.string()).default([]),
    levels: z.array(z.enum(LEVELS)).min(1),
  }),
  locations: z.object({
    include: z.array(Place).default([]),
    /** A location containing one of these is ignored, e.g. "United States" to drop "Remote - United States". */
    exclude: z.array(z.string()).default([]),
    remote: z.boolean().default(true),
    remoteWeight: z.number().min(0).max(1).default(0.8),
  }),
  skills: z.array(z.string().min(1)).default([]),
  excludeCompanies: z.array(z.string()).default([]),
  maxPostingAgeDays: z.number().int().positive().default(45),
  /** An application with no reply is due a follow-up this many days after you applied or last followed up. */
  followUpAfterDays: z.number().int().positive().default(7),
  /**
   * What the model should know about you beyond skills: degree and graduation
   * date, experience, work authorization. Used only by `rate`.
   */
  background: z.string().default(""),
  /** How `rate` uses a model to judge fit. */
  rating: z
    .object({
      model: z.string().min(1).default("claude-opus-5-5"),
      effort: z.enum(["low", "medium", "high"]).default("low"),
      /** At most this many jobs are rated per run. */
      maxJobsPerRun: z.number().int().positive().default(25),
      /** A run stops once its estimated cost reaches this, in US dollars. */
      maxSpendPerRunUsd: z.number().positive().default(1),
    })
    .prefault({}),
});

export type Profile = z.infer<typeof ProfileSchema>;

export function parseProfile(raw: unknown): Profile {
  const result = ProfileSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`The profile is not valid:\n${lines.join("\n")}`);
  }
  return result.data;
}

export function loadProfile(file: string): Profile {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`No profile at ${file}. Run "npm run job -- init" and edit it.`);
  }
  return parseProfile(JSON.parse(text));
}
