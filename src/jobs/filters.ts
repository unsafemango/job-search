/**
 * Filters that need no model. Each returns the reason a job was dropped, or
 * null when it stays. Everything personal comes from the profile.
 */
import type { Level, Profile } from "../profile/schema.js";
import { ageDays, hasTerm, type Job } from "./job.js";

const INTERN = /\b(intern|internship|co-?op|student|apprentice|working student)\b/i;
const NEW_GRAD = /\b(new grad(uate)?|graduate|entry[- ]level|junior|jr\.?|early[- ]career|university grad|associate)\b/i;
const SENIOR = /\b(senior|sr\.?|staff|principal|lead|manager|director|head|vp|architect|distinguished)\b/i;

/** The level a title states. A title that states none is taken as mid-level. */
export function levelOf(title: string): Level {
  if (INTERN.test(title)) return "internship";
  if (SENIOR.test(title)) return "senior";
  if (NEW_GRAD.test(title)) return "new_grad";
  return "mid";
}

/** The level a job is: what its title states, else what its source says, else mid-level. */
export function jobLevel(job: Pick<Job, "title" | "level">): Level {
  const fromTitle = levelOf(job.title);
  return fromTitle === "mid" && job.level ? job.level : fromTitle;
}

/** Why a job's title rules it out, or null. Needs only the title, so a source can check before fetching more. */
export function titleReason(job: Pick<Job, "title" | "level">, profile: Profile): string | null {
  if (!profile.target.titles.some((t) => hasTerm(job.title, t))) return "title does not match your target roles";
  const excluded = profile.target.excludeKeywords.find((k) => hasTerm(job.title, k));
  if (excluded) return `title contains "${excluded}"`;
  const level = jobLevel(job);
  if (!profile.target.levels.includes(level)) return `level is ${level}`;
  return null;
}

export type LocationMatch = { weight: number; label: string };

/** How well a job's location suits the profile, or null when it does not. */
export function locationMatch(job: Pick<Job, "locations" | "remote">, profile: Profile): LocationMatch | null {
  const { include, exclude, remote, remoteWeight } = profile.locations;
  const usable = job.locations.filter((loc) => !exclude.some((term) => hasTerm(loc, term)));
  if (job.locations.length > 0 && usable.length === 0) return null;

  let best: LocationMatch | null = null;
  for (const place of include) {
    if (usable.some((loc) => hasTerm(loc, place.match)) && (!best || place.weight > best.weight)) {
      best = { weight: place.weight, label: place.match };
    }
  }
  if (job.remote && remote && (!best || remoteWeight > best.weight)) {
    best = { weight: remoteWeight, label: "remote" };
  }
  if (best) return best;
  if (job.locations.length === 0 && !job.remote) return { weight: 0.3, label: "location not stated" };
  // With no places listed in the profile, anywhere is acceptable.
  if (include.length === 0 && !job.remote) return { weight: 0.5, label: usable[0] ?? "anywhere" };
  return null;
}

export function filterJob(job: Job, profile: Profile, now = new Date()): string | null {
  if (profile.excludeCompanies.some((c) => c.toLowerCase() === job.company.toLowerCase())) {
    return "company is on your exclude list";
  }
  const age = ageDays(job, now);
  if (age !== null && age > profile.maxPostingAgeDays) return `posted ${age} days ago`;

  const byTitle = titleReason(job, profile);
  if (byTitle) return byTitle;

  if (!locationMatch(job, profile)) return "location is outside your list";
  return null;
}
