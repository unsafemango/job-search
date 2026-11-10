/**
 * The local Claude Code provider for `Rater`: runs `claude -p` (headless mode)
 * once per job, signed in with your Claude plan. No API key and no per-token
 * bill; calls count against your plan's usage limits instead.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { Job } from "../jobs/job.js";
import type { Profile } from "../profile/schema.js";
import { checkRating, INSTRUCTIONS, postingText } from "./claude.js";
import { FatalRaterError, profileForModel, RatingSchema, type Rater, type RaterResult, type Usage } from "./rating.js";

export type RunResult = { code: number | null; stdout: string; stderr: string };
/** Runs a command with text on stdin. Swapped out in tests. */
export type Runner = (command: string, args: string[], stdin: string, opts: { timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<RunResult>;

const TIMEOUT_MS = 180_000;

/**
 * The rating schema for --json-schema. Number limits are left out (structured
 * output does not accept them); the 0 to 100 range is checked after.
 */
export function ratingJsonSchema(): object {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node)
          .filter(([k]) => !["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "$schema"].includes(k))
          .map(([k, v]) => [k, strip(v)]),
      );
    }
    return node;
  };
  return strip(z.toJSONSchema(RatingSchema)) as object;
}

/**
 * The environment for the child. API credentials are removed so Claude Code
 * uses your Claude sign-in, never a key from .env that would bill per token.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.ANTHROPIC_API_KEY;
  delete out.ANTHROPIC_AUTH_TOKEN;
  return out;
}

export const runCommand: Runner = (command, args, stdin, { timeoutMs, env }) =>
  new Promise((resolve, reject) => {
    // An empty working directory: with no tools the model cannot read files, and nothing loads project settings.
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], cwd: tmpdir(), env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Claude Code did not answer in ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        e.code === "ENOENT"
          ? new FatalRaterError(`Claude Code is not installed (no "${command}" command). Install it, sign in once by running "claude", then try again.`)
          : e,
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });

type Envelope = {
  is_error?: boolean;
  subtype?: string;
  result?: unknown;
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};

/**
 * One headless Claude Code call that must answer in `schema`. Returns the
 * parsed answer (not yet validated) and the tokens used. Throws a
 * FatalRaterError when Claude Code is missing, signed out or out of usage.
 */
export async function claudeCodeJson(opts: {
  command: string;
  model: string;
  effort: "low" | "medium" | "high";
  system: string;
  prompt: string;
  schema: object;
  run?: Runner;
  timeoutMs?: number;
}): Promise<{ value: unknown; usage: Usage }> {
  const args = [
    "-p",
    "--model", opts.model,
    "--effort", opts.effort,
    "--output-format", "json",
    "--json-schema", JSON.stringify(opts.schema),
    "--tools", "",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--system-prompt", opts.system,
  ];
  const out = await (opts.run ?? runCommand)(opts.command, args, opts.prompt, { timeoutMs: opts.timeoutMs ?? TIMEOUT_MS, env: childEnv(process.env) });
  let envelope: Envelope;
  try {
    envelope = JSON.parse(out.stdout) as Envelope;
  } catch {
    const text = `${out.stderr}\n${out.stdout}`;
    throw fatalFrom(text) ?? new Error(`Claude Code exited with ${out.code}: ${text.trim().slice(0, 300) || "no output"}`);
  }
  const usage: Usage = {
    inputTokens: envelope.usage?.input_tokens ?? 0,
    outputTokens: envelope.usage?.output_tokens ?? 0,
    cacheReadTokens: envelope.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: envelope.usage?.cache_creation_input_tokens ?? 0,
  };
  if (envelope.is_error || out.code !== 0) {
    const text = `${String(envelope.result ?? "")} ${out.stderr}`;
    throw fatalFrom(text) ?? new Error(`Claude Code reported an error: ${text.trim().slice(0, 200) || envelope.subtype || "unknown"}`);
  }
  let value: unknown = envelope.structured_output;
  if (value === undefined && typeof envelope.result === "string") {
    try {
      value = JSON.parse(envelope.result);
    } catch {
      value = null;
    }
  }
  return { value, usage };
}

/** Turns Claude Code's own error text into a reason that stops the run, when it will not get better by itself. */
function fatalFrom(text: string): FatalRaterError | null {
  if (/not logged in|please run \/login|invalid api key|authenticat|oauth/i.test(text)) {
    return new FatalRaterError('Claude Code is not signed in. Run "claude" in a terminal once and sign in with your Claude account, then try again.');
  }
  if (/usage limit|limit reached|rate limit|quota|overloaded/i.test(text)) {
    return new FatalRaterError(`Your Claude plan's usage limit is reached for now: ${text.trim().slice(0, 200)}`);
  }
  return null;
}

export class ClaudeCodeRater implements Rater {
  readonly model: string;
  readonly billed = false;
  private readonly command: string;
  private readonly effort: "low" | "medium" | "high";
  private readonly run: Runner;

  constructor(opts: { model: string; effort: "low" | "medium" | "high"; command?: string; run?: Runner }) {
    this.model = opts.model;
    this.effort = opts.effort;
    this.command = opts.command ?? "claude";
    this.run = opts.run ?? runCommand;
  }

  args(profile: Profile): string[] {
    const system = `${INSTRUCTIONS}\n\nThe candidate's profile:\n${JSON.stringify(profileForModel(profile), null, 2)}`;
    return [
      "-p",
      "--model", this.model,
      "--effort", this.effort,
      "--output-format", "json",
      "--json-schema", JSON.stringify(ratingJsonSchema()),
      "--tools", "",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--system-prompt", system,
    ];
  }

  async rate(job: Job, profile: Profile): Promise<RaterResult> {
    const out = await this.run(this.command, this.args(profile), `Rate this posting.\n\n${postingText(job)}`, {
      timeoutMs: TIMEOUT_MS,
      env: childEnv(process.env),
    });

    let envelope: Envelope;
    try {
      envelope = JSON.parse(out.stdout) as Envelope;
    } catch {
      const text = `${out.stderr}\n${out.stdout}`;
      throw fatalFrom(text) ?? new Error(`Claude Code exited with ${out.code}: ${text.trim().slice(0, 300) || "no output"}`);
    }
    const usage: Usage = {
      inputTokens: envelope.usage?.input_tokens ?? 0,
      outputTokens: envelope.usage?.output_tokens ?? 0,
      cacheReadTokens: envelope.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: envelope.usage?.cache_creation_input_tokens ?? 0,
    };
    if (envelope.is_error || out.code !== 0) {
      const text = `${String(envelope.result ?? "")} ${out.stderr}`;
      const fatal = fatalFrom(text);
      if (fatal) throw fatal;
      return { ok: false, reason: `Claude Code reported an error: ${text.trim().slice(0, 200) || envelope.subtype || "unknown"}`, usage, costUsd: 0 };
    }
    // --json-schema puts the answer in structured_output; fall back to the text result.
    const rating = checkRating(envelope.structured_output ?? envelope.result);
    if (!rating) return { ok: false, reason: "the answer could not be read", usage, costUsd: 0 };
    return { ok: true, rating, usage, costUsd: 0, model: this.model };
  }
}
