/**
 * People you know at a company, from your LinkedIn connections export
 * (LinkedIn: Settings > Data privacy > Get a copy of your data > Connections),
 * saved as data/connections.csv. Nothing is sent anywhere; a drafted message is
 * yours to send.
 */
import { readFileSync } from "node:fs";
import { parseCsv } from "./sources/csv.js";

export type Connection = { name: string; company: string; position: string; url: string };

/** Reads the export, skipping the notes LinkedIn puts above the header row. */
export function parseConnections(text: string): Connection[] {
  const rows = parseCsv(text);
  const head = rows.findIndex((r) => r.some((c) => /^first name$/i.test(c.trim())) && r.some((c) => /^company$/i.test(c.trim())));
  if (head < 0) return [];
  const cols = rows[head]!.map((c) => c.trim().toLowerCase());
  const get = (r: string[], name: string) => (r[cols.indexOf(name)] ?? "").trim();
  return rows
    .slice(head + 1)
    .map((r) => ({
      name: `${get(r, "first name")} ${get(r, "last name")}`.trim(),
      company: get(r, "company"),
      position: get(r, "position"),
      url: get(r, "url"),
    }))
    .filter((c) => c.name && c.company);
}

export function loadConnections(file: string): Connection[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`No connections file at ${file}. Export your connections from LinkedIn and save Connections.csv there.`);
  }
  return parseConnections(text);
}

const NOISE = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|group|holdings|technologies|technology|the)\b\.?/g;
const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(NOISE, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
const initials = (s: string) =>
  tokens(s)
    .filter((t) => !["of", "and", "for"].includes(t))
    .map((t) => t[0])
    .join("");

/**
 * Whether a connection's company is the job's company: the same words, one
 * name inside the other ("Shopify" and "Shopify Canada"), or an acronym
 * ("RBC" and "Royal Bank of Canada"). Pure, so it is tested offline.
 */
export function sameCompany(a: string, b: string): boolean {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const longText = ` ${long.join(" ")} `;
  if (longText.includes(` ${short.join(" ")} `)) return true;
  const acronym = (one: string[], other: string) => one.length === 1 && one[0]!.length >= 2 && one[0] === initials(other);
  return acronym(x, b) || acronym(y, a);
}

export function referralsFor(company: string, connections: Connection[]): Connection[] {
  return connections.filter((c) => sameCompany(company, c.company));
}
