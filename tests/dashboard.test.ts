import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { act, keyMatches, renderPage, startDashboard } from "../src/dashboard.js";
import { Store } from "../src/db.js";
import { ingest } from "../src/discover.js";
import type { Job } from "../src/jobs/job.js";
import { parseProfile } from "../src/profile/schema.js";

const NOW = new Date();
const profile = parseProfile({ name: "A", target: { titles: ["engineer"], levels: ["mid", "senior"] }, locations: { include: [{ match: "Toronto" }] } });
const job = (n: number, over: Partial<Job> = {}): Job => ({
  id: `job0000${n}`,
  source: "greenhouse",
  company: `Company ${n}`,
  title: "Software Engineer",
  url: `https://example.com/${n}`,
  locations: ["Toronto"],
  remote: false,
  postedAt: NOW.toISOString(),
  description: "",
  ...over,
});

describe("dashboard", () => {
  it("approves, dismisses and tracks jobs", () => {
    const store = new Store(":memory:");
    ingest([job(1), job(2), job(3)], profile, store, NOW);
    expect(act(store, "job00001", "approve")).toContain("approved");
    expect(store.get("job00001")?.status).toBe("shortlisted");
    act(store, "job00002", "dismiss");
    expect(store.get("job00002")?.status).toBe("dismissed");
    act(store, "job00003", "applied");
    act(store, "job00003", "followed_up");
    expect(store.events("job00003").map((e) => e.kind)).toEqual(["seen", "applied", "followed_up"]);
    expect(() => act(store, "nope", "approve")).toThrow(/No job/);
    store.close();
  });

  it("escapes what boards send, and lists what needs you", () => {
    const store = new Store(":memory:");
    ingest([job(1, { company: "<img src=x onerror=alert(1)>", title: "Software Engineer \"x\"" }), job(2)], profile, store, NOW);
    store.addApplication({ jobId: "job00002", mode: "submit", state: "left_for_you", detail: '"Salary" is required <b>', fields: [] });
    const html = renderPage(store, profile, "k");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("left for_you");
    expect(html).toContain("&quot;Salary&quot; is required &lt;b&gt;");
    store.close();
  });

  it("compares keys safely", () => {
    expect(keyMatches("abc", "abc")).toBe(true);
    expect(keyMatches("abc", "abd")).toBe(false);
    expect(keyMatches("abc", undefined)).toBe(false);
    expect(keyMatches("abc", "abcd")).toBe(false);
  });

  it("serves only this machine, and only with the key", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "dash-")), "jobs.db");
    const seed = new Store(file);
    ingest([job(1)], profile, seed, NOW);
    seed.close();
    const { server, key } = startDashboard(() => ({ store: new Store(file), profile }), 0);
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, p: string, headers: Record<string, string> = {}, body?: string) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
          let text = "";
          res.on("data", (d) => (text += d)).on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        });
        req.on("error", reject);
        req.end(body);
      });
    try {
      expect((await call("GET", "/")).status).toBe(403);
      const page = await call("GET", `/?key=${key}`);
      expect(page.status).toBe(200);
      expect(page.text).toContain("Company 1: Software Engineer");
      // Another site's name for this machine (DNS rebinding) is refused.
      expect((await call("GET", `/?key=${key}`, { host: "evil.example:80" })).status).toBe(403);

      const action = JSON.stringify({ id: "job00001", action: "approve" });
      expect((await call("POST", "/action", { "content-type": "application/json" }, action)).status).toBe(403);
      const ok = await call("POST", "/action", { "content-type": "application/json", "x-key": key }, action);
      expect(ok.status).toBe(200);
      const check = new Store(file);
      expect(check.get("job00001")?.status).toBe("shortlisted");
      check.close();
      expect((await call("POST", "/action", { "x-key": key }, JSON.stringify({ id: "job00001", action: "delete" }))).status).toBe(400);
    } finally {
      server.close();
    }
  });
});
