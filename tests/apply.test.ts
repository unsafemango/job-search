import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bestSuggestion, fillForm, openForm, openSession, sameValue, submitForm, type Session } from "../src/apply/browser.js";
import { checkPlan, countryFor, matchOption, type Plan } from "../src/apply/map.js";
import type { FormField } from "../src/apply/form.js";
import { applyJobs, pickJobs } from "../src/apply/run.js";
import { Store } from "../src/db.js";
import { ingest } from "../src/discover.js";
import { applyUrlFor, type Job } from "../src/jobs/job.js";
import { parseProfile } from "../src/profile/schema.js";

const NOW = new Date("2026-11-09T12:00:00Z");
const dir = mkdtempSync(path.join(tmpdir(), "apply-test-"));
const resume = path.join(dir, "Test_Resume.pdf");
writeFileSync(resume, "%PDF-1.4\n%%EOF\n");

const profile = parseProfile({
  name: "Test Person",
  target: { titles: ["software engineer"], levels: ["mid", "senior"] },
  locations: { include: [{ match: "Toronto" }], remote: true },
  contact: { firstName: "Test", lastName: "Person", email: "test@example.com", phone: "+1 416 555 0100", city: "Toronto", region: "Ontario", country: "Canada" },
  resumePath: resume,
  answers: { authorizedCountries: ["Canada"], needsSponsorship: { Canada: false, "United States": true } },
  apply: { submitGapSeconds: 0 },
});

const job: Job = {
  id: "job00001",
  source: "greenhouse",
  company: "Acme",
  title: "Software Engineer",
  url: "https://example.com/1",
  locations: ["Toronto, ON"],
  remote: false,
  postedAt: "2026-11-08T00:00:00Z",
  description: "TypeScript.",
};

const field = (id: string, label: string, over: Partial<FormField> = {}): FormField => ({
  id,
  kind: "text",
  label,
  context: label,
  required: false,
  options: [],
  value: "",
  hint: "",
  ...over,
});

describe("apply links", () => {
  it("finds the form for Greenhouse, Lever and Ashby postings", () => {
    expect(applyUrlFor("https://job-boards.greenhouse.io/affirm/jobs/8197327003")).toBe("https://job-boards.greenhouse.io/embed/job_app?for=affirm&token=8197327003");
    expect(applyUrlFor("https://boards.greenhouse.io/embed/job_app?for=acme&token=123")).toBe("https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123");
    expect(applyUrlFor("https://jobs.lever.co/acme/abc-123")).toBe("https://jobs.lever.co/acme/abc-123/apply");
    expect(applyUrlFor("https://jobs.ashbyhq.com/acme/abc-123")).toBe("https://jobs.ashbyhq.com/acme/abc-123/application");
    expect(applyUrlFor("https://acme.wd5.myworkdayjobs.com/Careers/job/x")).toBeNull();
    expect(applyUrlFor("not a url")).toBeNull();
  });
});

