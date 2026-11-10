import { describe, expect, it } from "vitest";
import type { StoredJob } from "../src/db.js";
import { classifyEmail, isProgress, learnWeights, MIN_POSITIVE, MIN_SENT } from "../src/learn.js";
import { WEIGHTS } from "../src/jobs/score.js";

describe("learning weights", () => {
  it("waits for enough outcomes", () => {
    const few = Array.from({ length: 5 }, () => ({ parts: { title: 1, skills: 1, location: 1, recency: 1 }, positive: true }));
    const l = learnWeights(few);
    expect(l.ready).toBe(false);
    expect(l.why).toContain(`at least ${MIN_SENT}`);
  });

  it("shifts weight toward the parts that got replies, within limits, summing to 100", () => {
    // Replies came from jobs with strong skills matches; location made no difference.
    const outcomes = [
      ...Array.from({ length: 10 }, () => ({ parts: { title: 0.8, skills: 0.9, location: 0.5, recency: 0.5 }, positive: true })),
      ...Array.from({ length: 15 }, () => ({ parts: { title: 0.8, skills: 0.3, location: 0.5, recency: 0.5 }, positive: false })),
    ];
    const l = learnWeights(outcomes);
    expect(l.ready).toBe(true);
    expect(l.positive).toBeGreaterThanOrEqual(MIN_POSITIVE);
    expect(l.weights.skills).toBeGreaterThan(WEIGHTS.skills);
    expect(l.weights.title).toBeLessThan(WEIGHTS.title);
    // Capped at 1.5x before normalizing.
    expect(l.weights.skills).toBeLessThanOrEqual(WEIGHTS.skills * 1.5);
    const sum = l.weights.title + l.weights.skills + l.weights.location + l.weights.recency;
    expect(sum).toBeCloseTo(100, 0);
  });
});

const job = (id: string, company: string, title: string, status: StoredJob["status"] = "applied") =>
  ({ id, company, title, status }) as StoredJob;
const tracked = [job("a1", "Royal Bank of Canada", "Senior Full Stack Developer"), job("b1", "Affirm", "Software Engineer II, Backend"), job("b2", "Affirm", "Senior Software Engineer, Backend")];

describe("reading replies", () => {
  it("finds the job by sender name, domain or acronym, and what the email means", () => {
    const r = (from: string, subject: string, snippet = "") => classifyEmail({ from, subject, snippet }, tracked);
    expect(r("RBC Talent <talent@rbc.com>", "Your application", "Unfortunately we will not be moving forward")).toMatchObject({ job: { id: "a1" }, status: "rejected" });
    expect(r("recruiting@affirm.com", "Interview for Senior Software Engineer, Backend", "Please share your availability")).toMatchObject({ job: { id: "b2" }, status: "interview" });
    expect(r("Affirm Careers <no-reply@greenhouse.io>", "Thank you for applying to Affirm")).toMatchObject({ job: { id: "b1" }, status: null });
    expect(r("Affirm <x@affirm.com>", "We are pleased to extend an offer")).toMatchObject({ status: "offer" });
    expect(r("Affirm <x@affirm.com>", "Quick question about your application")).toMatchObject({ status: "replied" });
    expect(r("Newsletter <news@example.com>", "Jobs you may like")).toMatchObject({ job: null, status: null });
  });

  it("reads a rejection that mentions next steps as a rejection", () => {
    expect(classifyEmail({ from: "affirm.com", subject: "Update", snippet: "Unfortunately we decided to move forward with other candidates. Next steps: none." }, tracked).status).toBe("rejected");
  });

  it("never moves news backwards", () => {
    expect(isProgress("applied", "interview")).toBe(true);
    expect(isProgress("interview", "replied")).toBe(false);
    expect(isProgress("interview", "rejected")).toBe(true);
    expect(isProgress("offer", "rejected")).toBe(false);
    expect(isProgress("rejected", "rejected")).toBe(false);
    expect(isProgress("new", "interview")).toBe(false);
  });
});
