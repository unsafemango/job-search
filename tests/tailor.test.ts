import { describe, expect, it } from "vitest";
import type { Job } from "../src/jobs/job.js";
import { trimOnce } from "../src/resume/documents.js";
import { letterHtml, resumeHtml } from "../src/resume/render.js";
import { ResumeSchema, sourceText } from "../src/resume/schema.js";
import { assembleLetter, assembleResume, notesFor, styleProblems, unsupportedClaims, type ResumeDraft } from "../src/resume/tailor.js";

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
  facts: ["At Acme: use Claude daily to write tests.", "Load-tested the engine at 29k events/sec."],
});
const job: Job = { id: "j1", source: "csv", company: "Shopco", title: "Backend Developer", url: "https://example.com/j1", locations: [], remote: true, postedAt: null, description: "" };

const draft = (over: Partial<ResumeDraft> = {}): ResumeDraft => ({
  headline: "Backend Developer · TypeScript, PostgreSQL",
  summary: "I've built TypeScript apps for 3+ years.",
  skills: [{ group: "Backend", items: ["TypeScript", "PostgreSQL", "Rust"] }],
  experience: [{ role: 0, bullets: ["Built a React dashboard for 10,000 users.", "Ran Kubernetes clusters on GCP."] }],
  projects: [{ project: 0, text: "(Go, Kafka) Engine (Go): ingests events, load-tested at 29k events/sec." }],
  keywords: ["TypeScript"],
  gaps: ["Rust"],
  numbersToAdd: ["How many users?"],
  ...over,
});

describe("the truth check", () => {
  const src = sourceText(resume);
  it("passes text that only uses the resume and facts", () => {
    expect(unsupportedClaims("Full-stack engineer with 3+ years of TypeScript/React and PostgreSQL on AWS, including a Kafka-based project.", src)).toEqual([]);
    expect(unsupportedClaims("I use Claude daily, and load-tested at 29k events/sec.", src)).toEqual([]);
  });
  it("refuses numbers, employers and skills the resume does not have", () => {
    expect(unsupportedClaims("Engineer with 8+ years of Rust at Google, serving 10,000 users.", src)).toEqual(["8", "Rust", "Google"]);
    expect(unsupportedClaims("Led GraphQL/React work.", src)).toEqual(["GraphQL/React"]);
  });
  it("does not count a plain word that starts a sentence", () => {
    expect(unsupportedClaims("Experienced engineer. Comfortable with TypeScript.", src)).toEqual([]);
  });
});

describe("style", () => {
  it("catches em dashes, avoid-list words and placeholders", () => {
    expect(styleProblems("I built it — fast.")).toEqual(["em dashes"]);
    expect(styleProblems("I'm passionate about robust systems.")).toEqual(['"robust"', '"passionate"']);
    expect(styleProblems("I cut load time by [X]%.")).toEqual(["a [X] placeholder"]);
    expect(styleProblems("I built the API and wrote tests.")).toEqual([]);
  });
});

describe("assembling a resume", () => {
  it("keeps what the facts support and drops what they do not", () => {
    const { resume: r, dropped } = assembleResume(resume, draft());
    expect(r.headline).toBe("Backend Developer · TypeScript, PostgreSQL");
    expect(r.experience[0]!.bullets).toEqual(["Built a React dashboard for 10,000 users."]);
    expect(r.skills).toEqual([{ group: "Backend", items: ["TypeScript", "PostgreSQL"] }]);
    // The project's name is shown before its text, so a repeat is dropped.
    expect(r.projects).toEqual([{ name: "Engine", bullets: ["(Go, Kafka) ingests events, load-tested at 29k events/sec."] }]);
    expect(dropped).toEqual([expect.stringContaining("Kubernetes, GCP")]);
  });

  it("falls back to your own summary and headline when the rewrite claims too much, and keeps the current role", () => {
    const { resume: r } = assembleResume(resume, draft({ headline: "Staff Engineer at Google", summary: "I have 10 years of Rust.", experience: [{ role: 1, bullets: ["Fixed Node.js bugs."] }] }));
    expect(r.headline).toBe("Software Engineer");
    expect(r.summary).toBe(resume.summary);
    expect(r.experience.map((e) => e.company)).toEqual(["Acme", "Beta Labs"]);
  });

  it("removes em dashes", () => {
    const { resume: r } = assembleResume(resume, draft({ summary: "I've built TypeScript apps — mostly dashboards." }));
    expect(r.summary).toBe("I've built TypeScript apps, mostly dashboards.");
  });

  it("trims projects, then older roles, then projects entirely, and the current role last", () => {
    let r: typeof resume | null = resume;
    const steps: number[][] = [];
    while ((r = trimOnce(r!))) steps.push([...r.experience.map((e) => e.bullets.length), r.projects.length]);
    expect(steps).toEqual([[3, 2, 1], [3, 1, 1], [3, 1, 0], [2, 1, 0], [1, 1, 0]]);
  });

  it("writes notes with keywords, gaps and what was left out", () => {
    const notes = notesFor(job, assembleResume(resume, draft()), null);
    expect(notes).toContain("## Gaps");
    expect(notes).toContain("- Rust");
    expect(notes).toContain("Left out because your facts don't support them");
  });
});

describe("cover letters", () => {
  const src = `${sourceText(resume)}\nShopco\nBackend Developer`;
  it("keeps supported paragraphs and refuses a letter with too little left", () => {
    const ok = assembleLetter(["I'm applying for the Backend Developer role at Shopco.", "I built a React dashboard for 10,000 users.", "I use Claude daily to write tests.", "I worked on Kubernetes at Google.", "I'd love to talk more about the role."], src);
    expect(ok?.paragraphs).toHaveLength(4);
    expect(ok?.dropped).toEqual([expect.stringContaining("Kubernetes, Google")]);
    expect(assembleLetter(["I'm applying.", "I know Rust and Kotlin."], src)).toBeNull();
    expect(assembleLetter(["One.", "Two.", "I cut costs by [X]%."], src)).toBeNull();
  });

  it("escapes text in the letter and the resume", () => {
    const html = letterHtml(resume, { ...job, company: "<b>Shop</b>" }, ["Fish & <chips>"], new Date("2026-11-10T12:00:00Z"));
    expect(html).toContain("Hi &lt;b&gt;Shop&lt;/b&gt; team,");
    expect(html).toContain("Fish &amp; &lt;chips&gt;");
    expect(resumeHtml({ ...resume, summary: "<script>x</script>" })).not.toContain("<script>x");
  });
});
