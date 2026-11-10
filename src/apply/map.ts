/**
 * Deciding what goes in each field. Claude (headless Claude Code, on your plan)
 * reads the form's questions, the job and your profile, and answers each field
 * from the profile only. Code then checks what matters most, whatever Claude
 * said: work authorization and sponsorship follow the profile, a signature is
 * never given, and an answer must be one of a field's options.
 */
import { z } from "zod";
import type { Job } from "../jobs/job.js";
import type { Usage } from "../model/rating.js";
import type { Profile } from "../profile/schema.js";
import { unsupportedClaims } from "../resume/tailor.js";
import type { FormField } from "./form.js";

export const PlanSchema = z.object({
  verdict: z.enum(["ready", "needs_review", "skip"]),
  reason: z.string(),
  answers: z.array(
    z.object({
      id: z.string(),
      /** One value; several for a multi-select; empty to leave the field alone. For a file, "resume". For a single checkbox, "checked". */
      values: z.array(z.string()),
    }),
  ),
});
export type Plan = z.infer<typeof PlanSchema>;

export type FieldPlan = { field: FormField; values: string[] };

export type MappedForm = {
  fields: FieldPlan[];
  /** Why the form must not be sent as it is; empty when it may be. */
  problems: string[];
  verdict: Plan["verdict"];
  reason: string;
  usage: Usage;
};

export const SYSTEM = `You fill in job application forms for one candidate. You get the candidate's facts and standing answers, the job, and the form's fields. For each field, give the value to enter.

Truth comes first:
- Use only the candidate's facts, standing answers and the job posting. Never invent a fact, number, skill level, date, credential or employer.
- Work authorization, sponsorship, citizenship, education and dates are exactly as the standing answers say. Answer sponsorship for the country the question is about (or the job's country if it does not say).
- If a required field cannot be answered truthfully from the facts, leave it empty and set verdict to "needs_review", naming the field in reason.
- Never sign for the candidate: a field asking them to type their name to agree to something, or an e-signature, stays empty and the verdict is "needs_review".
- If the form requires references, set verdict to "skip" with the reason. Never skip for a cover letter: leave cover letter fields empty, the tool attaches one itself when it is needed.

How to fill:
- For select, combobox, radio and checkboxes fields, every value must be copied exactly from that field's options. For a demographic question the candidate left blank, pick the "decline / prefer not to say" option if there is one, else leave it empty.
- A file field for the resume or CV gets ["resume"]. Leave every other file field empty, including cover letters and "autofill from resume" boxes.
- A single checkbox gets ["checked"] only when the standing answers say yes to what it asks (for example acknowledging a privacy notice when acknowledgePrivacyNotices is true). Marketing and "contact me about other jobs" boxes stay unchecked.
- Location fields get the candidate's city, region and country. Phone fields get the phone as given.
- Salary questions: use the standing answer for the job's level (senior for senior/lead titles, mid otherwise), as a plain number or a short range from it.
- "How did you hear about us": the standing answer, or the closest option.
- Optional free-text questions (why this company, anything else) stay empty, unless a remembered answer fits.
- A required written question (why this role, experience with a tool, bullets showing ability) gets a short answer written in the candidate's own voice, described below the facts. Draw it only from the facts: never claim a skill, tool, employer, number, title or result the facts do not state. If the facts cannot answer it honestly, leave it empty and set verdict to "needs_review". A required one gets two or three plain, specific sentences drawn only from the facts and the posting.
- Leave optional fields empty when the facts do not cover them.

Return every field id once, in "answers", with its values (empty array to leave it alone).`;

/** What Claude is told about the candidate. */
export function factsFor(profile: Profile) {
  return {
    contact: profile.contact,
    standingAnswers: profile.answers,
    background: profile.background,
    skills: profile.skills,
    targetLevels: profile.target.levels,
  };
}

export type Remembered = { question: string; answer: string };

