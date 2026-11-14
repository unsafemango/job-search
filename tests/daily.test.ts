import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSession, type Session } from "../src/apply/browser.js";
import type { FormField } from "../src/apply/form.js";
import { Store } from "../src/db.js";
import { blobId, parseRhythm, pickTopUp, planDaily, rhythmJob, runDaily } from "../src/daily.js";
import { applyUrlFor, type Job } from "../src/jobs/job.js";
import { parseProfile } from "../src/profile/schema.js";

const NOW = new Date("2026-11-10T12:00:00Z");
const dir = mkdtempSync(path.join(tmpdir(), "daily-test-"));
const filesDir = path.join(dir, "files");
mkdirSync(filesDir);
const resumeOnDisk = path.join(dir, "base.pdf");
writeFileSync(resumeOnDisk, "%PDF-1.4\n%%EOF\n");

const profile = parseProfile({
  name: "Test Person",
  target: { titles: ["engineer"], levels: ["mid", "senior"] },
  locations: { include: [{ match: "Toronto" }], remote: true },
  contact: { firstName: "Test", lastName: "Person", email: "test@example.com", phone: "+1 416 555 0100", city: "Toronto", region: "Ontario", country: "Canada" },
  resumePath: resumeOnDisk,
  answers: { authorizedCountries: ["Canada"], needsSponsorship: { Canada: false } },
  apply: { submitGapSeconds: 0, maxPerDay: 10 },
});

const item = (id: string, apply: string, over: Record<string, unknown> = {}) => ({
  id,
  company: "Acme",
  role: "Senior Full Stack Engineer",
  apply,
  location: "Remote, Canada",
  pay: "",
  resumePdf: `/_blob/res${id.replace(/\W/g, "")}`,
  coverPdf: `/_blob/cov${id.replace(/\W/g, "")}`,
  resumePdfName: `Test_Person_Acme_${id}_Resume.pdf`,
  coverPdfName: `Test_Person_Acme_${id}_Cover_Letter.pdf`,
  ...over,
});
const GH = (n: number) => `https://job-boards.greenhouse.io/acme/jobs/${1000 + n}`;

describe("reading the day's jobs", () => {
  it("reads a saved Weekly Rhythm day and leaves out items that are not usable", () => {
    const doc = parseRhythm(JSON.stringify({ date: "2026-11-10", items: [item("1110-01", GH(1)), { id: "x", company: "No link" }, item("1110-02", "http://insecure.example/job")] }));
    expect(doc.date).toBe("2026-11-10");
    expect(doc.items.map((i) => i.id)).toEqual(["1110-01"]);
    expect(parseRhythm(JSON.stringify({ data: { date: "d", items: [item("a", GH(2))] } })).items).toHaveLength(1);
    expect(parseRhythm("{}").items).toEqual([]);
  });

  it("finds the asset id and the apply form", () => {
    expect(blobId("/_blob/abc123")).toBe("abc123");
    expect(blobId("https://evil.example/x")).toBeNull();
    expect(blobId("/_blob/../../etc/passwd")).toBeNull();
    expect(applyUrlFor("https://www.okta.com/company/careers/opportunity/8186804?gh_jid=8186804", "Okta")).toBe("https://job-boards.greenhouse.io/embed/job_app?for=okta&token=8186804");
    expect(applyUrlFor("https://www.okta.com/careers", "Okta")).toBeNull();
    expect(applyUrlFor("https://builtintoronto.com/job/x/1", "Affirm")).toBeNull();
  });

  it("gives a job the same id every day it is seen, and reads its level", () => {
    const a = rhythmJob(parseRhythm(JSON.stringify({ date: "d", items: [item("1110-01", GH(1))] })).items[0]!, "2026-11-10");
    expect(a.id).toBe(rhythmJob({ ...item("1110-01", GH(1)) } as never, "2026-11-10").id);
    expect(a.id).not.toBe(rhythmJob({ ...item("1110-01", GH(1)) } as never, "2026-11-11").id);
    expect(a).toMatchObject({ source: "rhythm", level: "senior", remote: true, applyUrl: expect.stringContaining("job_app") });
  });
});

