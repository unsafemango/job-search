/**
 * The baseline fit score, 0 to 100, with the reasons behind it. No model:
 * title, skills found in the posting, location and age. A model-rated score
 * replaces the skills part in phase 2.
 */
import type { Profile } from "../profile/schema.js";
import { locationMatch } from "./filters.js";
import { ageDays, hasTerm, type Job } from "./job.js";

export const WEIGHTS = { title: 35, skills: 35, location: 20, recency: 10 } as const;
/** This many of your skills named in a posting counts as a full match. */
const SKILLS_FOR_FULL_MATCH = 5;

export type Score = { score: number; reasons: string[] };

export function scoreJob(job: Job, profile: Profile, now = new Date()): Score {
  const reasons: string[] = [];

  // Earlier titles in the profile are the ones you want most.
  const titleIndex = profile.target.titles.findIndex((t) => hasTerm(job.title, t));
  const titlePart = titleIndex < 0 ? 0 : 1 - (0.3 * titleIndex) / Math.max(1, profile.target.titles.length - 1 || 1);
  if (titleIndex >= 0) reasons.push(`title matches "${profile.target.titles[titleIndex]}"`);

  let skillsPart: number;
  if (!job.description) {
    skillsPart = 0.4;
    reasons.push("no description to check skills against");
  } else if (profile.skills.length === 0) {
    skillsPart = 0.4;
  } else {
    const text = `${job.title}\n${job.description}`;
    const found = profile.skills.filter((s) => hasTerm(text, s));
    skillsPart = Math.min(1, found.length / Math.min(SKILLS_FOR_FULL_MATCH, profile.skills.length));
    reasons.push(found.length ? `names ${found.length} of your skills: ${found.join(", ")}` : "names none of your skills");
  }

  const loc = locationMatch(job, profile);
  const locationPart = loc?.weight ?? 0;
  if (loc) reasons.push(`location: ${loc.label}`);

  const age = ageDays(job, now);
  const recencyPart = age === null ? 0.5 : Math.max(0, 1 - age / profile.maxPostingAgeDays);
  if (age !== null) reasons.push(age === 0 ? "posted today" : `posted ${age} day${age === 1 ? "" : "s"} ago`);

  const score =
    WEIGHTS.title * titlePart + WEIGHTS.skills * skillsPart + WEIGHTS.location * locationPart + WEIGHTS.recency * recencyPart;
  return { score: Math.round(score), reasons };
}
