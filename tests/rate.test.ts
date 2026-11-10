import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { Store } from "../src/db.js";
import { ingest } from "../src/discover.js";
import type { Job } from "../src/jobs/job.js";
import { ClaudeRater, isFatal } from "../src/model/claude.js";
import { costUsd } from "../src/model/pricing.js";
import { FatalRaterError, ratingKey, type Rater, type RaterResult, type Rating } from "../src/model/rating.js";
import { parseProfile, type Profile } from "../src/profile/schema.js";
import { rateJobs } from "../src/rate.js";

const NOW = new Date("2026-11-09T12:00:00Z");

const profile = parseProfile({
  name: "Ada Lovelace",
  target: { titles: ["software engineer"], levels: ["new_grad"] },
  locations: { include: [{ match: "Toronto" }], remote: true },
  skills: ["TypeScript", "Python"],
  background: "BSc Computer Science, graduating May 2027. Canadian citizen.",
  rating: { model: "claude-opus-5-5", maxJobsPerRun: 10, maxSpendPerRunUsd: 0.05 },
});

function job(n: number, over: Partial<Job> = {}): Job {
  return {
    id: `job${String(n).padStart(5, "0")}`,
    source: "greenhouse",
    company: `Company ${n}`,
    title: "Software Engineer, New Grad",
    url: `https://example.com/${n}`,
    locations: ["Toronto, ON"],
    remote: false,
    postedAt: "2026-11-08T00:00:00Z",
    description: `Posting ${n}. TypeScript.`,
    ...over,
  };
}

