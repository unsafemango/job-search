/**
 * A local dashboard: today's best matches to approve or dismiss, forms waiting
 * on you, and the applications you are tracking. It listens on 127.0.0.1 only,
 * and every change needs the key printed when it starts, so no other site or
 * machine can drive it. Approving a job shortlists it: `apply` takes
 * shortlisted jobs first.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import path from "node:path";
import type { Store, StoredJob } from "./db.js";
import { ageDays } from "./jobs/job.js";
import { PATHS } from "./paths.js";
import type { Profile } from "./profile/schema.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const ACTIONS = ["approve", "dismiss", "reset", "applied", "replied", "interview", "offer", "rejected", "followed_up"] as const;
export type Action = (typeof ACTIONS)[number];

/** Applies one action from the page to a job. Pure apart from the store, so it is tested offline. */
export function act(store: Store, id: string, action: Action, note = ""): string {
  const job = store.get(id);
  if (!job) throw new Error(`No job with id ${id}.`);
  switch (action) {
    case "approve":
      store.setStatus(id, "shortlisted", note || "approved in the dashboard");
      return `${job.company}: approved. apply takes it first.`;
    case "dismiss":
      store.setStatus(id, "dismissed", note);
      return `${job.company}: dismissed.`;
    case "reset":
      store.setStatus(id, "new", note);
      return `${job.company}: back to new.`;
    case "followed_up":
      store.followedUp(id, note);
      return `${job.company}: follow-up recorded.`;
    default:
      store.setStatus(id, action, note);
      return `${job.company}: marked ${action}.`;
  }
}

function jobRow(job: StoredJob, buttons: Action[], extra = ""): string {
  const age = ageDays(job);
  const where = job.locations.join("; ") || (job.remote ? "Remote" : "");
  const tailored = existsSync(path.join(PATHS.tailored, job.id)) ? ` · <a href="/tailored/${esc(job.id)}" target="_blank">tailored resume</a>` : "";
  return `<li class="job" data-id="${esc(job.id)}">
  <div class="top"><span class="score">${esc(job.score)}</span>
    <div class="what"><a href="${esc(job.url)}" target="_blank" rel="noopener">${esc(job.company)}: ${esc(job.title)}</a>
    <div class="meta">${esc(where)}${age === null ? "" : ` · ${age}d old`} · <code>${esc(job.id)}</code>${tailored}</div></div></div>
  ${job.reasons.length ? `<details><summary>Why this score</summary><ul>${job.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details>` : ""}
  ${extra}
  <div class="actions">${buttons.map((b) => `<button data-action="${b}">${b.replace("_", " ")}</button>`).join("")}</div>
</li>`;
}

export function renderPage(store: Store, profile: Profile, key: string): string {
  const counts = store.counts();
  const newJobs = store.list("new", 30);
  const approved = store.list("shortlisted", 50);
  const recent = store.applications(undefined, 200);
  const latest = new Map<string, (typeof recent)[number]>();
  for (const a of recent) if (!latest.has(a.jobId)) latest.set(a.jobId, a);
  const needsYou = [...latest.values()].filter((a) => ["left_for_you", "needs_you", "unconfirmed", "rejected", "blocked"].includes(a.state));
  const tracked = (["applied", "replied", "interview", "offer"] as const).flatMap((s) => store.list(s, 100));
  const due = new Set(store.followUps(profile.followUpAfterDays).map((f) => f.job.id));
  const sent = counts.applied + counts.replied + counts.interview + counts.offer + counts.rejected;

  const section = (id: string, title: string, note: string, items: string) =>
    `<section id="${id}"><h2>${title}</h2><p class="note">${note}</p>${items ? `<ul class="jobs">${items}</ul>` : `<p class="empty">Nothing here.</p>`}</section>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Search</title>
<style>
:root { --bg: #f7f7f5; --card: #fff; --ink: #1c1c1c; --muted: #666; --line: #e3e3df; --accent: #1f5fbf; --warn: #a15c00; }
@media (prefers-color-scheme: dark) { :root { --bg: #151515; --card: #1f1f1f; --ink: #ececec; --muted: #9a9a9a; --line: #333; --accent: #79a8ff; --warn: #e2a55a; } }
* { box-sizing: border-box; } body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.45 -apple-system, system-ui, sans-serif; }
header { padding: 16px; border-bottom: 1px solid var(--line); background: var(--card); position: sticky; top: 0; z-index: 1; }
h1 { font-size: 18px; margin: 0 0 6px; } nav a { margin-right: 14px; color: var(--accent); text-decoration: none; }
.stats { color: var(--muted); font-size: 13px; margin-top: 4px; }
main { max-width: 900px; margin: 0 auto; padding: 8px 16px 60px; }
h2 { font-size: 16px; margin: 26px 0 2px; } .note, .empty { color: var(--muted); font-size: 13px; margin: 0 0 10px; }
.jobs { list-style: none; padding: 0; margin: 0; } .job { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
.top { display: flex; gap: 10px; align-items: flex-start; } .score { font-weight: 700; min-width: 34px; color: var(--accent); }
.what a { color: var(--ink); font-weight: 600; text-decoration: none; } .what a:hover { text-decoration: underline; }
.meta { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; } .meta a { color: var(--accent); }
details { margin: 4px 0 0 44px; font-size: 13px; color: var(--muted); } details ul { margin: 4px 0; padding-left: 18px; }
.detail { margin: 6px 0 0 44px; font-size: 13px; color: var(--warn); overflow-wrap: anywhere; }
.actions { margin: 8px 0 0 44px; display: flex; flex-wrap: wrap; gap: 6px; }
button { font: inherit; font-size: 13px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); cursor: pointer; }
button[data-action=approve] { border-color: var(--accent); color: var(--accent); }
.due { color: var(--warn); font-weight: 600; } code { font-size: 12px; }
#toast { position: fixed; bottom: 16px; left: 16px; right: 16px; max-width: 600px; margin: auto; background: var(--ink); color: var(--bg); padding: 10px 14px; border-radius: 8px; display: none; }
@media (max-width: 600px) { details, .detail, .actions { margin-left: 0; } }
</style></head><body>
<header><h1>Job Search</h1>
<nav><a href="#today">Today</a><a href="#approved">Approved (${approved.length})</a><a href="#needs">Needs you (${needsYou.length})</a><a href="#tracking">Tracking (${tracked.length})</a></nav>
<div class="stats">${counts.new} new · ${counts.shortlisted} approved · ${sent} sent · ${counts.replied + counts.interview + counts.offer} positive replies · ${due.size} follow-up${due.size === 1 ? "" : "s"} due</div></header>
<main>
${section("today", "Today's best matches", "Approve the ones you want applied to; dismiss the rest. Then run <code>npm run job -- apply --count N</code>.", newJobs.map((j) => jobRow(j, ["approve", "dismiss"])).join(""))}
${section("approved", "Approved", "apply takes these first, best score first.", approved.map((j) => jobRow(j, ["reset", "dismiss", "applied"])).join(""))}
${section(
  "needs",
  "Needs you",
  "Forms the tool filled but did not send, or sent without a confirmation. Finish them on the site, then mark them.",
  needsYou
    .map((a) => {
      const job = store.get(a.jobId);
      return job ? jobRow(job, ["applied", "dismiss"], `<div class="detail">${esc(a.state.replace("_", " "))} (${esc(a.at.slice(0, 10))}): ${esc(a.detail)}</div>`) : "";
    })
    .join(""),
)}
${section(
  "tracking",
  "Tracking",
  "Applications you sent. Mark replies as they come in.",
  tracked
    .map((j) => jobRow(j, ["followed_up", "replied", "interview", "offer", "rejected"], `<div class="detail">${esc(j.status)}${due.has(j.id) ? ` · <span class="due">follow-up due</span>` : ""}</div>`))
    .join(""),
)}
</main><div id="toast"></div>
<script>
const KEY = ${JSON.stringify(key)};
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-action]"); if (!b) return;
  const li = b.closest("[data-id]"); b.disabled = true;
  const r = await fetch("/action", { method: "POST", headers: { "content-type": "application/json", "x-key": KEY }, body: JSON.stringify({ id: li.dataset.id, action: b.dataset.action }) });
  const t = document.getElementById("toast"); t.textContent = (await r.json()).message; t.style.display = "block";
  if (r.ok) setTimeout(() => location.reload(), 700); else b.disabled = false;
});
</script></body></html>`;
}

/** Whether `given` is the dashboard's key, compared in constant time. */
export function keyMatches(key: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(key);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 10_000) throw new Error("too large");
  }
  return s;
}

