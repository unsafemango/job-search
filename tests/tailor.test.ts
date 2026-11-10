import { describe, expect, it } from "vitest";
import { applyPlan, trimOnce, unsupportedClaims } from "../src/resume/tailor.js";
import { ResumeSchema, sourceText } from "../src/resume/schema.js";
import { resumeHtml } from "../src/resume/render.js";

const resume = ResumeSchema.parse({
  name: "Ada Lovelace",
  headline: "Software Engineer",
  summary: "Engineer with 3+ years in TypeScript and React, serving 10,000 users.",
  experience: [
    { title: "Developer", company: "Acme", dates: "2022 – Present", bullets: ["Built a React dashboard for 10,000 users.", "Ran PostgreSQL on AWS.", "Wrote Cypress tests."] },
    { title: "Intern", company: "Beta Labs", dates: "2021", bullets: ["Fixed Node.js bugs.", "Wrote docs."] },
  ],
  projects: [{ name: "Engine (Go)", bullets: ["Kafka ingestion."] }, { name: "Booking", bullets: ["Spring Boot app."] }],
  skills: [{ group: "Languages", items: ["TypeScript", "Go"] }, { group: "Data", items: ["PostgreSQL"] }],
  education: [{ credential: "BSc Computer Science", school: "Example University" }],
});

describe("the truth check", () => {
  const src = sourceText(resume);
  it("passes a summary that only uses the resume's facts", () => {
    expect(unsupportedClaims("Full-stack engineer with 3+ years of TypeScript/React and PostgreSQL on AWS, including a Kafka-based project.", src)).toEqual([]);
    expect(unsupportedClaims(resume.summary, src)).toEqual([]);
  });
  it("refuses numbers, employers and skills the resume does not have", () => {
    expect(unsupportedClaims("Engineer with 8+ years of Rust at Google, serving 10,000 users.", src)).toEqual(["8", "Rust", "Google"]);
    expect(unsupportedClaims("Led GraphQL/React work.", src)).toEqual(["GraphQL/React"]);
  });
  it("does not count a plain word that starts a sentence", () => {
    expect(unsupportedClaims("Experienced engineer. Comfortable with TypeScript.", src)).toEqual([]);
  });
});

describe("applying a plan", () => {
  it("keeps every role, picks and orders bullets, and ignores bad indexes", () => {
    const r = applyPlan(resume, { summary: "New summary.", experience: [{ index: 0, bullets: [2, 0, 9, 0] }], projects: [1], skillGroups: [1, 0] });
    expect(r.summary).toBe("New summary.");
    expect(r.experience.map((e) => e.bullets)).toEqual([["Wrote Cypress tests.", "Built a React dashboard for 10,000 users."], ["Fixed Node.js bugs."]]);
    expect(r.projects.map((p) => p.name)).toEqual(["Booking"]);
    expect(r.skills.map((s) => s.group)).toEqual(["Data", "Languages"]);
    // Bullet text is never changed.
    expect(r.experience.flatMap((e) => e.bullets).every((b) => resume.experience.some((e) => e.bullets.includes(b)))).toBe(true);
  });

  it("trims the least relevant bullet of the longest role, then projects", () => {
    let r: typeof resume | null = resume;
    const steps: number[][] = [];
    while ((r = trimOnce(r!))) steps.push([...r.experience.map((e) => e.bullets.length), r.projects.length]);
    expect(steps).toEqual([[3, 2, 1], [2, 2, 1], [1, 2, 1], [1, 1, 1], [1, 1, 0]]);
  });

  it("escapes text in the HTML", () => {
    const html = resumeHtml({ ...resume, summary: "<script>x</script> & more" });
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt; &amp; more");
    expect(html).not.toContain("<script>x");
  });
});
