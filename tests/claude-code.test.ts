import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Job } from "../src/jobs/job.js";
import { childEnv, ClaudeCodeRater, ratingJsonSchema, runCommand, type Runner } from "../src/model/claude-code.js";
import { FatalRaterError } from "../src/model/rating.js";
import { parseProfile } from "../src/profile/schema.js";

const profile = parseProfile({
  name: "Ada Lovelace",
  target: { titles: ["software engineer"], levels: ["new_grad"] },
  locations: { include: [{ match: "Toronto" }] },
  skills: ["TypeScript"],
  background: "Graduating May 2027.",
});

const job: Job = {
  id: "job00001",
  source: "greenhouse",
  company: "Acme",
  title: "Software Engineer, New Grad",
  url: "https://example.com/1",
  locations: ["Toronto, ON"],
  remote: false,
  postedAt: null,
  description: "TypeScript.",
};

const answer = { fit: 80, level: "new_grad", stack: ["TypeScript"], unmet: [], summary: "Good match." };
const usage = { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** A runner that returns a fixed result, and records what it was asked to run. */
function fakeRun(result: { code?: number; stdout?: unknown; stderr?: string }) {
  const calls: { command: string; args: string[]; stdin: string; env: NodeJS.ProcessEnv }[] = [];
  const run: Runner = async (command, args, stdin, opts) => {
    calls.push({ command, args, stdin, env: opts.env });
    const stdout = typeof result.stdout === "string" ? result.stdout : JSON.stringify(result.stdout ?? "");
    return { code: result.code ?? 0, stdout, stderr: result.stderr ?? "" };
  };
  return { run, calls };
}

const rater = (run: Runner) => new ClaudeCodeRater({ model: "claude-opus-5-5", effort: "low", command: "claude", run });

describe("ClaudeCodeRater", () => {
  it("runs claude -p with no tools, a schema and the profile, and reads the structured answer", async () => {
    const { run, calls } = fakeRun({ stdout: { type: "result", is_error: false, result: "", structured_output: answer, usage } });
    const r = await rater(run).rate(job, profile);
    expect(r).toEqual({ ok: true, rating: answer, model: "claude-opus-5-5", costUsd: 0, usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 } });

    const { command, args, stdin } = calls[0]!;
    expect(command).toBe("claude");
    expect(args.slice(0, 1)).toEqual(["-p"]);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag("--model")).toBe("claude-opus-5-5");
    expect(flag("--effort")).toBe("low");
    expect(flag("--output-format")).toBe("json");
    expect(flag("--tools")).toBe("");
    expect(args).toContain("--no-session-persistence");
    expect(JSON.parse(flag("--json-schema")!)).toEqual(ratingJsonSchema());
    expect(flag("--system-prompt")).toContain("Graduating May 2027.");
    expect(flag("--system-prompt")).not.toContain("Ada Lovelace");
    expect(stdin).toContain("Title: Software Engineer, New Grad");
  });

  it("falls back to a JSON text result, and checks the 0 to 100 range", async () => {
    const text = fakeRun({ stdout: { is_error: false, result: JSON.stringify(answer), usage } });
    expect(await rater(text.run).rate(job, profile)).toMatchObject({ ok: true, rating: answer });
    const bad = fakeRun({ stdout: { is_error: false, structured_output: { ...answer, fit: 150 }, usage } });
    expect(await rater(bad.run).rate(job, profile)).toMatchObject({ ok: false, reason: "the answer could not be read" });
  });

  it("never passes an API key to Claude Code, so it uses your Claude plan", () => {
    const env = childEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_AUTH_TOKEN: "t", HOME: "/home/a" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/a" });
  });

  it("stops the run when not signed in or out of plan usage, and fails just the job otherwise", async () => {
    const signedOut = fakeRun({ code: 1, stdout: { is_error: true, result: "Not logged in · Please run /login", usage } });
    await expect(rater(signedOut.run).rate(job, profile)).rejects.toThrow(FatalRaterError);
    await expect(rater(signedOut.run).rate(job, profile)).rejects.toThrow(/not signed in/);

    const limited = fakeRun({ code: 1, stdout: { is_error: true, result: "Claude AI usage limit reached|1762700000", usage } });
    await expect(rater(limited.run).rate(job, profile)).rejects.toThrow(/usage limit/);

    const notJson = fakeRun({ code: 1, stdout: "", stderr: "Error: Invalid API key" });
    await expect(rater(notJson.run).rate(job, profile)).rejects.toThrow(FatalRaterError);

    const once = fakeRun({ code: 1, stdout: { is_error: true, subtype: "error_during_execution", result: "something odd", usage } });
    expect(await rater(once.run).rate(job, profile)).toMatchObject({ ok: false, reason: expect.stringContaining("something odd") });
  });
});

describe("runCommand", () => {
  it("runs a real command with stdin, and says when Claude Code is not installed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-claude-"));
    const script = path.join(dir, "claude");
    // A stand-in for claude: echoes its first argument and stdin back as JSON.
    writeFileSync(script, `#!/usr/bin/env node\nlet s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify({arg:process.argv[2],stdin:s,key:process.env.ANTHROPIC_API_KEY??null})));\n`);
    chmodSync(script, 0o755);
    const out = await runCommand(script, ["-p"], "hello", { timeoutMs: 10_000, env: childEnv({ ...process.env, ANTHROPIC_API_KEY: "sk-ant-test" }) });
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ arg: "-p", stdin: "hello", key: null });

    await expect(runCommand(path.join(dir, "missing"), [], "", { timeoutMs: 10_000, env: process.env })).rejects.toThrow(/not installed/);
  });
});
