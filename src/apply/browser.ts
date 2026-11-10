/**
 * The browser side of `apply`: a visible Chrome window with its own profile
 * (apart from your everyday browser), opening forms, filling them, reading
 * every value back, and sending only when told to. It does nothing to hide
 * that it is automated, and it never answers a CAPTCHA or a code.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import { dumpForm, readValues, type FormDump, type FormField } from "./form.js";
import { matchOption, type FieldPlan } from "./map.js";

export type Session = { context: BrowserContext; close: () => Promise<void> };

export async function openSession(profileDir: string, opts: { headless: boolean }): Promise<Session> {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: opts.headless,
    viewport: opts.headless ? { width: 1280, height: 900 } : null,
    args: opts.headless ? [] : ["--start-maximized"],
  });
  // tsx names nested functions with a helper the page does not have.
  await context.addInitScript("globalThis.__name = globalThis.__name || ((f) => f)");
  return { context, close: () => context.close() };
}

/** Opens a form and reads it, with each dropdown's options. */
export async function openForm(session: Session, url: string): Promise<{ page: Page; dump: FormDump }> {
  const page = await session.context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");
  const dump = await page.evaluate(dumpForm);
  for (const field of dump.fields) {
    if (field.kind === "combobox" && field.options.length === 0) field.options = await comboOptions(page, field);
  }
  return { page, dump };
}

const at = (page: Page, field: FormField): Locator => page.locator(`[data-ja="${field.id}"]`).first();

