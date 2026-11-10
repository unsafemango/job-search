import { describe, expect, it } from "vitest";
import { Store } from "../src/db.js";
import { ingest } from "../src/discover.js";
import { jobLevel } from "../src/jobs/filters.js";
import { parseProfile } from "../src/profile/schema.js";
import type { Company } from "../src/sources/common.js";
import { parseCsv, parseCsvJobs } from "../src/sources/csv.js";
import { fetchGithub, githubUrl, parseGithub } from "../src/sources/github.js";
import { fetchCompany } from "../src/sources/index.js";
import { applyWorkdayDetail, fetchWorkday, parsePostedOn, parseWorkdayItem, workdayBoard } from "../src/sources/workday.js";

const NOW = new Date("2026-11-09T12:00:00Z");

const profile = parseProfile({
  name: "Ada Lovelace",
  target: { titles: ["software engineer"], excludeKeywords: [], levels: ["internship", "new_grad"] },
  locations: { include: [{ match: "Toronto", weight: 1 }], remote: true },
  maxPostingAgeDays: 30,
});

/** A fetch that answers from a table of URL -> JSON, and records what was asked. */
function fakeFetch(routes: (url: string, body: any) => unknown) {
  const calls: { url: string; body: any }[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const answer = routes(url, body);
    if (answer === undefined) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

describe("levels from the source", () => {
  it("uses the source's level only when the title states none", () => {
    expect(jobLevel({ title: "Software Engineer", level: "new_grad" })).toBe("new_grad");
    expect(jobLevel({ title: "Senior Software Engineer", level: "new_grad" })).toBe("senior");
    expect(jobLevel({ title: "Software Engineer Intern", level: "new_grad" })).toBe("internship");
    expect(jobLevel({ title: "Software Engineer" })).toBe("mid");
  });
});

describe("GitHub lists", () => {
  const list: Company = { source: "github", slug: "SimplifyJobs/New-Grad-Positions", name: "Simplify New Grad", level: "new_grad" };
  const listing = [
    { id: "u1", company_name: "Acme", title: "Software Engineer", url: "https://acme/1", locations: ["Toronto, ON", "Remote in Canada"], date_posted: 1794182400, active: true, is_visible: true },
    { id: "u2", company_name: "Acme", title: "Closed role", url: "https://acme/2", locations: [], date_posted: 1794182400, active: false, is_visible: true },
    { id: "u3", company_name: "Acme", title: "Hidden role", url: "https://acme/3", locations: [], date_posted: 1794182400, active: true, is_visible: false },
  ];

  it("keeps open postings and takes the company from each one", () => {
    const jobs = parseGithub(listing, list);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      source: "github",
      company: "Acme",
      locations: ["Toronto, ON", "Remote in Canada"],
      remote: true,
      postedAt: "2026-11-09T00:00:00.000Z",
      description: "",
      level: "new_grad",
    });
    expect(parseGithub({ not: "a list" }, list)).toEqual([]);
  });

  it("tries the next branch when a list is not on dev", async () => {
    const { fn, calls } = fakeFetch((url) => (url === githubUrl(list.slug, "main") ? listing : undefined));
    expect(await fetchGithub(list, { fetchFn: fn })).toHaveLength(1);
    expect(calls.map((c) => c.url)).toEqual([githubUrl(list.slug, "dev"), githubUrl(list.slug, "main")]);
  });

  it("says when a repo has no list", async () => {
    const { fn } = fakeFetch(() => undefined);
    await expect(fetchGithub(list, { fetchFn: fn })).rejects.toThrow(/no listings.json/);
    await expect(fetchGithub({ ...list, slug: "not a repo" }, { fetchFn: fn })).rejects.toThrow(/owner\/repo/);
  });
});