describe("planning the day", () => {
  it("sorts fillable from unfillable, and never plans what is already done", () => {
    const store = new Store(":memory:");
    const doc = parseRhythm(
      JSON.stringify({
        date: "2026-11-10",
        items: [
          item("1110-01", GH(1)),
          item("1110-02", "https://acme.wd5.myworkdayjobs.com/Careers/job/x"),
          item("1110-03", GH(3)),
          item("1110-04", GH(4)),
          item("1110-05", "https://jobs.lever.co/acme/abc-123"),
        ],
      }),
    );
    // 1110-04 was ticked in the page; 1110-05's form was already sent from your own boards (same form, other id).
    store.upsert({ id: "ownboard1", source: "lever", company: "Acme", title: "Senior Full Stack Engineer", url: "https://jobs.lever.co/acme/abc-123", applyUrl: "https://jobs.lever.co/acme/abc-123/apply", locations: [], remote: false, postedAt: null, description: "" }, { level: "senior", score: 90, reasons: [], filteredReason: null }, NOW);
    store.setStatus("ownboard1", "applied", "", NOW);
    const plan = planDaily(store, doc, ["1110-04"], NOW);
    expect(plan.fillable.map((e) => e.item.id)).toEqual(["1110-01", "1110-03"]);
    expect(plan.skipped.map((s) => [s.item.id, s.reason])).toEqual([
      ["1110-02", expect.stringContaining("myworkdayjobs.com is not a board")],
      ["1110-04", expect.stringContaining("ticked as applied")],
      ["1110-05", "already applied to"],
    ]);
    store.close();
  });

  it("tops up from your own boards: best first, never a form already in the day's list or tried", () => {
    const store = new Store(":memory:");
    const own = (id: string, score: number, url: string | null): Job => ({ id, source: "greenhouse", company: `Co ${id}`, title: `Engineer ${id}`, url: `https://x/${id}`, applyUrl: url, locations: ["Toronto"], remote: false, postedAt: null, description: "" });
    const rated = (score: number) => ({ level: "mid", score, reasons: [], filteredReason: null });
    store.upsert(own("same", 99, GH(1)), rated(99), NOW);
    store.upsert(own("best", 95, GH(2)), rated(95), NOW);
    store.upsert(own("okay", 80, GH(3)), rated(80), NOW);
    store.upsert(own("noform", 97, null), rated(97), NOW);
    store.upsert(own("tried", 96, GH(5)), rated(96), NOW);
    store.addApplication({ jobId: "tried", mode: "dry", state: "left_for_you", detail: "", fields: [] }, NOW);
    store.upsert(own("short", 50, GH(6)), rated(50), NOW);
    store.setStatus("short", "shortlisted", "", NOW);
    const inList = [store.get("same")!];
    expect(pickTopUp(store, 3, inList).map((j) => j.id)).toEqual(["short", "best", "okay"]);
    expect(pickTopUp(store, 0, inList)).toEqual([]);
    store.close();
  });
});