/** Opens a dropdown to read its options, then closes it. Type-ahead boxes have none until you type. */
async function comboOptions(page: Page, field: FormField): Promise<string[]> {
  const box = at(page, field);
  try {
    await box.click({ timeout: 5_000 });
    await page.waitForTimeout(400);
    const options = await page.locator("[role=option]:visible").allInnerTexts();
    await page.keyboard.press("Escape");
    return [...new Set(options.map((o) => o.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 300);
  } catch {
    return [];
  }
}

const REGION_CODES: Record<string, string> = {
  ontario: "on", quebec: "qc", "british columbia": "bc", alberta: "ab", manitoba: "mb", saskatchewan: "sk",
  "nova scotia": "ns", "new brunswick": "nb", "newfoundland and labrador": "nl", "prince edward island": "pe",
  canada: "can", "united states": "usa",
};

/**
 * The suggestion that best fits a place like "London, Ontario, Canada": it must
 * name the city, and the more of the region and country it names (in full or
 * as a code, "ON", "CAN"), the better. Pure, so it is tested offline.
 */
export function bestSuggestion(value: string, texts: string[]): string | null {
  const exact = matchOption(value, texts);
  if (exact) return exact;
  const parts = value.toLowerCase().split(",").map((p) => p.trim()).filter(Boolean);
  const city = parts[0];
  if (!city) return null;
  const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  let best: { text: string; score: number } | null = null;
  for (const text of texts) {
    if (!text.toLowerCase().includes(city)) continue;
    const w = words(text);
    let score = 0;
    for (const p of parts.slice(1)) if (text.toLowerCase().includes(p) || (REGION_CODES[p] && w.has(REGION_CODES[p]!))) score++;
    if (!best || score > best.score) best = { text, score };
  }
  // "Guelph, Ontario, Canada" must not become Guelph, California: with a region or country named,
  // a suggestion that matches neither is not the place.
  if (best && parts.length > 1 && best.score === 0) return null;
  return best?.text ?? null;
}

const SUGGESTIONS = "[role=option]:visible, .dropdown-results > :visible, .dropdown-results li:visible, [class*=suggestion]:visible";

/** Whether `shows` is the place `value`: its city, and (when `value` names one) its region or country, in full or as a code. */
export function samePlace(shows: string, value: string): boolean {
  const parts = value.toLowerCase().split(",").map((p) => p.trim()).filter(Boolean);
  const s = shows.toLowerCase();
  if (!parts[0] || !s.includes(parts[0])) return false;
  if (parts.length === 1) return true;
  const w = new Set(s.split(/[^a-z0-9]+/).filter(Boolean));
  return parts.slice(1).some((p) => s.includes(p) || (REGION_CODES[p] !== undefined && w.has(REGION_CODES[p]!)));
}

/**
 * Waits until the page's field values stop changing: at least 4 seconds, then once they have been the same
 * for two looks in a row, and never more than 15 seconds.
 */
export async function settle(page: Page): Promise<void> {
  const started = Date.now();
  let before = "";
  let steady = 0;
  while (Date.now() - started < 15_000) {
    await page.waitForTimeout(1_500);
    const now = JSON.stringify(await page.evaluate(readValues).catch(() => ({})));
    steady = now === before ? steady + 1 : 0;
    before = now;
    if (steady >= 2 && Date.now() - started >= 4_000) return;
  }
}

/** A box for where you live, which boards fill from a list of places. */
export function isLocationField(f: FormField): boolean {
  return f.kind === "text" && /location|city|where (do )?you (live|reside)/i.test(`${f.label} ${f.hint}`) && !/work.*location|preferred|willing|relocat/i.test(f.label);
}

/** Chooses `value` in an open list of options; the option clicked, or null. */
async function pickOption(page: Page, value: string): Promise<string | null> {
  const options = page.locator(SUGGESTIONS);
  const texts = (await options.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  if (!texts.length) return null;
  const best = bestSuggestion(value, texts);
  if (!best) return null;
  await options.nth(texts.indexOf(best)).click({ timeout: 5_000 });
  return best;
}

/** Fills one field; returns the option clicked, for a dropdown or a suggestion box. */
/** The files a form may get: the resume, and a cover letter when one was written. Each goes up under its own name. */
export type Uploads = { resume: { path: string; name: string }; cover?: { path: string; name: string } };

async function fillOne(page: Page, plan: FieldPlan, uploads: Uploads): Promise<string | null> {
  const { field, values } = plan;
  if (!values.length) return null;
  const box = at(page, field);
  const value = values[0]!;
  switch (field.kind) {
    case "file":
    {
      // Employers see the uploaded file's name, so it goes up as e.g. First_Last_Resume.pdf whatever it is called on disk.
      const file = value === "cover_letter" ? uploads.cover : uploads.resume;
      if (!file) throw new Error("no cover letter to attach");
      await box.setInputFiles({ name: file.name, mimeType: "application/pdf", buffer: readFileSync(path.resolve(file.path)) });
      await page.waitForTimeout(1_500);
      return null;
    }
    case "select":
      await box.selectOption({ label: value });
      return null;
    case "combobox": {
      await box.click();
      await box.fill(value.slice(0, 40));
      await page.waitForTimeout(700);
      const picked = await pickOption(page, value);
      if (!picked) await page.keyboard.press("Enter");
      return picked;
    }
    case "buttons": {
      // A row of buttons is one question: press the one that was chosen.
      const i = field.options.indexOf(value);
      if (i < 0) throw new Error(`no button "${value}"`);
      const button = page.locator(`[data-ja="${field.id}"][data-ja-opt="${i}"]`).first();
      if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
      return null;
    }
    case "radio":
    case "checkboxes":
    case "checkbox": {
      for (const [i, option] of field.options.entries()) {
        const want = field.kind === "checkbox" ? values[0] === "checked" : values.includes(option);
        const input = page.locator(`[data-ja="${field.id}"][data-ja-opt="${i}"]`).first();
        if ((await input.isChecked()) === want) continue;
        // Boards often hide the real box and draw their own; clicking its label works for both.
        await input.click({ force: true }).catch(async () => {
          await page.locator(`label:has([data-ja="${field.id}"][data-ja-opt="${i}"])`).first().click();
        });
      }
      return null;
    }
    default: {
      await box.click();
      // A location box suggests places as you type: type the city like a person would, then take the match.
      if (isLocationField(field)) {
        // Each candidate place in turn (your city, then nearby places from your profile) until the page's own list has it.
        for (const place of values) {
          await box.fill("");
          await box.pressSequentially(place.split(",")[0]!.trim(), { delay: 50 });
          // The list of places arrives when it arrives; picking from it is what makes the box keep the value.
          await page.locator(SUGGESTIONS).first().waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(300);
          // No list of places at all means this is an ordinary text box ("city and province you will work in").
          if ((await page.locator(SUGGESTIONS).count()) === 0) {
            await box.fill(values[0]!);
            return null;
          }
          const picked = await pickOption(page, place).catch(() => null);
          if (picked) return picked;
        }
        // No list offered a place that matches: leave the box empty rather than a wrong city.
        await box.fill("");
        return null;
      }
      await box.fill(value);
      return null;
    }
  }
}

export type FieldResult = { label: string; kind: string; required: boolean; wanted: string; shows: string; ok: boolean };

const digits = (s: string) => s.replace(/\D/g, "");

/**
 * Whether what the page shows is what was wanted. `picked` is the option that
 * was clicked: a dropdown that shows only part of it (a flag and "+1" for
 * "Canada +1") counts when that part comes from the exact option wanted.
 */
export function sameValue(plan: FieldPlan, shows: string, picked: string | null = null): boolean {
  const { field, values } = plan;
  if (!values.length) return true;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  if (field.kind === "file") return shows !== "" && shows !== "0";
  if (field.kind === "checkbox") return (values[0] === "checked") === (shows !== "");
  if (field.kind === "tel" || /phone/i.test(field.label)) return digits(shows).endsWith(digits(values[0]!).slice(-10));
  if (field.kind === "checkboxes") return values.every((v) => norm(shows).includes(norm(v)));
  if (field.kind === "combobox" || isLocationField(field)) {
    if (!shows) return false;
    // A place from your list of candidates, as the page shows it: the right city in the right region or country.
    if (values.some((v) => samePlace(shows, v))) return true;
    // Only part of the choice is shown: trust it only for the exact option that was clicked.
    return picked !== null && norm(picked) === norm(values[0]!) && norm(picked).includes(norm(shows));
  }
  return norm(shows) === norm(values[0]!);
}

/** Fills every planned field, then reads the page back. A value that did not stick is tried once more. */
export async function fillForm(page: Page, plans: FieldPlan[], uploads: Uploads): Promise<FieldResult[]> {
  const errors = new Map<string, string>();
  const picked = new Map<string, string | null>();
  const attempt = async (plan: FieldPlan) => {
    try {
      picked.set(plan.field.id, await fillOne(page, plan, uploads));
      errors.delete(plan.field.id);
    } catch (err) {
      errors.set(plan.field.id, err instanceof Error ? err.message.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 2).join(" ") : String(err));
    }
  };
  // Files go up first. Some boards read an uploaded resume and fill the form from it a few seconds later
  // (Lever does), so the page is given time to finish before anything else is typed.
  const files = plans.filter((p) => p.field.kind === "file" && p.values.length);
  for (const plan of files) await attempt(plan);
  if (files.length) await settle(page);
  const fileNames = new Map([["resume", uploads.resume.name], ["cover_letter", uploads.cover?.name ?? ""]]);
  const read = async () => {
    const shown = await page.evaluate(readValues);
    // Some boards replace the file box with the file's name once it uploads.
    for (const plan of plans) {
      const fileName = fileNames.get(plan.values[0] ?? "");
      if (plan.field.kind === "file" && fileName && !shown[plan.field.id]) {
        if ((await page.getByText(fileName, { exact: false }).count()) > 0) shown[plan.field.id] = fileName;
      }
    }
    return shown;
  };
  // What the page already shows (its own autofill) is left alone when it is what was wanted.
  let shown = await read();
  for (const plan of plans) {
    if (plan.field.kind === "file" || !plan.values.length) continue;
    if (!sameValue(plan, shown[plan.field.id] ?? "", null)) await attempt(plan);
  }
  await page.waitForTimeout(800);
  shown = await read();
  // Pages sometimes clear or re-draw a field after it is filled. Anything that did not stick is filled
  // again, up to three rounds, with a pause for the page to settle each time.
  for (let round = 0; round < 3; round++) {
    const bad = plans.filter((plan) => !sameValue(plan, shown[plan.field.id] ?? "", picked.get(plan.field.id) ?? null));
    if (!bad.length) break;
    for (const plan of bad) {
      try {
        picked.set(plan.field.id, await fillOne(page, plan, uploads));
        errors.delete(plan.field.id);
      } catch (err) {
        errors.set(plan.field.id, err instanceof Error ? err.message.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 2).join(" ") : String(err));
      }
    }
    await page.waitForTimeout(1_000);
    shown = await read();
  }
  return plans.map((plan) => {
    const shows = shown[plan.field.id] ?? "";
    return {
      label: plan.field.label,
      kind: plan.field.kind,
      required: plan.field.required,
      wanted: plan.values.join(" || "),
      shows: errors.has(plan.field.id) && !shows ? `(could not fill: ${errors.get(plan.field.id)})` : shows,
      ok: sameValue(plan, shows, picked.get(plan.field.id) ?? null),
    };
  });
}

export type SubmitOutcome =
  | { state: "submitted"; detail: string }
  | { state: "needs_you"; detail: string }
  | { state: "rejected"; detail: string }
  | { state: "unconfirmed"; detail: string };

const CONFIRMED = /thank(s| you) for (applying|your (application|interest))|application (has been |was )?(received|submitted)|we('ve| have) received your application|successfully (submitted|applied)/i;

/** Clicks Submit and reads what the page became. Only a confirmation counts as sent. */
export async function submitForm(page: Page, submitSelector: string): Promise<SubmitOutcome> {
  const before = page.url();
  await page.locator(submitSelector).first().click({ timeout: 10_000 });
  for (let waited = 0; waited < 30_000; waited += 1_000) {
    await page.waitForTimeout(1_000);
    const body = await page.locator("body").innerText().catch(() => "");
    if (CONFIRMED.test(body) || /confirmation|thank/i.test(new URL(page.url()).pathname)) {
      return { state: "submitted", detail: body.match(CONFIRMED)?.[0] ?? page.url() };
    }
    const challenge = page.locator(
      "iframe[src*='hcaptcha.com'][src*='challenge']:visible, iframe[title*='challenge' i]:visible, iframe[src*='recaptcha'][src*='bframe']:visible",
    );
    if ((await challenge.count()) > 0 && (await challenge.first().boundingBox())?.height) {
      return { state: "needs_you", detail: "the site asked for a robot check; pass it in the window, then the form sends" };
    }
    if (/verification code|enter the code|we sent (you )?a code/i.test(body)) {
      return { state: "needs_you", detail: "the site emailed you a code; type it in the window" };
    }
    const errors = await page
      .locator("[role=alert]:visible, .error:visible, [class*=error-message]:visible, [aria-invalid=true]")
      .allInnerTexts()
      .catch(() => []);
    const said = errors.map((e) => e.trim()).filter(Boolean);
    if (said.length && waited >= 3_000 && page.url() === before) return { state: "rejected", detail: said.slice(0, 3).join("; ") };
  }
  // What the page shows after Submit says why: an error banner, a challenge, or nothing at all.
  const shown = await page.locator("body").innerText().catch(() => "");
  const said = shown.replace(/\s+/g, " ").trim().slice(0, 220);
  return { state: "unconfirmed", detail: `Submit was clicked but no confirmation appeared; check your email before trying again. The page showed: "${said}"` };
}