describe("Workday", () => {
  const company: Company = { source: "workday", slug: "https://acme.wd5.myworkdayjobs.com/en-US/Careers", name: "Acme" };
  const board = workdayBoard(company.slug);

  it("reads the board from a careers URL", () => {
    expect(board).toEqual({ host: "acme.wd5.myworkdayjobs.com", tenant: "acme", site: "Careers" });
    expect(workdayBoard("acme.wd1.myworkdayjobs.com/External")).toMatchObject({ tenant: "acme", site: "External" });
    expect(() => workdayBoard("https://example.com/jobs")).toThrow(/not a Workday careers site/);
  });

  it("turns 'Posted N Days Ago' into a date", () => {
    expect(parsePostedOn("Posted Today", NOW)).toBe("2026-11-09T00:00:00.000Z");
    expect(parsePostedOn("Posted Yesterday", NOW)).toBe("2026-11-08T00:00:00.000Z");
    expect(parsePostedOn("Posted 3 Days Ago", NOW)).toBe("2026-11-06T00:00:00.000Z");
    expect(parsePostedOn("Posted 30+ Days Ago", NOW)).toBe("2026-10-10T00:00:00.000Z");
    expect(parsePostedOn("", NOW)).toBeNull();
  });

  it("leaves out '2 Locations' and fills places in from the details", () => {
    const item = parseWorkdayItem({ title: "Software Engineer", externalPath: "/job/x/SE_1", locationsText: "2 Locations", postedOn: "Posted Today" }, board, company, NOW);
    expect(item).toMatchObject({ locations: [], url: "https://acme.wd5.myworkdayjobs.com/Careers/job/x/SE_1", postedAt: "2026-11-09T00:00:00.000Z" });
    const full = applyWorkdayDetail(item, {
      jobPostingInfo: { title: "Software Engineer", location: "Canada, Toronto", additionalLocations: ["US, Remote"], startDate: "2026-11-01", jobDescription: "<p>TypeScript</p>" },
    });
    expect(full).toMatchObject({ locations: ["Canada, Toronto", "US, Remote"], remote: true, postedAt: "2026-11-01T00:00:00.000Z", description: "TypeScript" });
    expect(applyWorkdayDetail(item, {})).toBe(item);
  });

  it("searches for your titles and fetches details only for postings you would keep", async () => {
    const api = "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers";
    const { fn, calls } = fakeFetch((url, body) => {
      if (url === `${api}/jobs`) {
        return {
          total: 2,
          jobPostings: [
            { title: "Software Engineer, New Grad", externalPath: "/job/a/SE_1", locationsText: "Canada, Toronto", postedOn: "Posted Today" },
            { title: "Senior Software Engineer", externalPath: "/job/a/SSE_2", locationsText: "Canada, Toronto", postedOn: "Posted Today" },
          ],
        };
      }
      if (url === `${api}/job/a/SE_1`) return { jobPostingInfo: { location: "Canada, Toronto", jobDescription: "Python" } };
      return undefined;
    });
    const jobs = await fetchWorkday(company, { fetchFn: fn, profile }, NOW);
    expect(jobs.map((j) => [j.title, j.description])).toEqual([
      ["Software Engineer, New Grad", "Python"],
      ["Senior Software Engineer", ""],
    ]);
    expect(calls.filter((c) => c.body).map((c) => c.body.searchText)).toEqual(["software engineer"]);
    expect(calls.map((c) => c.url)).not.toContain(`${api}/job/a/SSE_2`);
  });

  it("goes through fetchCompany", async () => {
    const { fn } = fakeFetch(() => ({ total: 0, jobPostings: [] }));
    expect(await fetchCompany(company, fn, profile)).toEqual([]);
  });
});

describe("CSV import", () => {
  it("reads quoted fields with commas, quotes and line breaks", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n\n')).toEqual([["a", "b"], ["x, y", 'say "hi"\nthere']]);
  });

  it("turns rows into jobs and reports bad lines", () => {
    const csv = [
      "Company,Job Title,Link,Location,Remote,Posted,Level,Description",
      'Acme,Software Engineer,https://acme/1,"Toronto, ON; Remote",,2026-11-01,New Grad,"TypeScript, React"',
      "Acme,,https://acme/2,,,,,",
      "Acme,Software Engineer,https://acme/3,,yes,not a date,,",
      "Acme,Software Engineer,https://acme/4,,,,boss,",
    ].join("\n");
    const { jobs, errors } = parseCsvJobs(csv);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      source: "csv",
      company: "Acme",
      locations: ["Toronto, ON", "Remote"],
      remote: true,
      postedAt: "2026-11-01T00:00:00.000Z",
      level: "new_grad",
      description: "TypeScript, React",
    });
    expect(errors).toEqual([
      { line: 3, error: "no title" },
      { line: 4, error: '"not a date" is not a date' },
      { line: 5, error: expect.stringContaining('level "boss"') },
    ]);
  });

  it("says which required columns are missing", () => {
    expect(parseCsvJobs("company,title\nAcme,Engineer").errors).toEqual([{ line: 1, error: "missing column: url" }]);
    expect(parseCsvJobs("").errors[0]?.error).toBe("the file is empty");
  });

  it("gives the same row the same id, so importing twice adds nothing new", () => {
    const store = new Store(":memory:");
    const csv = "company,title,url,location,level\nAcme,Software Engineer,https://acme/1,Toronto,new_grad";
    expect(ingest(parseCsvJobs(csv).jobs, profile, store, NOW)).toEqual({ kept: 1, newKept: 1, duplicates: 0 });
    expect(ingest(parseCsvJobs(csv).jobs, profile, store, NOW)).toEqual({ kept: 1, newKept: 0, duplicates: 0 });
    expect(store.list("new")[0]?.level).toBe("new_grad");
    store.close();
  });
});
