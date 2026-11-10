/** What every source shares: the company list entry and small parsing helpers. */
import { z } from "zod";
import { LEVELS, type Profile } from "../profile/schema.js";

export const BOARD_SOURCES = ["greenhouse", "lever", "ashby", "github", "workday"] as const;

export const CompanySchema = z.object({
  source: z.enum(BOARD_SOURCES),
  /**
   * Which board to read. Greenhouse, Lever, Ashby: the company's name in the
   * board's URL. GitHub: "owner/repo". Workday: the careers site URL.
   */
  slug: z.string().min(1),
  name: z.string().min(1),
  /** The level of this board's jobs when a title states none, e.g. "new_grad" for a new-grad list. */
  level: z.enum(LEVELS).optional(),
});
export type Company = z.infer<typeof CompanySchema>;

/** What a source can use while fetching: your profile lets it skip postings you would never see. */
export type FetchContext = { fetchFn: typeof fetch; profile?: Profile };

export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const isRemoteText = (s: string): boolean => /\bremote\b/i.test(s);
/** "Toronto, ON; Remote - Canada" and "A | B" are several places. */
export const splitPlaces = (s: string): string[] => s.split(/\s*[;|•]\s*/).map((p) => p.trim()).filter(Boolean);
export const unique = (xs: string[]): string[] => [...new Set(xs)];

export const USER_AGENT = "job-search-tool";

/** Fetches JSON, or throws an error that names the board. */
export async function getJson(
  ctx: FetchContext,
  url: string,
  label: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await ctx.fetchFn(url, {
    method: init.method ?? "GET",
    headers: { accept: "application/json", "user-agent": USER_AGENT, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
  });
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) throw new Error(`${label} returned ${res.status}`);
  return { status: res.status, body: await res.json() };
}
