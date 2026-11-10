import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Store } from "../src/db.js";
import { discover, ingest } from "../src/discover.js";
import { filterJob, levelOf, locationMatch } from "../src/jobs/filters.js";
import { dedupeKey, hasTerm, htmlToText, jobId, type Job } from "../src/jobs/job.js";
import { scoreJob } from "../src/jobs/score.js";
import { parseProfile } from "../src/profile/schema.js";
import { SOURCES, type Company } from "../src/sources/index.js";

const NOW = new Date("2026-11-09T12:00:00Z");

const profile = parseProfile({
  name: "Ada Lovelace",
  target: { titles: ["software engineer", "backend"], excludeKeywords: ["hardware"], levels: ["internship", "new_grad"] },
  locations: {
    include: [{ match: "Toronto", weight: 1 }, { match: "Canada", weight: 0.8 }],
    exclude: ["United States", "US"],
    remote: true,
    remoteWeight: 0.9,
  },
  skills: ["TypeScript", "Python", "C++", "React"],
  excludeCompanies: ["Badco"],
  maxPostingAgeDays: 30,
});

function job(over: Partial<Job> = {}): Job {
  return {
    id: "abc12345",
    source: "greenhouse",
    company: "Acme",
    title: "Software Engineer Intern",
    url: "https://example.com/jobs/1",
    locations: ["Toronto, ON"],
    remote: false,
    postedAt: "2026-11-06T00:00:00Z",
    description: "You will write TypeScript and React. C++ is a plus.",
    ...over,
  };
}

describe("text helpers", () => {
  it("matches whole terms, including ones with symbols", () => {
    expect(hasTerm("We use C++ and Go", "C++")).toBe(true);
    expect(hasTerm("JavaScript developer", "Java")).toBe(false);
    expect(hasTerm("Remote - US", "US")).toBe(true);
    expect(hasTerm("Austin, Texas", "US")).toBe(false);
  });

  it("turns escaped HTML into text", () => {
    expect(htmlToText("&lt;p&gt;Build &amp;amp; ship&lt;/p&gt;&lt;p&gt;Fast&lt;/p&gt;")).toBe("Build & ship\nFast");
  });

  it("gives a posting the same id every time", () => {
    expect(jobId("lever", "acme", "1")).toBe(jobId("lever", "acme", "1"));
    expect(jobId("lever", "acme", "1")).not.toBe(jobId("ashby", "acme", "1"));
  });

  it("gives the same job the same dedupe key across boards", () => {
    const a = { company: "Acme, Inc.", title: "Software Engineer - Intern", locations: ["Toronto, ON", "Montréal"], remote: false };
    const b = { company: "acme", title: "Software Engineer, Intern", locations: ["Montreal", "toronto ON"], remote: false };
    expect(dedupeKey(a)).toBe(dedupeKey(b));
    expect(dedupeKey(a)).not.toBe(dedupeKey({ ...b, title: "Software Engineer II" }));
    expect(dedupeKey(a)).not.toBe(dedupeKey({ ...b, locations: ["Toronto, ON"] }));
    expect(dedupeKey({ ...a, locations: [], remote: true })).not.toBe(dedupeKey({ ...a, locations: [], remote: false }));
    // "C++" and "C#" stay distinct.
    expect(dedupeKey({ ...a, title: "C++ Engineer" })).not.toBe(dedupeKey({ ...a, title: "C# Engineer" }));
  });
});

describe("filters", () => {
  it("reads the level from the title", () => {
    expect(levelOf("Software Engineer Intern")).toBe("internship");
    expect(levelOf("Software Engineer, New Grad")).toBe("new_grad");
    expect(levelOf("Senior Software Engineer")).toBe("senior");
    expect(levelOf("Software Engineer")).toBe("mid");
  });

  it("keeps a job that fits", () => {
    expect(filterJob(job(), profile, NOW)).toBeNull();
  });

  it("drops with a reason", () => {
    expect(filterJob(job({ title: "Product Designer Intern" }), profile, NOW)).toMatch(/target roles/);
    expect(filterJob(job({ title: "Hardware Software Engineer Intern" }), profile, NOW)).toMatch(/hardware/);
    expect(filterJob(job({ title: "Senior Software Engineer" }), profile, NOW)).toBe("level is senior");
    expect(filterJob(job({ postedAt: "2026-09-01T00:00:00Z" }), profile, NOW)).toMatch(/days ago/);
    expect(filterJob(job({ company: "badco" }), profile, NOW)).toMatch(/exclude list/);
    expect(filterJob(job({ locations: ["Berlin, Germany"] }), profile, NOW)).toMatch(/location/);
  });

  it("matches locations from the profile only", () => {
    expect(locationMatch(job(), profile)).toEqual({ weight: 1, label: "Toronto" });
    expect(locationMatch(job({ locations: ["Calgary, Canada"] }), profile)?.label).toBe("Canada");
    expect(locationMatch(job({ locations: ["Remote"], remote: true }), profile)?.label).toBe("remote");
    expect(locationMatch(job({ locations: ["Remote - US"], remote: true }), profile)).toBeNull();
    expect(locationMatch(job({ locations: [] }), profile)?.label).toBe("location not stated");
  });
});

