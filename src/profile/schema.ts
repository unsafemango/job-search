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
  /** What application forms ask for. Only `apply` uses it; it never leaves your machine except into the forms you apply through. */
  contact: z
    .object({
      firstName: z.string().default(""),
      lastName: z.string().default(""),
      preferredName: z.string().default(""),
      email: z.string().default(""),
      phone: z.string().default(""),
      city: z.string().default(""),
      region: z.string().default(""),
      country: z.string().default(""),
      postalCode: z.string().default(""),
      linkedin: z.string().default(""),
      website: z.string().default(""),
      github: z.string().default(""),
    })
    .prefault({}),
  /** The resume file attached to applications (PDF). Relative paths are from the project folder. */
  resumePath: z.string().default(""),
  /**
   * Standing answers to the questions most forms ask. A form question these do
   * not settle, and the profile does not answer, is left for you.
   */
  answers: z
    .object({
      /** Countries you may work in without sponsorship. */
      authorizedCountries: z.array(z.string()).default([]),
      /** Per country: does working there need visa sponsorship, now or in future. Countries not listed: yes. */
      needsSponsorship: z.record(z.string(), z.boolean()).default({}),
      /** One line on your status, e.g. "Open work permit (PGWP)". */
      workPermit: z.string().default(""),
      /** Expected salary by level, in `salaryCurrency`. */
      salary: z
        .object({
          mid: z.number().optional(),
          senior: z.number().optional(),
          minimum: z.number().optional(),
          currency: z.string().default("CAD"),
        })
        .prefault({}),
      noticePeriod: z.string().default(""),
      yearsOfExperience: z.number().optional(),
      currentCompany: z.string().default(""),
      currentTitle: z.string().default(""),
      howDidYouHear: z.string().default("Company careers page"),
      /** Voluntary self-identification. Leave a field empty to decline it. */
      demographics: z
        .object({
          gender: z.string().default(""),
          pronouns: z.string().default(""),
          race: z.string().default(""),
          sexualOrientation: z.string().default(""),
          disability: z.string().default(""),
          veteran: z.string().default(""),
        })
        .prefault({}),
      /**
       * Whether to tick boxes that acknowledge a privacy notice or consent to
       * processing your application. Never covers signing a contract or NDA.
       */
      acknowledgePrivacyNotices: z.boolean().default(false),
      /** Anything else, as question: answer, e.g. "Willing to work hybrid in Toronto": "Yes". */
      other: z.record(z.string(), z.string()).default({}),
    })
    .prefault({}),
  /** How `apply` fills forms. */
  apply: z
    .object({
      model: z.string().min(1).default("claude-opus-5-5"),
      effort: z.enum(["low", "medium", "high"]).default("medium"),
      /** Seconds to wait between two submissions. */
      submitGapSeconds: z.number().nonnegative().default(45),
      /** At most this many applications are sent per day. */
      maxPerDay: z.number().int().positive().default(15),
    })
    .prefault({}),
  /**
   * Score weights learned from your outcomes by `learn` (they sum to 100).
   * Leave unset for the defaults: title 35, skills 35, location 20, recency 10.
   */
  scoreWeights: z
    .object({ title: z.number().min(0), skills: z.number().min(0), location: z.number().min(0), recency: z.number().min(0) })
    .optional(),
  /** How `rate` uses a model to judge fit. */
  rating: z
    .object({
      /**
       * "claude-code": your local Claude Code, signed in with your Claude plan; no API key, no per-token bill.
       * "api": the Anthropic API with ANTHROPIC_API_KEY, billed per token.
       */
      provider: z.enum(["claude-code", "api"]).default("claude-code"),
      /** The Claude Code command, for the "claude-code" provider. */
      command: z.string().min(1).default("claude"),
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