const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A rater that answers from a function, and counts calls. */
function fakeRater(answer: (job: Job) => RaterResult | Error, model = "claude-opus-5-5", billed = true): Rater & { calls: string[] } {
  const calls: string[] = [];
  return {
    model,
    billed,
    calls,
    async rate(j) {
      calls.push(j.id);
      const a = answer(j);
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

const rating = (fit: number, over: Partial<Rating> = {}): Rating => ({
  fit,
  level: "new_grad",
  stack: ["TypeScript"],
  unmet: [],
  summary: "A good match.",
  ...over,
});
const ok = (fit: number, cost = 0.01, over: Partial<Rating> = {}): RaterResult => ({ ok: true, rating: rating(fit, over), usage, costUsd: cost, model: "claude-opus-5-5" });

function seeded(n: number, p: Profile = profile): Store {
  const store = new Store(":memory:");
  ingest(Array.from({ length: n }, (_, i) => job(i + 1)), p, store, NOW);
  return store;
}

describe("profile", () => {
  it("fills in rating defaults", () => {
    const p = parseProfile({ name: "A", target: { titles: ["x"], levels: ["mid"] }, locations: {} });
    expect(p.rating).toEqual({ provider: "claude-code", command: "claude", model: "claude-haiku-5-5", effort: "low", maxJobsPerRun: 25, maxSpendPerRunUsd: 1 });
    expect(p.background).toBe("");
  });
});

describe("rating key", () => {
  it("changes with the posting, the profile and the model, and not with your name or the status", () => {
    const base = ratingKey(job(1), profile, "claude-opus-5-5");
    expect(ratingKey(job(1), { ...profile, name: "Someone Else" }, "claude-opus-5-5")).toBe(base);
    expect(ratingKey(job(1, { description: "Changed." }), profile, "claude-opus-5-5")).not.toBe(base);
    expect(ratingKey(job(1), { ...profile, skills: ["Go"] }, "claude-opus-5-5")).not.toBe(base);
    expect(ratingKey(job(1), profile, "claude-haiku-5-5")).not.toBe(base);
  });
});

describe("pricing", () => {
  it("estimates cost from tokens", () => {
    expect(costUsd(usage, "claude-opus-5-5")).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6, 10);
    expect(costUsd({ ...usage, cacheReadTokens: 1000, cacheWriteTokens: 1000 }, "claude-haiku-5-5")).toBeCloseTo(
      (1000 * 0.1 + 500 * 0.5 + 1000 * 0.01 + 1000 * 0.125) / 1e6,
      10,
    );
    // An unknown model is priced high, so the spend cap errs on the safe side.
    expect(costUsd(usage, "some-new-model")).toBeGreaterThan(costUsd(usage, "claude-fable-5-1") - 1e-12);
  });
});

describe("rateJobs", () => {
  it("rates the best jobs first, rescoring them, and never rates an unchanged posting twice", async () => {
    const store = seeded(3);
    const rater = fakeRater((j) => ok(j.id === "job00002" ? 95 : 20));
    const first = await rateJobs(store, profile, rater, { now: NOW });
    expect(first).toMatchObject({ rated: 3, failed: [], remaining: 0, stopped: null });
    expect(first.costUsd).toBeCloseTo(0.03);

    const listed = store.list("new");
    expect(listed[0]?.id).toBe("job00002");
    expect(listed[0]?.reasons).toContain("model fit 95/100: A good match.");
    expect(store.events("job00002").map((e) => e.kind)).toEqual(["seen", "rated"]);
    expect(store.ratingTotals()).toEqual({ n: 3, costUsd: expect.closeTo(0.03) });

    // Nothing left to rate, and discover keeps the model's score.
    expect((await rateJobs(store, profile, rater, { now: NOW })).rated).toBe(0);
    expect(rater.calls).toHaveLength(3);
    ingest([job(2)], profile, store, NOW);
    expect(store.get("job00002")?.reasons).toContain("model fit 95/100: A good match.");

    // A changed posting is rated again.
    ingest([job(2, { description: "Now needs 5+ years of Rust." })], profile, store, NOW);
    expect(store.get("job00002")?.reasons.join(" ")).not.toContain("model fit");
    await rateJobs(store, profile, rater, { now: NOW });
    expect(rater.calls).toHaveLength(4);
    store.close();
  });

  it("explains unmet requirements and a different level", async () => {
    const store = seeded(1);
    await rateJobs(store, profile, fakeRater(() => ok(30, 0.01, { level: "senior", unmet: ["5+ years of experience"] })), { now: NOW });
    expect(store.get("job00001")?.reasons).toEqual(expect.arrayContaining(["you may not meet: 5+ years of experience", "model reads the level as senior"]));
    store.close();
  });

  it("stops at the job limit and at the spend cap", async () => {
    const store = seeded(10);
    expect(await rateJobs(store, profile, fakeRater(() => ok(50)), { limit: 2, now: NOW })).toMatchObject({ rated: 2, remaining: 8, stopped: null });
    // $0.02 a job against a $0.05 cap: the third job takes it over, so the run stops there.
    const capped = await rateJobs(store, profile, fakeRater(() => ok(50, 0.02)), { now: NOW });
    expect(capped).toMatchObject({ rated: 3, remaining: 5, stopped: "reached the spend cap of $0.05" });
    store.close();
  });

  it("has no dollar cap for a provider that is not billed per token, and stops on a fatal rater error", async () => {
    const store = seeded(5);
    const plan = await rateJobs(store, profile, fakeRater(() => ok(50, 0.02), "claude-opus-5-5", false), { now: NOW });
    expect(plan).toMatchObject({ rated: 5, stopped: null });

    const fresh = seeded(3);
    const out = await rateJobs(fresh, profile, fakeRater(() => new FatalRaterError("Not signed in.")), { now: NOW });
    expect(out).toMatchObject({ rated: 0, failed: [], stopped: "Not signed in." });
    store.close();
    fresh.close();
  });

  it("carries on past one failure, stops after three in a row, and stops at once on a fatal error", async () => {
    const store = seeded(6);
    const flaky = fakeRater((j) => (j.id === "job00001" ? { ok: false, reason: "the model declined", usage, costUsd: 0.001 } : ok(60)));
    const r = await rateJobs(store, profile, flaky, { now: NOW });
    expect(r).toMatchObject({ rated: 5, stopped: null, failed: [{ id: "job00001", reason: "the model declined" }] });
    expect(r.remaining).toBe(0);

    const fresh = seeded(6);
    const broken = await rateJobs(fresh, profile, fakeRater(() => new Error("500 from the API")), { now: NOW });
    expect(broken).toMatchObject({ rated: 0, stopped: "3 jobs in a row could not be rated" });
    expect(broken.failed).toHaveLength(3);

    const fatal = await rateJobs(fresh, profile, fakeRater(() => new Error("bad key")), { now: NOW, isFatal: () => "Key is not valid." });
    expect(fatal).toMatchObject({ rated: 0, failed: [], stopped: "Key is not valid." });
    store.close();
    fresh.close();
  });
});

describe("ClaudeRater", () => {
  /** A client whose HTTP layer answers with `body`, and records each request. */
  function client(body: unknown, status = 200) {
    const requests: { headers: Headers; body: any }[] = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    return { requests, client: new Anthropic({ apiKey: "test-key", fetch, maxRetries: 0 }) };
  }

  const message = (text: string, over: Record<string, unknown> = {}) => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...over,
  });

  it("sends the posting and profile with a schema, effort and refusal fallback, and reads the rating", async () => {
    const answer = rating(82, { stack: ["TypeScript", "Python"] });
    const { client: c, requests } = client(message(JSON.stringify(answer)));
    const result = await new ClaudeRater({ model: "claude-opus-5-5", effort: "low", client: c }).rate(job(1), profile);

    expect(result).toEqual({ ok: true, rating: answer, model: "claude-opus-5-5", usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: expect.closeTo((1200 * 4 + 300 * 20) / 1e6) });
    const req = requests[0]!;
    expect(req.body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", output_config: { effort: "low", format: { type: "json_schema" } } });
    expect(req.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(req.body.system).toContain("graduating May 2027");
    expect(req.body.system).not.toContain("Ada Lovelace");
    expect(req.body.messages[0].content).toContain("Company: Company 1");
    expect(req.body).not.toHaveProperty("thinking");
  });

  it("sends no fallback for a model that has none", async () => {
    const { client: c, requests } = client(message(JSON.stringify(rating(50)), { model: "claude-haiku-5-5" }));
    await new ClaudeRater({ model: "claude-haiku-5-5", effort: "low", client: c }).rate(job(1), profile);
    expect(requests[0]!.body).not.toHaveProperty("fallbacks");
  });

  it("reports a refusal and a cut-off answer instead of a rating", async () => {
    const refused = client(message("", { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } }));
    expect(await new ClaudeRater({ model: "claude-opus-5-5", effort: "low", client: refused.client }).rate(job(1), profile)).toMatchObject({
      ok: false,
      reason: "the model declined (cyber)",
    });
    const outOfRange = client(message(JSON.stringify(rating(150))));
    const bad = await new ClaudeRater({ model: "claude-opus-5-5", effort: "low", client: outOfRange.client }).rate(job(1), profile);
    expect(bad).toMatchObject({ ok: false, reason: "the answer could not be read" });
    expect(bad.costUsd).toBeGreaterThan(0); // Paid for, so it counts toward the cap.
    // The SDK moves the 0-100 range out of the schema the API sees; it is checked here instead.
    expect(JSON.stringify(outOfRange.requests[0]!.body.output_config.format.schema)).not.toMatch(/"(minimum|maximum)"/);

    const cut = client(message('{"fit": 4', { stop_reason: "max_tokens" }));
    expect(await new ClaudeRater({ model: "claude-opus-5-5", effort: "low", client: cut.client }).rate(job(1), profile)).toMatchObject({
      ok: false,
      reason: "the answer was cut off",
    });
  });

  it("treats a bad key as fatal and a server error as not", async () => {
    const denied = client({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401);
    const err = await new ClaudeRater({ model: "claude-opus-5-5", effort: "low", client: denied.client }).rate(job(1), profile).catch((e) => e);
    expect(isFatal(err)).toMatch(/API key/);
    const down = client({ type: "error", error: { type: "api_error", message: "oops" } }, 500);
    const err500 = await new ClaudeRater({ model: "claude-opus-5-5", effort: "low", client: down.client }).rate(job(1), profile).catch((e) => e);
    expect(isFatal(err500)).toBeNull();
  });
});