export function startDashboard(open: () => { store: Store; profile: Profile }, port = 4317): { server: Server; key: string; url: string } {
  const key = randomBytes(18).toString("base64url");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, type: string, text: string) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-frame-options": "DENY" });
      res.end(text);
    };
    try {
      // Only this machine, under the names it was started with.
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) return send(403, "text/plain", "Forbidden");
      if (req.method === "GET" && url.pathname === "/") {
        if (!keyMatches(key, url.searchParams.get("key") ?? undefined)) return send(403, "text/plain", "Open the link the dashboard printed when it started.");
        const { store, profile } = open();
        try {
          return send(200, "text/html; charset=utf-8", renderPage(store, profile, key));
        } finally {
          store.close();
        }
      }
      if (req.method === "GET" && url.pathname.startsWith("/tailored/")) {
        const id = url.pathname.slice("/tailored/".length);
        if (!/^[a-z0-9]{6,12}$/i.test(id)) return send(404, "text/plain", "Not found");
        const dir = path.join(PATHS.tailored, id);
        const pdf = existsSync(dir) ? (await import("node:fs")).readdirSync(dir).find((f) => f.endsWith(".pdf")) : undefined;
        if (!pdf) return send(404, "text/plain", "Not found");
        res.writeHead(200, { "content-type": "application/pdf" });
        return void createReadStream(path.join(dir, pdf)).pipe(res);
      }
      if (req.method === "POST" && url.pathname === "/action") {
        if (!keyMatches(key, req.headers["x-key"] as string | undefined)) return send(403, "application/json", JSON.stringify({ message: "Not allowed." }));
        const { id, action, note } = JSON.parse(await body(req)) as { id: string; action: Action; note?: string };
        if (!(ACTIONS as readonly string[]).includes(action)) return send(400, "application/json", JSON.stringify({ message: `Unknown action ${action}.` }));
        const { store } = open();
        try {
          return send(200, "application/json", JSON.stringify({ message: act(store, id, action, note ?? "") }));
        } finally {
          store.close();
        }
      }
      return send(404, "text/plain", "Not found");
    } catch (err) {
      return send(400, "application/json", JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
    }
  });
  server.listen(port, "127.0.0.1");
  return { server, key, url: `http://127.0.0.1:${port}/?key=${key}` };
}