describe("score", () => {
  it("scores a strong match above a weak one and explains itself", () => {
    const strong = scoreJob(job(), profile, NOW);
    const weak = scoreJob(job({ description: "You will write COBOL.", locations: ["Calgary, Canada"], postedAt: "2026-10-15T00:00:00Z" }), profile, NOW);
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.score).toBeLessThanOrEqual(100);
    expect(strong.reasons.join(" ")).toContain("TypeScript, C++, React");
    expect(weak.reasons).toContain("names none of your skills");
  });
});

describe("sources", () => {
  const company = (source: Company["source"]): Company => ({ source, slug: "acme", name: "Acme" });

  it("parses Greenhouse", () => {
    const [j] = SOURCES.greenhouse.parse(
      { jobs: [{ id: 7, title: " Software Engineer ", absolute_url: "https://g/7", location: { name: "Toronto, ON; Remote - Canada" }, first_published: "2026-11-01T00:00:00Z", content: "&lt;p&gt;Hi&lt;/p&gt;" }] },
      company("greenhouse"),
    );
    expect(j).toMatchObject({ title: "Software Engineer", locations: ["Toronto, ON", "Remote - Canada"], remote: true, description: "Hi", company: "Acme" });
  });

  it("parses Lever", () => {
    const [j] = SOURCES.lever.parse(
      [{ id: "x", text: "Backend Engineer", hostedUrl: "https://l/x", categories: { location: "Toronto", allLocations: ["Toronto", "Vancouver"] }, createdAt: Date.UTC(2026, 10, 1), descriptionPlain: "Python", workplaceType: "hybrid" }],
      company("lever"),
    );
    expect(j).toMatchObject({ locations: ["Toronto", "Vancouver"], remote: false, postedAt: "2026-11-01T00:00:00.000Z", description: "Python" });
  });

  it("parses Ashby and skips unlisted postings", () => {
    const jobs = SOURCES.ashby.parse(
      {
        jobs: [
          { id: "a", title: "Software Engineer", jobUrl: "https://a/a", location: "Toronto", secondaryLocations: [{ location: "Montreal" }], isRemote: true, publishedAt: "2026-11-02T00:00:00Z", descriptionPlain: "React" },
          { id: "b", title: "Hidden", jobUrl: "https://a/b", isListed: false },
        ],
      },
      company("ashby"),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ locations: ["Toronto", "Montreal"], remote: true });
  });

  it("survives an unexpected response", () => {
    expect(SOURCES.greenhouse.parse({}, company("greenhouse"))).toEqual([]);
    expect(SOURCES.lever.parse({ error: "no" }, company("lever"))).toEqual([]);
    expect(SOURCES.ashby.parse(null, company("ashby"))).toEqual([]);
  });
});