describe("checkPlan", () => {
  const plan = (answers: Plan["answers"], verdict: Plan["verdict"] = "ready"): Plan => ({ verdict, reason: "", answers });

  it("keeps sponsorship and authorization answers to the profile, per country", () => {
    const fields = [
      field("f0", "Will you require sponsorship to work in Canada?", { kind: "radio", options: ["Yes", "No"], required: true }),
      field("f1", "Will you require sponsorship to work in the United States?", { kind: "radio", options: ["Yes", "No"] }),
      field("f2", "Are you legally authorized to work in Canada?", { kind: "radio", options: ["Yes", "No"] }),
    ];
    const good = checkPlan(plan([{ id: "f0", values: ["No"] }, { id: "f1", values: ["Yes"] }, { id: "f2", values: ["Yes"] }]), fields, job, profile);
    expect(good.problems).toEqual([]);

    const bad = checkPlan(plan([{ id: "f0", values: ["Yes"] }, { id: "f1", values: ["No"] }, { id: "f2", values: ["No"] }]), fields, job, profile);
    expect(bad.problems).toEqual([
      expect.stringContaining("sponsorship in Canada is not needed"),
      expect.stringContaining('"Will you require sponsorship to work in Canada?" is required'),
      expect.stringContaining("sponsorship in United States is needed"),
      expect.stringContaining("authorized to work in Canada"),
    ]);
    expect(bad.fields.every((f) => f.values.length === 0)).toBe(true);
  });

  it("never signs, matches options exactly, and attaches only the resume", () => {
    const fields = [
      field("f0", "Type your full legal name to sign this agreement", { required: true }),
      field("f1", "Pronouns", { kind: "combobox", options: ["He/him", "She/her", "I prefer not to say"] }),
      field("f2", "Gender", { kind: "select", options: ["Male", "Female"] }),
      field("f3", "Resume", { kind: "file", hint: "resume" }),
      field("f4", "Autofill from resume", { kind: "file" }),
      field("f5", "Cover letter", { kind: "file" }),
    ];
    const r = checkPlan(
      plan([
        { id: "f0", values: ["Test Person"] },
        { id: "f1", values: ["i prefer not to say"] },
        { id: "f2", values: ["Robot"] },
        { id: "f3", values: ["resume"] },
        { id: "f4", values: ["resume"] },
        { id: "f5", values: [] },
      ]),
      fields,
      job,
      profile,
    );
    expect(r.fields.map((f) => f.values)).toEqual([[], ["I prefer not to say"], [], ["resume"], [], []]);
    expect(r.problems).toEqual([
      expect.stringContaining("signature"),
      expect.stringContaining("is required and has no answer"),
      expect.stringContaining('"Robot" is not one of its options'),
    ]);
  });

  it("passes on Claude's own doubts", () => {
    const r = checkPlan(plan([], "needs_review"), [], job, profile);
    expect(r.problems).toEqual(["Claude: needs review: "]);
  });

  it("finds the country a question is about, else the job's", () => {
    expect(countryFor("Do you require U.S. sponsorship?", job, profile)).toBe("United States");
    expect(countryFor("Do you require sponsorship?", job, profile)).toBe("Canada");
    expect(countryFor("Do you require sponsorship?", { ...job, locations: ["New York, United States"] }, profile)).toBe("United States");
  });

  it("matches options ignoring case and spacing", () => {
    expect(matchOption(" no ", ["Yes", "No"])).toBe("No");
    expect(matchOption("Maybe", ["Yes", "No"])).toBeNull();
  });
});

describe("reading values back", () => {
  it("picks the place in the right province and country", () => {
    const texts = ["London, ENG, GBR", "London, ON, CAN", "London, KY, USA"];
    expect(bestSuggestion("London, Ontario, Canada", texts)).toBe("London, ON, CAN");
    expect(bestSuggestion("Toronto, Ontario, Canada", ["Toronto, OH, USA", "Toronto, ON, CAN"])).toBe("Toronto, ON, CAN");
    expect(bestSuggestion("Ottawa", ["Toronto, ON, CAN"])).toBeNull();
  });

  it("trusts a partly shown choice only when it is the exact option clicked", () => {
    const country = { field: field("f0", "Country", { kind: "combobox", options: ["Canada +1", "United States +1"] }), values: ["Canada +1"] };
    expect(sameValue(country, "+1", "Canada +1")).toBe(true);
    expect(sameValue(country, "+1", null)).toBe(false);
    expect(sameValue(country, "+1", "United States +1")).toBe(false);
    const phone = { field: field("f1", "Phone", { kind: "tel" }), values: ["+1 416 555 0100"] };
    expect(sameValue(phone, "(416) 555-0100")).toBe(true);
    expect(sameValue(phone, "416 555 0199")).toBe(false);
  });
});

describe("pickJobs", () => {
  it("never picks a job already sent, and prefers shortlisted jobs", () => {
    const store = new Store(":memory:");
    const jobs = [1, 2, 3].map((n) => ({ ...job, id: `job0000${n}`, title: `Software Engineer ${n}`, url: `https://jobs.lever.co/acme/${n}`, applyUrl: `https://jobs.lever.co/acme/${n}/apply` }));
    ingest([...jobs, { ...job, id: "noform01", title: "Software Engineer 4", applyUrl: null }], profile, store, NOW);
    store.setStatus("job00003", "shortlisted", "", NOW);
    expect(pickJobs(store, { count: 2 }).jobs.map((j) => j.id)).toEqual(["job00003", expect.any(String)]);

    store.addApplication({ jobId: "job00001", mode: "submit", state: "unconfirmed", detail: "", fields: [] }, NOW);
    expect(store.wasSent("job00001")).toBe(true);
    const named = pickJobs(store, { ids: ["job00001", "nope"] });
    expect(named.jobs).toEqual([]);
    expect(named.notes).toEqual([expect.stringContaining("already sent"), "nope: no such job"]);
    // Untried jobs with a form only.
    expect(pickJobs(store, { count: 10 }).jobs.map((j) => j.id).sort()).toEqual(["job00002", "job00003"]);
    store.close();
  });
});

