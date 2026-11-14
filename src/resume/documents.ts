/**
 * A job's application documents, in data/tailored/<job id>/: the tailored
 * resume, a cover letter when asked for, and notes for you. They are made for
 * one application and deleted once it is sent.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Job } from "../jobs/job.js";
import { PATHS } from "../paths.js";
import type { Profile } from "../profile/schema.js";
import { renderLetterPdf, renderPdf } from "./render.js";
import { loadResume, type Resume } from "./schema.js";
import { loadVoice, notesFor, writeCoverLetter, writeResume, type WrittenLetter } from "./tailor.js";

export type Documents = { dir: string; resume: string; coverLetter: string | null; notes: string; dropped: string[]; pages: number };

const fileName = (profile: Profile, what: string) => {
  const parts = [profile.contact.firstName, profile.contact.lastName].filter(Boolean);
  return `${parts.length ? parts.join("_") : "My"}_${what}.pdf`.replace(/[^\w.-]+/g, "_");
};
export const resumeName = (profile: Profile) => fileName(profile, "Resume");
export const coverLetterName = (profile: Profile) => fileName(profile, "Cover_Letter");
/** The name a file shows on the application: First_Last_<Company>_<Role>_Resume.pdf. */
export const uploadName = (profile: Profile, job: { company: string; title: string }, what: "Resume" | "Cover_Letter") => {
  const who = [profile.contact.firstName, profile.contact.lastName].filter(Boolean).join("_") || "My";
  const part = (t: string) => t.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
  return `${who}_${part(job.company)}_${part(job.title)}_${what}.pdf`.replace(/[^\w.-]+/g, "_");
};

export function documentsDir(jobId: string): string {
  return path.join(PATHS.tailored, jobId);
}

/** The documents already made for a job, if any. */
export function existingDocuments(profile: Profile, jobId: string): { resume: string | null; coverLetter: string | null } {
  const dir = documentsDir(jobId);
  const at = (name: string) => (existsSync(path.join(dir, name)) ? path.join(dir, name) : null);
  return { resume: at(resumeName(profile)), coverLetter: at(coverLetterName(profile)) };
}

/**
 * One step shorter: drops the last (least relevant) bullet of the role with
 * the most, or failing that a project. Null when nothing more can go. Pure.
 */
export function trimOnce(r: Resume): Resume | null {
  if (r.projects.length > 1) return { ...r, projects: r.projects.slice(0, -1) };
  // Older roles give up bullets first (the one with the most); the current role, the first, keeps its bullets longest.
  const pick = (from: number): number => {
    let most = -1;
    r.experience.forEach((e, i) => {
      if (i >= from && e.bullets.length > 1 && (most < 0 || e.bullets.length > r.experience[most]!.bullets.length)) most = i;
    });
    return most;
  };
  let most = pick(1);
  if (most < 0 && r.projects.length) return { ...r, projects: [] };
  if (most < 0) most = pick(0);
  if (most < 0) return null;
  return { ...r, experience: r.experience.map((e, i) => (i === most ? { ...e, bullets: e.bullets.slice(0, -1) } : e)) };
}

/** Writes the tailored resume (and a cover letter when `cover`), checked, as PDFs. */
export async function prepareDocuments(job: Job, profile: Profile, opts: { cover: boolean }): Promise<Documents> {
  const base = loadResume(PATHS.resumeData);
  const voice = loadVoice(PATHS.voice);
  const dir = documentsDir(job.id);
  mkdirSync(dir, { recursive: true });

  const written = await writeResume(base, job, profile, voice);
  const resumeFile = path.join(dir, resumeName(profile));
  let resume = written.resume;
  let pages = await renderPdf(resume, resumeFile);
  for (let next = trimOnce(resume); pages > 1 && next; next = trimOnce(resume)) {
    resume = next;
    pages = await renderPdf(resume, resumeFile);
  }

  let letter: WrittenLetter | null = null;
  let coverFile: string | null = null;
  if (opts.cover) {
    letter = await writeCoverLetter(base, job, profile, voice);
    if (letter) {
      coverFile = path.join(dir, coverLetterName(profile));
      await renderLetterPdf(base, job, letter.paragraphs, coverFile);
      writeFileSync(path.join(dir, "cover-letter.txt"), letter.paragraphs.join("\n\n") + "\n");
    }
  }
  const notes = path.join(dir, "notes.md");
  writeFileSync(notes, notesFor(job, written, letter));
  writeFileSync(path.join(dir, "tailored.json"), JSON.stringify({ draft: written.draft, resume, letter }, null, 2));
  return { dir, resume: resumeFile, coverLetter: coverFile, notes, dropped: [...written.dropped, ...(letter?.dropped ?? [])], pages };
}

/** The cover letter's text, for a form that asks for it in a box rather than a file. */
export function coverLetterText(jobId: string, profile: Profile): string | null {
  const file = path.join(documentsDir(jobId), "cover-letter.txt");
  if (!existsSync(file)) return null;
  const body = readFileSync(file, "utf8");
  const name = [profile.contact.firstName, profile.contact.lastName].filter(Boolean).join(" ");
  return body ? `${body.trim()}\n\nThank you,\n${name}` : null;
}

/** Deletes a job's documents once its application is sent; true when there were any. */
export function deleteDocuments(jobId: string): boolean {
  const dir = documentsDir(jobId);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Job ids that have documents. */
export function jobsWithDocuments(): string[] {
  return existsSync(PATHS.tailored) ? readdirSync(PATHS.tailored) : [];
}

/** Deletes the working copies of every job that is already applied (sent by the tool or by you). Returns how many folders went. */
export function deleteAppliedDocuments(isApplied: (jobId: string) => boolean): number {
  let n = 0;
  for (const id of jobsWithDocuments()) if (isApplied(id) && deleteDocuments(id)) n++;
  return n;
}
