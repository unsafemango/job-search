import { describe, expect, it } from "vitest";
import type { FormField } from "../src/apply/form.js";
import { promptFor } from "../src/apply/map.js";
import { isQuestion } from "../src/apply/run.js";
import { questionKey, similarity, Store } from "../src/db.js";
import type { Job } from "../src/jobs/job.js";
import { parseProfile } from "../src/profile/schema.js";
import { parseConnections, referralsFor, sameCompany } from "../src/referrals.js";

const field = (label: string, kind: FormField["kind"] = "textarea"): FormField => ({ id: "f0", kind, label, context: label, required: false, options: [], value: "", hint: "" });

describe("answer memory", () => {
  it("treats the same question asked two ways as one", () => {
    expect(questionKey("Why do you want to work at Acme?")).toBe(questionKey("why do you want to WORK at acme"));
    expect(similarity("Why do you want to work here?", "Why do you want to work with us?")).toBeGreaterThanOrEqual(0.5);
    expect(similarity("Why do you want to work here?", "What is your salary expectation?")).toBeLessThan(0.2);
  });

  it("remembers, recalls similar questions, and forgets", () => {
    const store = new Store(":memory:");
    const at = (n: number) => new Date(Date.UTC(2026, 10, n));
    store.remember("Describe a project you are proud of.", "I built a survey platform.", at(1));
    // The same question again: the newest answer wins, the first wording stays.
    store.remember("Describe a project you are proud of", "I built a survey platform for 100,000 users.", at(2));
    store.remember("What is your notice period?", "Two weeks.", at(3));
    expect(store.memory()).toEqual([
      { question: "What is your notice period?", answer: "Two weeks.", uses: 1 },
      { question: "Describe a project you are proud of.", answer: "I built a survey platform for 100,000 users.", uses: 2 },
    ]);
    expect(store.recall(["Please describe a project you're proud of"])).toEqual([
      { question: "Describe a project you are proud of.", answer: "I built a survey platform for 100,000 users." },
    ]);
    expect(store.recall(["What is your favourite colour?"])).toEqual([]);
    expect(store.forget("notice")).toBe(1);
    expect(store.memory()).toHaveLength(1);
    store.close();
  });

  it("only remembers written questions, not contact details", () => {
    expect(isQuestion(field("Tell us about a hard bug you fixed and how you found it"))).toBe(true);
    expect(isQuestion(field("Email"))).toBe(false);
    expect(isQuestion(field("LinkedIn profile URL (optional, but recommended)", "text"))).toBe(false);
    expect(isQuestion(field("Why are you interested in this role?", "select"))).toBe(false);
  });

  it("passes remembered answers to Claude", () => {
    const profile = parseProfile({ name: "A", target: { titles: ["x"], levels: ["mid"] }, locations: {} });
    const job: Job = { id: "j", source: "csv", company: "Acme", title: "Engineer", url: "u", locations: [], remote: false, postedAt: null, description: "" };
    const prompt = promptFor(job, [field("Why us?")], profile, [{ question: "Why us?", answer: "Because." }]);
    expect(prompt).toContain("Answers the candidate gave before");
    expect(prompt).toContain('"answer": "Because."');
    expect(promptFor(job, [field("Why us?")], profile)).not.toContain("Answers the candidate gave before");
  });
});

describe("referrals", () => {
  const csv = [
    "Notes:",
    '"When exporting your connection data, you may notice that some of the email addresses are missing."',
    "",
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
    "Sam,Lee,https://www.linkedin.com/in/samlee,,Royal Bank of Canada,Software Engineer,01 Jan 2025",
    "Kim,Ng,https://www.linkedin.com/in/kimng,,Shopify,Staff Engineer,02 Feb 2025",
    "Pat,Ray,https://www.linkedin.com/in/patray,,Shopping Co,Designer,03 Mar 2025",
    ",,,,,,",
  ].join("\n");

  it("reads the LinkedIn export past its notes", () => {
    const people = parseConnections(csv);
    expect(people.map((p) => [p.name, p.company])).toEqual([
      ["Sam Lee", "Royal Bank of Canada"],
      ["Kim Ng", "Shopify"],
      ["Pat Ray", "Shopping Co"],
    ]);
  });

  it("matches a company by name, by part of its name, or by acronym", () => {
    expect(sameCompany("RBC", "Royal Bank of Canada")).toBe(true);
    expect(sameCompany("Shopify", "Shopify Inc.")).toBe(true);
    expect(sameCompany("Shopify", "Shopify Canada")).toBe(true);
    expect(sameCompany("Shopify", "Shopping Co")).toBe(false);
    expect(sameCompany("TD", "Royal Bank of Canada")).toBe(false);
    expect(referralsFor("RBC", parseConnections(csv)).map((p) => p.name)).toEqual(["Sam Lee"]);
  });
});