describe("one posting, many ids", () => {
  const same = (id: string, at: Date, over: Partial<Job> = {}): Job => ({ id, source: "greenhouse", company: "Acme", title: "Senior Java Developer", url: `https://x/${id}`, applyUrl: GH(1), locations: ["Toronto"], remote: false, postedAt: null, description: "", ...over });
  const rated = { level: "senior", score: 80, reasons: [] as string[], filteredReason: null };
  const day = (n: number) => new Date(Date.UTC(2026, 10, n));

  it("deals with one id per form: the one already tried first, else the earliest seen", () => {
    const store = new Store(":memory:");
    store.upsert(same("first001", day(1)), rated, day(1));
    store.upsert(same("second01", day(2)), rated, day(2));
    store.upsert(same("third001", day(3)), rated, day(3));
    store.upsert(same("otherform", day(1), { applyUrl: GH(2) }), rated, day(1));
    expect(store.duplicateOfEarlier("first001")).toBeNull();
    expect(store.duplicateOfEarlier("second01")).toBe("first001");
    expect(store.duplicateOfEarlier("third001")).toBe("first001");
    expect(store.duplicateOfEarlier("otherform")).toBeNull();
    // A copy that was already tried comes first, so work already done is not lost.
    store.addApplication({ jobId: "third001", mode: "submit", state: "left_for_you", detail: "", fields: [] }, day(4));
    expect(store.duplicateOfEarlier("third001")).toBeNull();
    expect(store.duplicateOfEarlier("first001")).toBe("third001");
    // Tried on all three: still only one is dealt with.
    store.addApplication({ jobId: "first001", mode: "submit", state: "left_for_you", detail: "", fields: [] }, day(5));
    store.addApplication({ jobId: "second01", mode: "submit", state: "left_for_you", detail: "", fields: [] }, day(5));
    expect([store.duplicateOfEarlier("first001"), store.duplicateOfEarlier("second01"), store.duplicateOfEarlier("third001")].filter((x) => x === null)).toHaveLength(1);
    store.close();
  });

  it("does not plan a copy, nor a job already left for you, unless asked to retry", () => {
    const store = new Store(":memory:");
    const doc = parseRhythm(JSON.stringify({ date: "2026-11-10", items: [item("1110-01", GH(21)), item("1110-02", GH(21)), item("1110-03", GH(23))] }));
    const first = planDaily(store, doc, [], day(10));
    // Two items are the same form: only one is planned.
    expect(first.fillable.map((e) => e.item.id)).toEqual(["1110-01", "1110-03"]);
    expect(first.skipped.map((s) => [s.item.id, s.reason])).toEqual([["1110-02", expect.stringContaining("the same form")]]);

    store.addApplication({ jobId: first.fillable[0]!.job.id, mode: "submit", state: "left_for_you", detail: "needs an answer", fields: [] }, day(10));
    const next = planDaily(store, doc, [], day(11));
    expect(next.fillable.map((e) => e.item.id)).toEqual(["1110-03"]);
    expect(next.skipped.find((s) => s.item.id === "1110-01")?.reason).toContain("left for you");
    // After you have fixed what was missing: --retry tries it again.
    expect(planDaily(store, doc, [], day(11), true).fillable.map((e) => e.item.id)).toEqual(["1110-01", "1110-03"]);
    store.close();
  });
});

/** A form shaped like Greenhouse's, with a cover letter box, served for the board's address. */
const FORM = `<!doctype html><html><body>
<form id="app" onsubmit="event.preventDefault(); document.body.innerHTML = '<h1>Thank you for applying!</h1>';">
  <label for="first_name">First Name*</label><input id="first_name" required>
  <label for="email">Email*</label><input id="email" type="email" required>
  <div><label for="resume">Resume/CV*</label><input id="resume" type="file"></div>
  <div><label for="cover_letter">Cover Letter</label><input id="cover_letter" type="file"></div>
  <button type="submit">Submit application</button>
</form></body></html>`;