export function promptFor(job: Job, fields: FormField[], profile: Profile, memory: Remembered[] = [], voice = "", knownFacts: string[] = []): string {
  const form = fields.map((f) => ({
    id: f.id,
    kind: f.kind,
    label: f.label,
    ...(f.context && f.context !== f.label ? { context: f.context } : {}),
    required: f.required,
    ...(f.options.length ? { options: f.options } : {}),
    ...(f.hint ? { hint: f.hint } : {}),
  }));
  return [
    "The candidate:",
    JSON.stringify(factsFor(profile), null, 1),
    "",
    "The job:",
    JSON.stringify({ company: job.company, title: job.title, locations: job.locations, remote: job.remote, posting: job.description.slice(0, 4000) }, null, 1),
    "",
    ...(memory.length
      ? [
          "Answers the candidate gave before to similar questions. Reuse one, word for word, when a field asks the same thing; adapt only a company name:",
          JSON.stringify(memory, null, 1),
          "",
        ]
      : []),
    ...(knownFacts.length && fields.some((f) => f.kind === "textarea")
      ? ["More facts about the candidate, for written answers (all true; use only these and the above):", ...knownFacts.map((f) => `- ${f}`), ""]
      : []),
    ...(voice && fields.some((f) => f.kind === "textarea")
      ? ["How the candidate writes (for any written answer):", voice, ""]
      : []),
    "The form's fields:",
    JSON.stringify(form, null, 1),
  ].join("\n");
}

/** A box for a cover letter: a file upload or a text box that says so. */
export function isCoverField(f: FormField): boolean {
  return (f.kind === "file" || f.kind === "textarea") && /cover[\s_-]*letter/i.test(`${f.label} ${f.context} ${f.hint}`);
}

const SPONSOR = /sponsor/i;
/** "Are you authorized to work here without sponsorship?": Yes when you are, the opposite of "will you require sponsorship?". */
const AUTHORIZED_WITHOUT_SPONSORSHIP = /authori[sz]ed[^.?]*without[^.?]*sponsor|without[^.?]*sponsor[^.?]*authori[sz]ed/i;
const AUTHORIZED = /(legally )?(authori[sz]ed|entitled|eligible|permitted)\b.*\bwork|right to work|work authori[sz]ation/i;
const SIGNATURE = /signature|e-?sign|sign (your|here)|type your (full )?(legal )?name to|by typing your name/i;
const YES = /^(yes|y|true)\b/i;
const NO = /^(no|n|false)\b/i;

/** Which country a question is about: one it names, else the job's. */
export function countryFor(text: string, job: Job, profile: Profile): string {
  const known = [...new Set([...Object.keys(profile.answers.needsSponsorship), ...profile.answers.authorizedCountries, "United States", "Canada"])];
  const aliases: Record<string, RegExp> = { "United States": /united states|\bU\.?S\.?A?\b|america/i, Canada: /canad/i };
  for (const c of known) if ((aliases[c] ?? new RegExp(c, "i")).test(text)) return c;
  const where = `${job.locations.join(" ")} ${job.title}`;
  for (const c of known) if ((aliases[c] ?? new RegExp(c, "i")).test(where)) return c;
  return profile.contact.country || "Canada";
}

/** Matches a value to one of a field's options, ignoring case and spacing; null when none fits. */
export function matchOption(value: string, options: string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const v = norm(value);
  return options.find((o) => norm(o) === v) ?? options.find((o) => norm(o).startsWith(v) || v.startsWith(norm(o))) ?? null;
}

/** Checks Claude's plan against the form and the profile. Pure, so it is tested offline. */
/** A cover letter field and what goes in it: ["cover_letter"] for a file box, the letter's text for a text box. */
export type CoverAnswer = { id: string; values: string[] };

