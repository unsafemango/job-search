/**
 * A resume tailored to one job. Claude only chooses: which bullets to keep for
 * each role and in what order, which projects, which skill groups first, and a
 * rewritten summary. Bullets are never reworded. The summary is then checked in
 * code: any number or named term it uses must already be in your resume, or
 * the tailored resume is refused.
 */
import { z } from "zod";
import type { Job } from "../jobs/job.js";
import { claudeCodeJson, type Runner } from "../model/claude-code.js";
import type { Profile } from "../profile/schema.js";
import { sourceText, type Resume } from "./schema.js";

export const TailorSchema = z.object({
  summary: z.string(),
  experience: z.array(z.object({ index: z.number().int(), bullets: z.array(z.number().int()) })),
  projects: z.array(z.number().int()),
  skillGroups: z.array(z.number().int()),
});
export type TailorPlan = z.infer<typeof TailorSchema>;

const SYSTEM = `You tailor one candidate's resume to one job. You may only choose and order what is already in the resume; you never write new bullets or change their words.

Return:
- summary: a rewrite of the resume's summary, 2 to 4 sentences, that leads with what this job most needs. Use only facts, numbers, employers, products and technologies that appear in the resume. Do not name the company being applied to. Do not add years, numbers or skills that the resume does not state. Keep personal projects clearly apart from employers: never say a project was built at or for an employer.
- experience: for every role, by its index, the indexes of the bullets to keep, most relevant first. Keep every role and at least one bullet per role. Aim for about 10 to 12 bullets in total, to keep it focused: keep more from the roles that matter most for this job, and drop bullets that do not help.
- projects: the indexes of the projects to keep, most relevant first; at most one, or none if neither helps.
- skillGroups: the indexes of the skill groups, most relevant first (keep all that help).`;

/**
 * The claims in `draft` that `source` does not support: numbers it does not
 * contain, and named or technical terms (a capital, a digit or a dot in the
 * word: React, AWS, Next.js, ES6) it never mentions. A plain capitalized word
 * that only starts a sentence ("Experienced") is wording, not a claim. Pure,
 * so it is tested offline.
 */
export function unsupportedClaims(draft: string, source: string): string[] {
  const flat = (s: string) => s.toLowerCase().replace(/[-–]/g, " ");
  const src = flat(source);
  const srcNumbers = new Set(source.replace(/,/g, "").match(/\d+(\.\d+)?/g) ?? []);
  const out = new Set<string>();
  for (const n of draft.replace(/,/g, "").match(/\d+(\.\d+)?/g) ?? []) if (!srcNumbers.has(n)) out.add(n);
  for (const sentence of draft.split(/(?<=[.!?])\s+/)) {
    const words = sentence.match(/[A-Za-z][\w.+#/-]*[\w+#]|[A-Za-z]/g) ?? [];
    words.forEach((word, i) => {
      // "PHP/Laravel" and "Kafka-based" are claims about PHP, Laravel and Kafka.
      word.split(/[/-]/).filter(Boolean).forEach((w, j) => {
        const technical = /^[A-Z]/.test(w) || /[A-Z]/.test(w.slice(1)) || /\d/.test(w) || /\.[a-z]/i.test(w);
        if (!technical || w === "I") return;
        // Sentence case: the capital on a sentence's first word is not a name.
        if (i === 0 && j === 0 && /^[A-Z][a-z]+$/.test(w)) return;
        if (!src.includes(flat(w))) out.add(word);
      });
    });
  }
  return [...out];
}

/** Applies a plan to the resume, keeping only valid indexes. */
export function applyPlan(resume: Resume, plan: TailorPlan): Resume {
  const pick = <T>(items: T[], idx: number[]) => [...new Set(idx)].filter((i) => i >= 0 && i < items.length).map((i) => items[i]!);
  const chosen = new Map(plan.experience.map((e) => [e.index, e.bullets]));
  return {
    ...resume,
    summary: plan.summary.trim() || resume.summary,
    experience: resume.experience.map((e, i) => {
      const bullets = pick(e.bullets, chosen.get(i) ?? []);
      return { ...e, bullets: bullets.length ? bullets : e.bullets.slice(0, 1) };
    }),
    projects: plan.projects.length ? pick(resume.projects, plan.projects) : [],
    skills: (() => {
      const groups = pick(resume.skills, plan.skillGroups);
      return groups.length ? groups : resume.skills;
    })(),
  };
}

/**
 * One step shorter: drops the last (least relevant) bullet of the role with
 * the most, or failing that a project. Null when nothing more can go.
 */
export function trimOnce(r: Resume): Resume | null {
  if (r.projects.length > 1) return { ...r, projects: r.projects.slice(0, -1) };
  let most = -1;
  r.experience.forEach((e, i) => {
    if (e.bullets.length > 1 && (most < 0 || e.bullets.length > r.experience[most]!.bullets.length)) most = i;
  });
  if (most < 0) return r.projects.length ? { ...r, projects: [] } : null;
  return { ...r, experience: r.experience.map((e, i) => (i === most ? { ...e, bullets: e.bullets.slice(0, -1) } : e)) };
}

export type Tailored = { resume: Resume; plan: TailorPlan; refused: string[] };

export async function tailorResume(resume: Resume, job: Job, profile: Profile, run?: Runner): Promise<Tailored> {
  const indexed = {
    summary: resume.summary,
    experience: resume.experience.map((e, index) => ({ index, title: e.title, company: e.company, dates: e.dates, bullets: e.bullets.map((b, i) => ({ i, b })) })),
    projects: resume.projects.map((p, index) => ({ index, name: p.name, bullets: p.bullets })),
    skillGroups: resume.skills.map((s, index) => ({ index, group: s.group, items: s.items })),
  };
  const { value } = await claudeCodeJson({
    command: profile.rating.command,
    model: profile.apply.model,
    effort: profile.apply.effort,
    system: SYSTEM,
    prompt: `The resume:\n${JSON.stringify(indexed, null, 1)}\n\nThe job:\n${JSON.stringify({ company: job.company, title: job.title, posting: job.description.slice(0, 6000) }, null, 1)}`,
    schema: (({ $schema, ...rest }) => rest)(z.toJSONSchema(TailorSchema) as Record<string, unknown>),
    run,
  });
  const plan = TailorSchema.safeParse(value);
  if (!plan.success) throw new Error("Claude's tailoring answer could not be read");
  const refused = unsupportedClaims(plan.data.summary, sourceText(resume));
  return { resume: applyPlan(resume, refused.length ? { ...plan.data, summary: resume.summary } : plan.data), plan: plan.data, refused };
}