describe("the daily run, on a local copy of the form", () => {
  let session: Session;
  beforeAll(async () => {
    session = await openSession(path.join(dir, "browser"), { headless: true });
    await session.context.route("https://job-boards.greenhouse.io/**", (route) => route.fulfill({ contentType: "text/html", body: FORM }));
  }, 60_000);
  afterAll(async () => session?.close());

  const map = async (_j: unknown, fields: FormField[], _p: unknown, _m: unknown, cover?: { id: string; values: string[] }) => ({
    fields: fields.map((f) => ({
      field: f,
      values: cover && f.id === cover.id ? cover.values : /first name/i.test(f.label) ? ["Test"] : f.kind === "email" ? ["test@example.com"] : /resume/i.test(f.label) ? ["resume"] : [],
    })),
    problems: [] as string[],
    verdict: "ready" as const,
    reason: "",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });

  it("applies with the day's own resume and cover letter under their own names, then deletes them", async () => {
    const store = new Store(":memory:");
    const doc = parseRhythm(JSON.stringify({ date: "2026-11-10", items: [item("1110-01", GH(1)), item("1110-02", "https://acme.wd5.myworkdayjobs.com/Careers/job/x")] }));
    for (const i of doc.items) for (const url of [i.resumePdf, i.coverPdf]) writeFileSync(path.join(filesDir, `${blobId(url)}.pdf`), "%PDF-1.4\n%%EOF\n");

    const dry = await runDaily(store, profile, { doc, appliedIds: [], filesDir, count: 10, submit: false, headless: true, topUp: false, session: async () => session, map, now: NOW });
    expect(dry.results.map((r) => [r.itemId, r.state])).toEqual([["1110-01", "ready"]]);
    expect(existsSync(path.join(filesDir, `${blobId(doc.items[0]!.resumePdf)}.pdf`))).toBe(true);
    const fields = (store.applications(undefined, 1)[0]!.fields as { label: string; shows: string }[]);
    expect(fields.find((f) => f.label === "Resume/CV")?.shows).toBe("Test_Person_Acme_1110-01_Resume.pdf");
    expect(fields.find((f) => f.label === "Cover Letter")?.shows).toBe("Test_Person_Acme_1110-01_Cover_Letter.pdf");
    // The job the app cannot fill is on your Needs you list, with its link.
    const blocked = store.applications().find((a) => a.state === "blocked");
    expect(blocked?.detail).toContain("apply yourself at https://acme.wd5.myworkdayjobs.com");

    const sent = await runDaily(store, profile, { doc, appliedIds: [], filesDir, count: 10, submit: true, headless: true, topUp: false, session: async () => session, map, now: NOW });
    expect(sent.results.map((r) => [r.itemId, r.state])).toEqual([["1110-01", "submitted"]]);
    expect(store.get(sent.results[0]!.jobId)?.status).toBe("applied");
    expect(existsSync(path.join(filesDir, `${blobId(doc.items[0]!.resumePdf)}.pdf`))).toBe(false);
    expect(existsSync(path.join(filesDir, `${blobId(doc.items[0]!.coverPdf)}.pdf`))).toBe(false);

    // Run again: it is done, so nothing is sent twice.
    const again = await runDaily(store, profile, { doc, appliedIds: [], filesDir, count: 10, submit: true, headless: true, topUp: false, session: async () => session, map, now: NOW });
    expect(again.results).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toContain("already applied to");
    store.close();
  }, 120_000);

  it("fills the rest from your own boards, and looks for new jobs only when it needs to", async () => {
    const store = new Store(":memory:");
    store.upsert({ id: "own00001", source: "greenhouse", company: "Beta", title: "Backend Engineer", url: "https://x", applyUrl: GH(7), locations: ["Toronto"], remote: false, postedAt: null, description: "" }, { level: "mid", score: 90, reasons: [], filteredReason: null }, NOW);
    let refreshed = 0;
    const base = { appliedIds: [], filesDir, count: 1, submit: true, headless: true, topUp: true, session: async () => session, map, now: NOW, refresh: async () => void refreshed++ };
    const full = parseRhythm(JSON.stringify({ date: "2026-11-10", items: [item("1110-09", GH(9))] }));
    for (const i of full.items) for (const url of [i.resumePdf, i.coverPdf]) writeFileSync(path.join(filesDir, `${blobId(url)}.pdf`), "%PDF-1.4\n%%EOF\n");
    // The day's list already fills the count, so nothing is added and no search is made.
    const first = await runDaily(store, profile, { ...base, doc: full });
    expect(first.results.map((r) => r.itemId)).toEqual(["1110-09"]);
    expect(refreshed).toBe(0);
    // No day's list: the best job from your own boards is used, with your own resume.
    const second = await runDaily(store, profile, { ...base, doc: null });
    expect(refreshed).toBe(1);
    expect(second.results.map((r) => [r.itemId, r.jobId, r.state])).toEqual([[null, "own00001", "submitted"]]);
    store.close();
  }, 120_000);
});