export function checkPlan(plan: Plan, fields: FormField[], job: Job, profile: Profile, cover?: CoverAnswer, facts?: string): Omit<MappedForm, "usage"> {
  const byId = new Map(plan.answers.map((a) => [a.id, a.values.map((v) => v.trim()).filter(Boolean)]));
  const problems: string[] = [];
  const out: FieldPlan[] = [];

  for (const field of fields) {
    let values = byId.get(field.id) ?? [];
    const question = `${field.label} ${field.context}`;

    // A single checkbox is ticked with "checked", not an option name.
    if (field.options.length && values.length && field.kind !== "file" && field.kind !== "checkbox") {
      const matched = values.map((v) => matchOption(v, field.options));
      if (matched.some((m) => m === null)) {
        problems.push(`"${field.label}": "${values.join(", ")}" is not one of its options`);
        values = [];
      } else values = matched as string[];
    }
    if (field.kind === "checkbox" && values.length) values = /^(checked|yes|true|on)$/i.test(values[0]!) ? ["checked"] : [];
    if (field.kind === "file") values = values.some((v) => /resume|cv/i.test(v)) && !/autofill|cover/i.test(question) ? ["resume"] : [];
    // The cover letter is the tool's own, written and checked against your facts; Claude does not fill it.
    if (cover && field.id === cover.id) values = cover.values;
    else if (isCoverField(field)) values = [];

    // A written answer may only say what the facts say: any number or named thing they do not hold, and it is not sent.
    if (facts && values.length && (field.kind === "textarea" || (field.kind === "text" && values[0]!.length > 80))) {
      const text = values[0]!.replace(/\s*—\s*/g, ", ");
      const bad = unsupportedClaims(text, `${facts}\n${job.company}\n${job.title}\n${field.label}\n${field.options.join(" ")}`);
      if (bad.length) {
        problems.push(`"${field.label.slice(0, 70)}": the answer named things your facts do not support (${bad.slice(0, 5).join(", ")})`);
        values = [];
      } else values = [text];
    }

    if (SIGNATURE.test(question) && values.length) {
      problems.push(`"${field.label}" asks for a signature, which is left for you`);
      values = [];
    }

    const yesNo = values.length === 1 && (YES.test(values[0]!) || NO.test(values[0]!));
    if (yesNo && AUTHORIZED_WITHOUT_SPONSORSHIP.test(question)) {
      const country = countryFor(question, job, profile);
      const ok = profile.answers.authorizedCountries.some((c) => c.toLowerCase() === country.toLowerCase()) && !(profile.answers.needsSponsorship[country] ?? true);
      if (YES.test(values[0]!) !== ok) {
        problems.push(`"${field.label}": the profile says you ${ok ? "are" : "are not"} authorized to work in ${country} without sponsorship, but the answer was "${values[0]}"`);
        values = [];
      }
    } else if (yesNo && SPONSOR.test(question)) {
      const country = countryFor(question, job, profile);
      const needs = profile.answers.needsSponsorship[country] ?? true;
      if (YES.test(values[0]!) !== needs) {
        problems.push(`"${field.label}": the profile says sponsorship in ${country} is ${needs ? "needed" : "not needed"}, but the answer was "${values[0]}"`);
        values = [];
      }
    } else if (yesNo && AUTHORIZED.test(question)) {
      const country = countryFor(question, job, profile);
      const ok = profile.answers.authorizedCountries.some((c) => c.toLowerCase() === country.toLowerCase());
      if (YES.test(values[0]!) !== ok) {
        problems.push(`"${field.label}": the profile says you are ${ok ? "" : "not "}authorized to work in ${country}, but the answer was "${values[0]}"`);
        values = [];
      }
    }

    if (field.required && values.length === 0) problems.push(`"${field.label}" is required and has no answer`);
    out.push({ field, values });
  }
  if (plan.verdict !== "ready") problems.unshift(`Claude: ${plan.verdict.replace("_", " ")}: ${plan.reason}`);
  return { fields: out, problems: [...new Set(problems)], verdict: plan.verdict, reason: plan.reason };
}

/** The JSON schema for the plan, without keywords structured output does not take. */
export function planJsonSchema(): object {
  const schema = z.toJSONSchema(PlanSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}
