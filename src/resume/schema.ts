/**
 * Your resume as data (data/resume.json): the one source every tailored
 * resume is built from. A tailored resume may only choose and order what is
 * here, and rewrite the summary from it.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

export const ResumeSchema = z.object({
  name: z.string().min(1),
  headline: z.string().default(""),
  /** Shown under the name, e.g. city, website, LinkedIn, email. */
  contactLine: z.array(z.string()).default([]),
  summary: z.string().default(""),
  experience: z
    .array(
      z.object({
        title: z.string(),
        company: z.string(),
        location: z.string().default(""),
        dates: z.string().default(""),
        bullets: z.array(z.string()).min(1),
      }),
    )
    .default([]),
  projects: z.array(z.object({ name: z.string(), bullets: z.array(z.string()).min(1) })).default([]),
  skills: z.array(z.object({ group: z.string(), items: z.array(z.string()).min(1) })).default([]),
  education: z.array(z.object({ credential: z.string(), school: z.string(), location: z.string().default("") })).default([]),
  /**
   * True things about you that are not on the resume itself, one per line
   * ("At Acme: built X"). A tailored resume or cover letter may use them.
   */
  facts: z.array(z.string()).default([]),
});
export type Resume = z.infer<typeof ResumeSchema>;

export function loadResume(file: string): Resume {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`No resume data at ${file}. Copy data/resume.example.json there and fill it in from your resume.`);
  }
  const parsed = ResumeSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`The resume data is not valid:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return parsed.data;
}

/** All the text in a resume, for checking a draft against it. */
export function sourceText(r: Resume): string {
  return [
    r.name,
    r.headline,
    r.summary,
    ...r.contactLine,
    ...r.experience.flatMap((e) => [e.title, e.company, e.location, e.dates, ...e.bullets]),
    ...r.projects.flatMap((p) => [p.name, ...p.bullets]),
    ...r.skills.flatMap((s) => [s.group, ...s.items]),
    ...r.education.flatMap((e) => [e.credential, e.school, e.location]),
    ...r.facts,
  ].join("\n");
}
