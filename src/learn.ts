/**
 * Learning from outcomes. `learnWeights` compares the score parts of
 * applications that got a positive reply with those that did not, and moves
 * the weights toward what has worked, within limits and only once there are
 * enough outcomes. `classifyEmail` reads a reply's sender and subject and says
 * which job it is about and what it means. Both are pure and tested offline.
 */
import type { Status, StoredJob } from "./db.js";
import { WEIGHTS, type ScoreParts } from "./jobs/score.js";
import { sameCompany } from "./referrals.js";

export const MIN_SENT = 20;
export const MIN_POSITIVE = 5;
const PARTS = ["title", "skills", "location", "recency"] as const;

export type PartReport = { part: (typeof PARTS)[number]; positive: number; negative: number; weight: number; learned: number };
export type Learned = { ready: boolean; why: string; sent: number; positive: number; parts: PartReport[]; weights: ScoreParts };

export function learnWeights(outcomes: { parts: ScoreParts; positive: boolean }[], base: ScoreParts = { ...WEIGHTS }): Learned {
  const pos = outcomes.filter((o) => o.positive);
  const neg = outcomes.filter((o) => !o.positive);
  const mean = (xs: typeof outcomes, k: keyof ScoreParts) => (xs.length ? xs.reduce((s, o) => s + o.parts[k], 0) / xs.length : 0);
  const raw = PARTS.map((k) => {
    const diff = mean(pos, k) - mean(neg, k);
    // A part that is higher in jobs that got replies counts for more, at most 1.5x and at least 0.5x.
    const factor = Math.min(1.5, Math.max(0.5, 1 + 2 * diff));
    return { part: k, positive: mean(pos, k), negative: mean(neg, k), weight: base[k], raw: base[k] * factor };
  });
  const total = raw.reduce((s, r) => s + r.raw, 0) || 1;
  const parts = raw.map(({ raw: r, ...rest }) => ({ ...rest, learned: Math.round((r / total) * 1000) / 10 }));
  const weights = Object.fromEntries(parts.map((p) => [p.part, p.learned])) as ScoreParts;
  const ready = outcomes.length >= MIN_SENT && pos.length >= MIN_POSITIVE && neg.length >= MIN_POSITIVE;
  const why = ready
    ? "enough outcomes to learn from"
    : `needs at least ${MIN_SENT} sent applications with ${MIN_POSITIVE} positive replies and ${MIN_POSITIVE} without (have ${outcomes.length} sent, ${pos.length} positive)`;
  return { ready, why, sent: outcomes.length, positive: pos.length, parts, weights };
}

export type Email = { from: string; subject: string; snippet?: string; date?: string };
export type Classified = { email: Email; job: StoredJob | null; status: Exclude<Status, "new" | "shortlisted" | "applied" | "dismissed"> | null; label: string };

const OFFER = /\b(pleased to (extend|offer)|offer letter|job offer|offer of employment)\b/i;
const INTERVIEW = /\b(interview|schedule (a|some) (time|call|chat)|availability|next steps?|phone screen|technical (screen|assessment)|coding (challenge|assessment)|hackerrank|codesignal|meet with)\b/i;
const REJECTED = /\b(unfortunately|not (to )?(be )?mov(e|ing) forward|other candidates|decided (not )?to (pursue|move forward with)|no longer (being )?considered|position has been filled|not selected|regret to inform|won't be moving)\b/i;
const RECEIVED = /\b(thank(s| you) for (applying|your (application|interest))|application (was |has been )?received|we('ve| have) received your application)\b/i;

/** The company an email comes from: its sender name, else its domain, else its subject. */
function senderNames(e: Email): string[] {
  const name = e.from.replace(/<.*>/, "").replace(/["']/g, "").trim();
  const domain = (e.from.match(/@([\w.-]+)/)?.[1] ?? "").split(".").slice(-2, -1)[0] ?? "";
  return [name, domain, e.subject].filter(Boolean);
}

/** Which tracked job an email is about, and what it means. Rejections are read before invitations, since "next steps" appears in both. */
export function classifyEmail(e: Email, tracked: StoredJob[]): Classified {
  const text = `${e.subject}\n${e.snippet ?? ""}`;
  const names = senderNames(e);
  const matches = tracked.filter((j) => names.some((n) => sameCompany(j.company, n) || n.toLowerCase().includes(j.company.toLowerCase())));
  // Prefer the job whose title the email names, when one company has several.
  const job = matches.find((j) => text.toLowerCase().includes(j.title.toLowerCase())) ?? matches[0] ?? null;
  if (!job) return { email: e, job: null, status: null, label: "not about a job you applied to" };
  if (OFFER.test(text)) return { email: e, job, status: "offer", label: "an offer" };
  if (REJECTED.test(text)) return { email: e, job, status: "rejected", label: "a rejection" };
  if (INTERVIEW.test(text)) return { email: e, job, status: "interview", label: "an interview or assessment" };
  if (RECEIVED.test(text)) return { email: e, job, status: null, label: "a receipt (no change)" };
  return { email: e, job, status: "replied", label: "a reply" };
}

const RANK: Record<string, number> = { applied: 0, replied: 1, rejected: 2, interview: 3, offer: 4 };

/** Whether moving a job to `next` is progress: news never goes backwards, though a rejection can follow an interview. */
export function isProgress(current: Status, next: Status): boolean {
  if (!(current in RANK) || !(next in RANK)) return false;
  if (next === "rejected") return current !== "offer" && current !== "rejected";
  return RANK[next]! > RANK[current]!;
}
