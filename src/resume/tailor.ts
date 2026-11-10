/**
 * A resume, and a cover letter when a job needs one, written for one job from
 * your resume data (data/resume.json: the resume plus extra true facts), in
 * your voice (data/voice.md). Claude rewrites freely: a headline for the role,
 * the summary, skills grouped for the posting, bullets reworded toward it.
 * Then code checks every number and named term against your facts. A draft
 * that names something you never did is sent back once with the list; what
 * still fails after that is dropped, never sent.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Job } from "../jobs/job.js";
import { claudeCodeJson, type Runner } from "../model/claude-code.js";
import type { Profile } from "../profile/schema.js";
import { sourceText, type Resume } from "./schema.js";

/** Common words that start sentences in resumes and letters. A capitalized first word not here, not in your resume, and not shaped like an ordinary word (-ed, -ing, -ly) is checked like a name: "Rust" is a claim. */
const STARTERS = new Set(
  ("a an the i i've i'm i'd my me we our this that these those it its at in on for with from by to of as and or but so also then when while before after during " +
    "since because if once first next last today now here there what which who how why where both each every all most some many more less other another " +
    "use uses write writes run runs set sets add adds build builds lead leads own owns work works help helps make makes take takes keep keeps fix fixes " +
    "review reviews ship ships test tests comfortable familiar strong solid hands senior junior full backend frontend fluent able good great years over about around nearly")
    .split(" "),
);
function isOrdinary(word: string): boolean {
  const w = word.toLowerCase();
  return STARTERS.has(w) || /(ed|ing|ly)$/.test(w);
}

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
  for (const sentence of draft.split(/(?<=[.!?:])\s+/)) {
    const words = sentence.match(/[A-Za-z][\w.+#/-]*[\w+#]|[A-Za-z]/g) ?? [];
    words.forEach((word, i) => {
      // "PHP/Laravel" and "Kafka-based" are claims about PHP, Laravel and Kafka.
      word.split(/[/-]/).filter(Boolean).forEach((w, j) => {
        const technical = /^[A-Z]/.test(w) || /[A-Z]/.test(w.slice(1)) || /\d/.test(w) || /\.[a-z]/i.test(w);
        if (!technical || w === "I") return;
        // Sentence case: the capital on a sentence's first word is not a name, when the word is an ordinary one.
        if (i === 0 && j === 0 && /^[A-Z][a-z]+$/.test(w) && isOrdinary(w)) return;
        if (!src.includes(flat(w))) out.add(word);
      });
    });
  }
  return [...out];
}

/** Words and phrases that make writing sound like a template rather than a person. */
export const AVOID = [
  "delve", "leverage", "utilize", "facilitate", "testament", "robust", "comprehensive", "seamless", "pivotal",
  "multifaceted", "nuanced", "transformative", "innovative", "groundbreaking", "cutting-edge", "passionate",
  "spearheaded", "mission-driven", "furthermore", "moreover", "thus", "hence", "wherein", "aforementioned",
  "i'm excited to", "i'm thrilled", "i'd welcome the chance", "hope this finds you well", "don't hesitate",
];

/** Style problems in a draft: em dashes, avoid-list words, placeholders. Pure. */
export function styleProblems(text: string): string[] {
  const out: string[] = [];
  if (/—/.test(text)) out.push("em dashes");
  const lower = text.toLowerCase();
  for (const w of AVOID) if (new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(lower)) out.push(`"${w}"`);
  if (/\[x\]/i.test(text)) out.push("a [X] placeholder");
  return out;
}

const DEFAULT_VOICE = `Write the way a real person talks, a little cleaner. Easy words, short sentences, one idea each. Warm and direct. No em dashes. Nothing that sounds like an ad, a slogan or a neat summary line. Never make anything up.`;

export function loadVoice(file: string): string {
  // The first rules carry the voice; the avoid-list and style checks are enforced in code, not by repeating them here.
  return existsSync(file) ? readFileSync(file, "utf8").replace(/^---[\s\S]*?---\s*/, "").slice(0, 4500) : DEFAULT_VOICE;
}

export const ResumeDraftSchema = z.object({
  /** One line under the name: the role and the stack the job wants, e.g. "Backend Developer · Java/Spring Boot, Kafka, SQL". */
  headline: z.string(),
  summary: z.string(),
  skills: z.array(z.object({ group: z.string(), items: z.array(z.string()) })),
  /** Roles by their index in the resume, most recent first; a role that does not help may be left out. */
  experience: z.array(z.object({ role: z.number().int(), bullets: z.array(z.string()) })),
  projects: z.array(z.object({ project: z.number().int(), text: z.string() })),
  /** Words from the posting the resume now uses. */
  keywords: z.array(z.string()),
  /** What the posting asks for that the facts do not show. Never put on the resume. */
  gaps: z.array(z.string()),
  /** Questions whose answers (numbers) would make the resume stronger. */
  numbersToAdd: z.array(z.string()),
});
export type ResumeDraft = z.infer<typeof ResumeDraftSchema>;

export const LetterSchema = z.object({ paragraphs: z.array(z.string()) });

const RESUME_SYSTEM = (voice: string) => `You write one candidate's resume for one job. Use only what the candidate's resume and facts say: never add a skill, tool, employer, number, title or result they do not state. If the posting wants something the facts do not show, list it under gaps and leave it off the resume.

Write it for this job:
- headline: a role name the candidate can truthfully claim from their own titles (like "Backend Developer" or "Full Stack Developer"; never the job's own title or a seniority they have not held), then the 3 to 5 skills from the facts that matter most for this job, like "Backend Developer · Java/Spring Boot, Kafka, SQL, Microservices".
- summary: 2 to 4 short plain sentences in the first person without "I am a", leading with what this job needs most.
- skills: 3 to 5 groups, most relevant first, each with only items from the resume or facts.
- experience: roles by index, most recent first. 2 to 7 bullets for each role you keep, most relevant first, reworded toward the posting but saying only what the facts say. Leave out a role that does not help this job, except the current one.
- projects: up to 3, by index, each as one sentence or two from its facts, starting with the stack in parentheses, without repeating the project's name (it is shown before your text).
- keywords: posting words the resume now uses. gaps: what the posting asks for that the facts do not show. numbersToAdd: up to 3 questions whose answers would add a real number.

The candidate's voice (follow it for every line; it applies to resumes too, so keep bullets plain):
${voice}`;

const LETTER_SYSTEM = (voice: string) => `You write a short cover letter from one candidate for one job, in their voice. Use only what their resume and facts say. Never mention a skill or experience they do not have, and never mention gaps. Do not state guesses about the company as fact. Do not name teams, products or people that are not in the job title or the facts.

Write 4 to 6 short paragraphs, no greeting and no sign-off (those are added for you):
1. Which role you're applying for, and one or two plain facts about you (where you are, how long you've built software).
2 to 4. For the two or three things the posting asks for most, what you did that matches, as plain facts from the facts.
Last. One short line, like "I'd love to talk more about the role."

The candidate's voice (follow it for every line):
${voice}`;

const strip = (s: string) => s.replace(/\s*—\s*/g, ", ").replace(/\s+/g, " ").trim();

/** What the model sees: the resume with each role and project numbered, and the extra facts. */
function sourceFor(resume: Resume) {
  return {
    name: resume.name,
    summary: resume.summary,
    roles: resume.experience.map((e, role) => ({ role, title: e.title, company: e.company, location: e.location, dates: e.dates, bullets: e.bullets })),
    projects: resume.projects.map((p, project) => ({ project, name: p.name, about: p.bullets })),
    skills: resume.skills,
    education: resume.education,
    facts: resume.facts,
  };
}

function jobFor(job: Job) {
  return { company: job.company, title: job.title, locations: job.locations, posting: job.description.slice(0, 5000) };
}

export type WrittenResume = { resume: Resume; draft: ResumeDraft; dropped: string[] };

/** Every piece of a draft that makes a claim, for checking. */
function pieces(d: ResumeDraft): string[] {
  return [d.headline, d.summary, ...d.skills.flatMap((s) => s.items), ...d.experience.flatMap((e) => e.bullets), ...d.projects.map((p) => p.text)];
}

function problemsIn(texts: string[], source: string): { claims: string[]; style: string[] } {
  const claims = new Set<string>();
  const style = new Set<string>();
  for (const t of texts) {
    for (const c of unsupportedClaims(t, source)) claims.add(c);
    for (const s of styleProblems(t)) style.add(s);
  }
  return { claims: [...claims], style: [...style] };
}

function feedback(p: { claims: string[]; style: string[] }): string {
  const lines = ["Your last draft had problems. Write it again without them."];
  if (p.claims.length) lines.push(`It named things the resume and facts do not: ${p.claims.join(", ")}. Leave them out, or say only what the facts say.`);
  if (p.style.length) lines.push(`It used ${p.style.join(", ")}. Do not.`);
  return lines.join("\n");
}

/**
 * Builds the tailored resume from a checked draft. Anything that still makes
 * an unsupported claim is dropped: a bullet, a project, a skill; the summary
 * and headline fall back to the resume's own. Pure, so it is tested offline.
 */
export function assembleResume(resume: Resume, draft: ResumeDraft): WrittenResume {
  const source = sourceText(resume);
  const dropped: string[] = [];
  const ok = (t: string) => {
    const bad = unsupportedClaims(t, source);
    if (bad.length) dropped.push(`${t.slice(0, 80)}${t.length > 80 ? "…" : ""} (${bad.join(", ")})`);
    return bad.length === 0;
  };
  const roles = draft.experience
    .filter((e) => e.role >= 0 && e.role < resume.experience.length)
    .filter((e, i, all) => all.findIndex((x) => x.role === e.role) === i)
    .map((e) => {
      const base = resume.experience[e.role]!;
      const bullets = e.bullets.map(strip).filter(Boolean).filter(ok);
      return { ...base, bullets: bullets.length ? bullets : base.bullets.slice(0, 2) };
    });
  // The current role always stays.
  if (resume.experience.length && !draft.experience.some((e) => e.role === 0)) roles.unshift(resume.experience[0]!);
  const projects = draft.projects
    .filter((p) => p.project >= 0 && p.project < resume.projects.length)
    .map((p) => {
      const name = resume.projects[p.project]!.name;
      // The name is shown before the text; drop it if the text repeats it.
      const short = name.replace(/\s*\(.*\)\s*$/, "");
      const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      let text = strip(p.text);
      for (const n of [name, short]) text = strip(text.replace(new RegExp(`(^|\\)\\s*)${esc(n)}\\s*(,|:)?\\s*`), "$1 "));
      return { name: short, bullets: [text] };
    })
    .filter((p) => ok(p.bullets[0]!));
  const skills = draft.skills
    .map((s) => ({ group: strip(s.group), items: s.items.map(strip).filter((i) => i && unsupportedClaims(i, source).length === 0) }))
    .filter((s) => s.items.length);
  const headline = strip(draft.headline);
  const summary = strip(draft.summary);
  return {
    resume: {
      ...resume,
      headline: headline && ok(headline) ? headline : resume.headline,
      summary: summary && ok(summary) ? summary : resume.summary,
      experience: roles,
      projects,
      skills: skills.length ? skills : resume.skills,
    },
    draft,
    dropped,
  };
}

export async function writeResume(resume: Resume, job: Job, profile: Profile, voice: string, run?: Runner): Promise<WrittenResume> {
  const source = sourceText(resume);
  let prompt = `The resume and facts:\n${JSON.stringify(sourceFor(resume), null, 1)}\n\nThe job:\n${JSON.stringify(jobFor(job), null, 1)}`;
  let draft: ResumeDraft | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { value } = await claudeCodeJson({
      command: profile.rating.command,
      model: profile.apply.writeModel,
      effort: profile.apply.effort,
      system: RESUME_SYSTEM(voice),
      prompt,
      schema: jsonSchema(ResumeDraftSchema),
      run,
    });
    const parsed = ResumeDraftSchema.safeParse(value);
    if (!parsed.success) throw new Error("Claude's resume draft could not be read");
    draft = parsed.data;
    const p = problemsIn(pieces(draft), source);
    if (!p.claims.length && !p.style.filter((s) => s !== "em dashes").length) break;
    prompt += `\n\n${feedback(p)}`;
  }
  return assembleResume(resume, draft!);
}

