/** The Claude provider for `Rater`, through the official Anthropic SDK. */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Job } from "../jobs/job.js";
import type { Profile } from "../profile/schema.js";
import { costUsd } from "./pricing.js";
import { profileForModel, RatingSchema, type Rater, type RaterResult, type Rating, type Usage } from "./rating.js";

/**
 * Models that accept a server-side fallback. When the model declines a request,
 * the API retries it on the model Anthropic recommends instead of returning a refusal.
 */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

const INSTRUCTIONS = `You help one candidate decide which job postings are worth applying to. You get the candidate's profile once, then one posting at a time, and you rate how well the posting fits them.

Judge from what the posting actually asks for, not only its title: the work, the stack, the seniority it is really hiring at, and any hard requirements (years of experience, degree, citizenship, clearance, location). A posting the candidate clearly cannot get, such as one needing 5+ years when they are a new graduate, should get a low fit even if the skills match. Only list a requirement as unmet when the profile shows the candidate does not meet it; if the profile does not say, leave it out. If the posting has little detail, say so in the summary and rate on what is there.`;

function usageOf(u: Anthropic.Beta.BetaUsage | undefined): Usage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

function postingText(job: Job): string {
  const where = job.locations.join("; ") || (job.remote ? "Remote" : "not stated");
  return [
    `Company: ${job.company}`,
    `Title: ${job.title}`,
    `Location: ${where}${job.remote ? " (remote possible)" : ""}`,
    "",
    job.description || "(The source gives no description for this posting.)",
  ].join("\n");
}

export class ClaudeRater implements Rater {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: "low" | "medium" | "high";

  constructor(opts: { model: string; effort: "low" | "medium" | "high"; client?: Anthropic }) {
    this.model = opts.model;
    this.effort = opts.effort;
    this.client = opts.client ?? new Anthropic();
  }

  async rate(job: Job, profile: Profile): Promise<RaterResult> {
    const fallback = FALLBACK_MODELS.has(this.model);
    // create, not parse: parse throws on a cut-off answer before its usage can be
    // counted, and every request's cost must reach the spend cap. The answer is
    // validated against the same schema below.
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 8000,
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      output_config: { effort: this.effort, format: betaZodOutputFormat(RatingSchema) },
      system: `${INSTRUCTIONS}\n\nThe candidate's profile:\n${JSON.stringify(profileForModel(profile), null, 2)}`,
      messages: [{ role: "user", content: `Rate this posting.\n\n${postingText(job)}` }],
    });

    const usage = usageOf(response.usage);
    // Price by the model that answered: a fallback may have served it.
    const cost = costUsd(usage, response.model || this.model);
    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category;
      return { ok: false, reason: `the model declined${category ? ` (${category})` : ""}`, usage, costUsd: cost };
    }
    if (response.stop_reason === "max_tokens") return { ok: false, reason: "the answer was cut off", usage, costUsd: cost };
    const rating = readRating(response.content);
    if (!rating) return { ok: false, reason: "the answer could not be read", usage, costUsd: cost };
    return { ok: true, rating, usage, costUsd: cost, model: response.model || this.model };
  }
}

/** The rating in a response's text, checked against the schema (including the 0 to 100 range), or null. */
function readRating(content: Anthropic.Beta.BetaContentBlock[]): Rating | null {
  const text = content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    const parsed = RatingSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Errors that will fail every job the same way, so a run should stop rather than carry on. */
export function isFatal(err: unknown): string | null {
  if (err instanceof Anthropic.AuthenticationError) {
    return "The Anthropic API key is missing or not valid. Put ANTHROPIC_API_KEY=... in .env, or run `ant auth login`.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) return `This API key cannot use that model: ${err.message}`;
  if (err instanceof Anthropic.NotFoundError) return `Model not found. Check rating.model in your profile: ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API, even after retries. Try again later.";
  if (err instanceof Anthropic.APIConnectionError) return `Could not reach the Anthropic API: ${err.message}`;
  if (err instanceof Error && /credentials|api key|apiKey|authToken/i.test(err.message) && !(err instanceof Anthropic.APIError)) {
    return "No Anthropic credentials found. Put ANTHROPIC_API_KEY=... in .env, or run `ant auth login`.";
  }
  return null;
}
