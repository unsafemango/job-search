/** Renders a resume to a one-page-style PDF through Chrome. */
import { chromium } from "playwright-core";
import type { Job } from "../jobs/job.js";
import type { Resume } from "./schema.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function resumeHtml(r: Resume): string {
  const section = (title: string, body: string) => (body ? `<h2>${title}</h2>${body}` : "");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: Letter; margin: 0.45in 0.55in; }
  body { font: 9.6pt/1.32 "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; margin: 0; }
  h1 { font-size: 19pt; margin: 0; text-align: center; color: #1f3a5f; letter-spacing: 0.5px; }
  .headline { text-align: center; margin: 2px 0; font-size: 10.2pt; }
  .contact { text-align: center; font-size: 8.8pt; margin-bottom: 6px; }
  h2 { break-after: avoid; page-break-after: avoid; } li, .role, .where { break-inside: avoid; }
  h2 { font-size: 10.2pt; color: #1f3a5f; border-bottom: 1px solid #1f3a5f; margin: 8px 0 3px; text-transform: uppercase; }
  .role { display: flex; justify-content: space-between; font-weight: 600; margin-top: 5px; }
  .where { font-style: italic; color: #555; font-size: 8.8pt; }
  ul { margin: 2px 0 0 0; padding-left: 15px; } li { margin: 1px 0; }
  .skills div { margin: 1px 0; } .edu { display: flex; justify-content: space-between; }
  p { margin: 0; }
</style></head><body>
<h1>${esc(r.name)}</h1>
<div class="contact">${r.contactLine.map(esc).join(" &bull; ")}</div>
${r.headline ? `<div class="headline"><b>${esc(r.headline)}</b></div>` : ""}
${section("Summary", r.summary ? `<p>${esc(r.summary)}</p>` : "")}
${section("Technical Skills", `<div class="skills">${r.skills.map((s) => `<div><b>${esc(s.group)}:</b> ${s.items.map(esc).join(", ")}</div>`).join("")}</div>`)}
${section(
  "Experience",
  r.experience
    .map(
      (e) => `<div class="role"><span>${esc(e.title)} | ${esc(e.company)}</span><span>${esc(e.dates)}</span></div>
<div class="where">${esc(e.location)}</div><ul>${e.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`,
    )
    .join(""),
)}
${section("Selected Projects", r.projects.length ? `<ul>${r.projects.map((p) => `<li><b>${esc(p.name)}:</b> ${p.bullets.map(esc).join(" ")}</li>`).join("")}</ul>` : "")}
${section("Education", r.education.map((e) => `<div class="edu"><span><b>${esc(e.credential)}</b> | ${esc(e.school)}</span><span class="where">${esc(e.location)}</span></div>`).join(""))}
</body></html>`;
}

/** Writes the PDF and returns its page count. */
export async function renderPdf(resume: Resume, file: string): Promise<number> {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(resumeHtml(resume), { waitUntil: "load" });
    const pdf = await page.pdf({ path: file, format: "Letter", printBackground: true, preferCSSPageSize: true });
    return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  } finally {
    await browser.close();
  }
}

export function letterHtml(r: Resume, job: Job, paragraphs: string[], today = new Date()): string {
  const date = today.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: Letter; margin: 0.9in 1in; }
  body { font: 11pt/1.5 "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; margin: 0; }
  h1 { font-size: 17pt; margin: 0; color: #1f3a5f; } .contact { font-size: 9.5pt; color: #444; margin: 2px 0 26px; }
  p { margin: 0 0 11px; }
</style></head><body>
<h1>${esc(r.name)}</h1><div class="contact">${r.contactLine.map(esc).join(" &bull; ")}</div>
<p>${esc(date)}</p>
<p>Hi ${esc(job.company)} team,</p>
${paragraphs.map((p) => `<p>${esc(p)}</p>`).join("\n")}
<p>Thank you,<br>${esc(r.name)}</p>
</body></html>`;
}

export async function renderLetterPdf(resume: Resume, job: Job, paragraphs: string[], file: string): Promise<void> {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(letterHtml(resume, job, paragraphs), { waitUntil: "load" });
    await page.pdf({ path: file, format: "Letter", printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}