export type WrittenLetter = { paragraphs: string[]; dropped: string[] };

/**
 * The letter's paragraphs, checked. A paragraph that still names something
 * the facts do not is dropped; null when too little is left to send. Pure.
 */
export function assembleLetter(paragraphs: string[], source: string): WrittenLetter | null {
  const dropped: string[] = [];
  const kept = paragraphs.map(strip).filter((p) => {
    const bad = [...unsupportedClaims(p, source), ...styleProblems(p).filter((s) => s === "a [X] placeholder")];
    if (bad.length) dropped.push(`${p.slice(0, 80)}… (${bad.join(", ")})`);
    return p && !bad.length;
  });
  return kept.length >= 3 ? { paragraphs: kept, dropped } : null;
}

export async function writeCoverLetter(resume: Resume, job: Job, profile: Profile, voice: string, run?: Runner): Promise<WrittenLetter | null> {
  // The company and the role's title may be named; nothing else beyond the facts.
  const source = `${sourceText(resume)}\n${job.company}\n${job.title}`;
  let prompt = `The resume and facts:\n${JSON.stringify(sourceFor(resume), null, 1)}\n\nThe job:\n${JSON.stringify(jobFor(job), null, 1)}`;
  let paragraphs: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const { value } = await claudeCodeJson({
      command: profile.rating.command,
      model: profile.apply.writeModel,
      effort: profile.apply.effort,
      system: LETTER_SYSTEM(voice),
      prompt,
      schema: jsonSchema(LetterSchema),
      run,
    });
    const parsed = LetterSchema.safeParse(value);
    if (!parsed.success) throw new Error("Claude's cover letter could not be read");
    paragraphs = parsed.data.paragraphs;
    const p = problemsIn(paragraphs, source);
    if (!p.claims.length && !p.style.filter((s) => s !== "em dashes").length) break;
    prompt += `\n\n${feedback(p)}`;
  }
  return assembleLetter(paragraphs, source);
}

/** Notes for you: keywords used, gaps not to claim, numbers that would help. */
export function notesFor(job: Job, written: WrittenResume, letter: WrittenLetter | null | undefined): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- none");
  return [
    `# ${job.company}: ${job.title}`,
    "",
    `Posting: ${job.url}`,
    "",
    "## Keywords in this resume",
    written.draft.keywords.join(", ") || "none",
    "",
    "## Gaps (in the posting, not in your facts)",
    "Don't add these unless they're true. If one is, add it to data/resume.json under facts.",
    list(written.draft.gaps),
    "",
    "## Numbers that would help",
    list(written.draft.numbersToAdd),
    ...(written.dropped.length || letter?.dropped.length
      ? ["", "## Left out because your facts don't support them", list([...written.dropped, ...(letter?.dropped ?? [])])]
      : []),
    "",
  ].join("\n");
}

function jsonSchema(schema: z.ZodType): object {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