/** No tailored documents: the tests never call the real resume writer. */
const noDocs = async () => ({ resume, coverLetter: null, coverText: null });

/** A local form shaped like the boards' own, served from a file: no network, no employer. */
const FORM = `<!doctype html><html><body>
<form id="app" onsubmit="event.preventDefault(); document.body.innerHTML = '<h1>Thank you for applying!</h1>';">
  <label for="first">First Name*</label><input id="first" required>
  <label for="email">Email*</label><input id="email" type="email" required>
  <label for="phone">Phone*</label><input id="phone" type="tel" required>
  <div><label for="resume">Resume/CV*</label><input id="resume" type="file"></div>
  <div><label for="how">How did you hear about us?</label>
    <select id="how"><option>Select...</option><option>LinkedIn</option><option>Company careers page</option></select></div>
  <fieldset><legend>Do you now or in the future require sponsorship to work in Canada?*</legend>
    <label><input type="radio" name="sponsor" value="y" required>Yes</label>
    <label><input type="radio" name="sponsor" value="n">No</label></fieldset>
  <div class="q"><p>Which of these do you identify as?</p>
    <label><input type="checkbox" name="race" value="a">Asian</label>
    <label><input type="checkbox" name="race" value="b">Black or African American</label>
    <label><input type="checkbox" name="race" value="c">Prefer not to say</label></div>
  <label for="why">Why do you want to work here?</label><textarea id="why"></textarea>
  <button type="submit">Submit application</button>
</form></body></html>`;