describe("store and discover", () => {
  it("keeps your status when a job is seen again", () => {
    const store = new Store(":memory:");
    expect(ingest([job()], profile, store, NOW)).toEqual({ kept: 1, newKept: 1, duplicates: 0 });
    store.setStatus("abc12345", "applied", "referred by Sam", NOW);
    expect(ingest([job({ title: "Software Engineer Intern (Summer)" })], profile, store, NOW)).toEqual({ kept: 1, newKept: 0, duplicates: 0 });

    const stored = store.get("abc12345")!;
    expect(stored.status).toBe("applied");
    expect(stored.title).toBe("Software Engineer Intern (Summer)");
    expect(store.events("abc12345").map((e) => e.kind)).toEqual(["seen", "applied"]);
    expect(store.list("new")).toEqual([]);
    expect(store.counts().applied).toBe(1);
    expect(() => store.setStatus("nope", "applied")).toThrow(/No job/);
    store.close();
  });

  it("stores dropped jobs with the reason and keeps them out of lists", () => {
    const store = new Store(":memory:");
    ingest([job({ id: "senior01", title: "Senior Software Engineer" })], profile, store, NOW);
    expect(store.list("new")).toEqual([]);
    expect(store.get("senior01")?.filteredReason).toBe("level is senior");
    expect(store.filteredCounts()).toEqual([{ reason: "level is senior", n: 1 }]);
    store.close();
  });

  it("hides a second posting of the same job and keeps the first", () => {
    const store = new Store(":memory:");
    const first = job({ id: "ghfirst1", source: "greenhouse", url: "https://g/1" });
    const again = job({ id: "lvagain1", source: "lever", company: "Acme Inc", url: "https://l/1", locations: ["toronto, on"] });
    expect(ingest([first], profile, store, NOW)).toEqual({ kept: 1, newKept: 1, duplicates: 0 });
    expect(ingest([again], profile, store, NOW)).toEqual({ kept: 0, newKept: 0, duplicates: 1 });

    expect(store.list("new").map((j) => j.id)).toEqual(["ghfirst1"]);
    expect(store.counts().new).toBe(1);
    expect(store.isHiddenDuplicate("lvagain1")).toBe(true);
    expect(store.isHiddenDuplicate("ghfirst1")).toBe(false);
    expect(store.duplicatesOf("ghfirst1").map((j) => j.id)).toEqual(["lvagain1"]);

    // Seen again on the next run, the same one stays hidden.
    expect(ingest([again, first], profile, store, NOW)).toEqual({ kept: 1, newKept: 0, duplicates: 1 });
    store.close();
  });

  it("never hides a job you have acted on", () => {
    const store = new Store(":memory:");
    ingest([job({ id: "first001" }), job({ id: "second01" })], profile, store, NOW);
    store.setStatus("second01", "applied", "", NOW);
    // The one you applied to wins; the other becomes the hidden copy.
    expect(store.list("applied").map((j) => j.id)).toEqual(["second01"]);
    expect(store.list("new")).toEqual([]);
    expect(store.isHiddenDuplicate("first001")).toBe(true);
    // Acting on both shows both.
    store.setStatus("first001", "shortlisted", "", NOW);
    expect(store.list("shortlisted").map((j) => j.id)).toEqual(["first001"]);
    store.close();
  });

  it("adds dedupe keys to a database made before they existed", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "job-search-")), "jobs.db");
    const store = new Store(file);
    ingest([job({ id: "olddb001" }), job({ id: "olddb002" })], profile, store, NOW);
    store.close();
    const raw = new DatabaseSync(file);
    raw.exec("DROP INDEX jobs_by_dedupe_key; ALTER TABLE jobs DROP COLUMN dedupe_key;");
    raw.close();

    const reopened = new Store(file);
    expect(reopened.list("new").map((j) => j.id)).toEqual(["olddb001"]);
    reopened.close();
  });

  it("lists applications due a follow-up, longest wait first", () => {
    const store = new Store(":memory:");
    const day = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);
    ingest(
      [job({ id: "old00001" }), job({ id: "recent01" }), job({ id: "replied1" }), job({ id: "notyet01" })],
      profile, store, NOW,
    );
    store.setStatus("old00001", "applied", "", NOW);
    store.setStatus("recent01", "applied", "", day(5));
    store.setStatus("replied1", "applied", "", NOW);
    store.setStatus("replied1", "replied", "", day(2));

    const due = store.followUps(7, day(10));
    expect(due.map((f) => [f.job.id, f.days, f.followUps])).toEqual([["old00001", 10, 0]]);
    expect(store.followUps(3, day(10)).map((f) => f.job.id)).toEqual(["old00001", "recent01"]);

    // Following up starts the wait again and is counted.
    store.followedUp("old00001", "emailed the recruiter", day(10));
    expect(store.followUps(7, day(12)).map((f) => f.job.id)).toEqual(["recent01"]);
    expect(store.followUps(7, day(17))).toMatchObject([
      { job: { id: "recent01" }, days: 12, followUps: 0 },
      { job: { id: "old00001" }, days: 7, followUps: 1 },
    ]);
    expect(store.get("old00001")?.status).toBe("applied");
    expect(store.events("old00001").at(-1)).toMatchObject({ kind: "followed_up", note: "emailed the recruiter" });
    expect(() => store.followedUp("nope")).toThrow(/No job/);
    store.close();
  });

  it("keeps an application in follow-ups after a later discover drops the posting", () => {
    const store = new Store(":memory:");
    ingest([job()], profile, store, NOW);
    store.setStatus("abc12345", "applied", "", NOW);
    const later = new Date("2026-12-31T12:00:00Z");
    ingest([job()], profile, store, later);
    expect(store.get("abc12345")?.filteredReason).toMatch(/days ago/);
    expect(store.followUps(7, later).map((f) => f.job.id)).toEqual(["abc12345"]);
    store.close();
  });

  it("defaults followUpAfterDays to 7", () => {
    expect(profile.followUpAfterDays).toBe(7);
  });

  it("reports a board that fails and carries on with the rest", async () => {
    const store = new Store(":memory:");
    const companies: Company[] = [
      { source: "greenhouse", slug: "ok", name: "Ok" },
      { source: "lever", slug: "down", name: "Down" },
    ];
    const result = await discover(companies, profile, store, async (c) => {
      if (c.slug === "down") throw new Error("lever returned 404");
      return [job()];
    }, NOW);
    expect(result).toMatchObject({ fetched: 1, kept: 1, newKept: 1, failures: [{ company: "Down", error: "lever returned 404" }] });
    store.close();
  });
});