describe("the browser runner, on a local form", () => {
  let session: Session;
  let url: string;
  beforeAll(async () => {
    const file = path.join(dir, "form.html");
    writeFileSync(file, FORM);
    url = `file://${file}`;
    session = await openSession(path.join(dir, "browser"), { headless: true });
  }, 60_000);
  afterAll(async () => session?.close());

  it("reads the questions, fills them, reads them back and submits", async () => {
    const { page, dump } = await openForm(session, url);
    expect(dump.fields.map((f) => [f.kind, f.label, f.required])).toEqual([
      ["text", "First Name", true],
      ["email", "Email", true],
      ["tel", "Phone", true],
      ["file", "Resume/CV", true],
      ["select", "How did you hear about us?", false],
      ["radio", "Do you now or in the future require sponsorship to work in Canada?", true],
      ["checkboxes", "Which of these do you identify as?", false],
      ["textarea", "Why do you want to work here?", false],
    ]);
    expect(dump.fields[4]!.options).toEqual(["LinkedIn", "Company careers page"]);
    expect(dump.fields[5]!.options).toEqual(["Yes", "No"]);

    const values = [["Test"], ["test@example.com"], ["+1 416 555 0100"], ["resume"], ["Company careers page"], ["No"], ["Black or African American"], []];
    const results = await fillForm(page, dump.fields.map((f, i) => ({ field: f, values: values[i]! })), { resume: { path: resume, name: "Test_Person_Resume.pdf" } });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.shows)).toEqual(["Test", "test@example.com", "+1 416 555 0100", "Test_Person_Resume.pdf", "Company careers page", "No", "Black or African American", ""]);

    expect(await submitForm(page, dump.submit!)).toMatchObject({ state: "submitted" });
    await page.close();
  }, 60_000);

  it("runs the whole loop: dry by default, sends only with submit, never twice", async () => {
    const store = new Store(":memory:");
    ingest([{ ...job, applyUrl: url }], profile, store, NOW);
    const map = async (_j: unknown, fields: FormField[]) => ({
      fields: fields.map((f) => ({ field: f, values: f.required ? (f.kind === "radio" ? ["No"] : f.kind === "email" ? ["test@example.com"] : f.kind === "tel" ? ["+1 416 555 0100"] : ["Test"]) : [] })),
      problems: [],
      verdict: "ready" as const,
      reason: "",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    const opts = { session: async () => session, map, prepare: noDocs, sleep: async () => {} };

    const dry = await applyJobs(store, profile, { ...opts, ids: ["job00001"], submit: false });
    expect(dry.outcomes.map((o) => o.state)).toEqual(["ready"]);
    expect(store.get("job00001")?.status).toBe("new");

    const sent = await applyJobs(store, profile, { ...opts, ids: ["job00001"], submit: true });
    expect(sent.outcomes.map((o) => [o.state, o.detail])).toEqual([["submitted", expect.stringMatching(/thank you for applying/i)]]);
    expect(store.get("job00001")?.status).toBe("applied");

    const again = await applyJobs(store, profile, { ...opts, ids: ["job00001"], submit: true });
    expect(again.outcomes).toEqual([]);
    expect(again.notes).toEqual([expect.stringContaining("already sent")]);
    store.close();
  }, 90_000);

  it("leaves a form for you when a required answer is missing", async () => {
    const store = new Store(":memory:");
    ingest([{ ...job, applyUrl: url }], profile, store, NOW);
    const map = async (_j: unknown, fields: FormField[]) => ({
      fields: fields.map((f) => ({ field: f, values: [] as string[] })),
      problems: ['"Phone" is required and has no answer'],
      verdict: "ready" as const,
      reason: "",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    const r = await applyJobs(store, profile, { ids: ["job00001"], submit: true, session: async () => session, map, prepare: noDocs, sleep: async () => {} });
    expect(r.outcomes.map((o) => o.state)).toEqual(["left_for_you"]);
    expect(store.wasSent("job00001")).toBe(false);
    expect(store.get("job00001")?.status).toBe("new");
    store.close();
  }, 60_000);

  it("writes a cover letter when the form requires one, attaches it under its own name, and leaves the form for you without one", async () => {
    const coverForm = path.join(dir, "cover.html");
    writeFileSync(
      coverForm,
      FORM.replace(
        '<label for="why">',
        '<div><label for="cover_letter">Cover Letter*</label><input id="cover_letter" type="file" required></div><label for="why">',
      ),
    );
    const letter = path.join(dir, "letter-on-disk.pdf");
    writeFileSync(letter, "%PDF-1.4\n%%EOF\n");
    const map = async (_j: unknown, fields: FormField[], _p: unknown, _m: unknown, cover?: { id: string; values: string[] }) => ({
      fields: fields.map((f) => ({
        field: f,
        values: cover && f.id === cover.id ? cover.values : f.required && f.kind !== "file" ? (f.kind === "radio" ? ["No"] : f.kind === "email" ? ["test@example.com"] : f.kind === "tel" ? ["+1 416 555 0100"] : ["Test"]) : f.kind === "file" && /resume/i.test(f.label) ? ["resume"] : [],
      })),
      problems: [] as string[],
      verdict: "ready" as const,
      reason: "",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    const asked: boolean[] = [];

    const store = new Store(":memory:");
    ingest([{ ...job, applyUrl: `file://${coverForm}` }], profile, store, NOW);
    const withLetter = async (_j: unknown, cover: boolean) => (asked.push(cover), { resume, coverLetter: letter, coverText: "Text." });
    const r = await applyJobs(store, profile, { ids: ["job00001"], submit: false, session: async () => session, map, prepare: withLetter, sleep: async () => {} });
    expect(asked).toEqual([true]);
    expect(r.outcomes.map((o) => o.state)).toEqual(["ready"]);
    const coverResult = r.outcomes[0]!.fields.find((f) => f.label === "Cover Letter");
    expect(coverResult).toMatchObject({ ok: true, shows: "Test_Person_Cover_Letter.pdf" });

    const store2 = new Store(":memory:");
    ingest([{ ...job, applyUrl: `file://${coverForm}` }], profile, store2, NOW);
    const r2 = await applyJobs(store2, profile, { ids: ["job00001"], submit: true, session: async () => session, map, prepare: noDocs, sleep: async () => {} });
    expect(r2.outcomes.map((o) => o.state)).toEqual(["left_for_you"]);
    expect(r2.outcomes[0]!.detail).toContain("needs a cover letter");
    expect(store2.wasSent("job00001")).toBe(false);
    store.close();
    store2.close();
  }, 90_000);
});
