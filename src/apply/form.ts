/**
 * What a form asks, read from the page itself. `dumpForm` runs inside the page:
 * it finds every control a person could answer, names it by its label and the
 * question text around it, and tags it with `data-ja="fN"` so the runner can
 * find it again. Radio buttons and checkboxes that share a name are one field.
 */

export type FieldKind =
  | "text"
  | "email"
  | "tel"
  | "url"
  | "number"
  | "date"
  | "textarea"
  | "select"
  | "combobox"
  | "radio"
  /** Yes/No (or similar) drawn as a row of buttons, as Ashby does. */
  | "buttons"
  | "checkbox"
  | "checkboxes"
  | "file";

export type FormField = {
  id: string;
  kind: FieldKind;
  /** The control's own label. */
  label: string;
  /** The question text around it, for when the label alone is unclear. */
  context: string;
  required: boolean;
  /** Choices, for select, combobox, radio and checkboxes. */
  options: string[];
  /** What the page shows now. */
  value: string;
  /** The control's own id or name, which often says what it is ("resume", "cover_letter"). */
  hint: string;
};

export type FormDump = {
  url: string;
  title: string;
  fields: FormField[];
  /** Whether the page shows a password box: a sign-in wall. */
  hasPassword: boolean;
  /** A selector for the button that sends the form, if one is found. */
  submit: string | null;
  /** Questions marked required that the reader found no control for. A form with any is not sent. */
  unread: string[];
};

/**
 * Runs in the page. Self-contained on purpose: Playwright sends its source to
 * the browser, so it may use nothing from outside.
 */
export function dumpForm(): FormDump {
  const SKIP_NAMES = /^(g-recaptcha-response|h-captcha-response|cf-turnstile-response)$/i;
  const text = (el: Element | null | undefined): string =>
    ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0;
  };
  const clean = (s: string): string => s.replace(/\s+/g, " ").replace(/\s*[*✱]+\s*$/, "").trim().slice(0, 300);
  const starred = (s: string): boolean => /[*✱]\s*$/.test(s.trim()) || /\(required\)/i.test(s);

  function ownLabel(el: Element): string {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      const t = text(labels[0]);
      if (t) return t;
    }
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => text(document.getElementById(id)))
        .join(" ")
        .trim();
      if (t) return t;
    }
    return el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
  }

  const PLACEHOLDER = /^(start typing\.*|select\.*|search\.*|attach|choose|upload file|type here\.*)$/i;
  /**
   * The text of the smallest container around `el` that says something beyond
   * `known` (its own label, or a group's option labels): the question.
   */
  function contextOf(el: Element, known: string[], groupSize = 1): string {
    const strip = (t: string): string => {
      let rest = t;
      for (const k of known) if (k) rest = rest.split(k).join(" ");
      return rest.replace(/\b(select|start typing|attach|upload file|or drag and drop here)\.*/gi, " ").replace(/[\s*✱.]+/g, " ").trim();
    };
    let node = el.parentElement;
    for (let i = 0; node && i < 8; i++, node = node.parentElement) {
      if (node.tagName === "FORM" || node === document.body) break;
      const controls = node.querySelectorAll("input:not([type=hidden]), select, textarea").length;
      // Stop before taking in a neighbouring question.
      if (controls > groupSize + 2) break;
      const t = text(node);
      if (strip(t).length > 3) return t.slice(0, 400);
    }
    return known.join(" ");
  }

  const fields: FormField[] = [];
  const groups = new Map<string, FormField>();
  let n = 0;

  /** Ashby wraps each question in data-field-path, with the question as its first label. */
  const entryLabel = (entry: Element): string => clean(text(entry.querySelector("label")));
  /** Ashby marks a required question with a "_required" class on its label rather than an attribute. */
  const entryRequired = (el: Element): boolean => {
    const label = el.closest("[data-field-path]")?.querySelector("label");
    return !!label && [...label.classList].some((c) => /required/i.test(c));
  };

  // Yes/No drawn as buttons: one question, its buttons are the options.
  for (const entry of document.querySelectorAll("[data-field-path]")) {
    const buttons = [...entry.querySelectorAll<HTMLElement>("button[data-option]")].filter(visible);
    if (buttons.length < 2) continue;
    const id = `f${n++}`;
    buttons.forEach((b, i) => {
      b.setAttribute("data-ja", id);
      b.setAttribute("data-ja-opt", String(i));
    });
    fields.push({
      id,
      kind: "buttons",
      label: entryLabel(entry),
      context: clean(text(entry)),
      required: entryRequired(buttons[0]!),
      options: buttons.map((b) => clean(text(b))),
      value: buttons.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => clean(text(b))).join(" || "),
      hint: entry.getAttribute("data-field-path") ?? "",
    });
  }
  const controls = document.querySelectorAll<HTMLElement>("input, select, textarea");
  for (const el of controls) {
    const input = el as HTMLInputElement;
    const type = (input.type || "").toLowerCase();
    const name = input.name || "";
    if (type === "hidden" || type === "submit" || type === "button" || type === "image" || type === "reset") continue;
    if (SKIP_NAMES.test(name) || type === "search") continue;
    // The country picker inside a phone box is not a question.
    if (el.closest(".iti__dropdown-content, .iti__country-list, [aria-hidden=true]") && type !== "file") continue;
    const isFile = type === "file";
    if (!isFile && !visible(el)) continue;
    // Helper inputs a widget keeps for the browser's own required check.
    if (!isFile && el.tabIndex === -1 && !el.id && !ownLabel(el)) continue;

    const own = ownLabel(el);
    const required = input.required || el.getAttribute("aria-required") === "true" || starred(own) || entryRequired(el);

    if (type === "radio" || type === "checkbox") {
      // A checklist whose boxes each have their own name is still one question: its wrapper says so.
      const entry = type === "checkbox" ? el.closest("[data-field-path]") : null;
      const entryBoxes = entry ? [...entry.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].filter(visible) : [];
      const asChecklist = entryBoxes.length > 1;
      const key = asChecklist ? `entry:${entry!.getAttribute("data-field-path")}` : `${type}:${name || el.id}`;
      const members = asChecklist ? entryBoxes : name ? [...document.querySelectorAll<HTMLInputElement>(`input[type=${type}][name="${CSS.escape(name)}"]`)] : [input];
      let group = name || asChecklist ? groups.get(key) : undefined;
      if (!group) {
        const id = `f${n++}`;
        const optionLabels = members.map((m) => ownLabel(m));
        const context = contextOf(el, optionLabels, members.length);
        let question = asChecklist ? entryLabel(entry!) : context;
        if (!asChecklist) for (const o of optionLabels) if (o) question = question.split(o).join(" ");
        group = {
          id,
          kind: type === "radio" ? "radio" : members.length > 1 ? "checkboxes" : "checkbox",
          label: clean(members.length > 1 ? question.trim() || context : own || context),
          context: clean(context),
          required,
          options: [],
          value: "",
          hint: name,
        };
        groups.set(key, group);
        fields.push(group);
      }
      el.setAttribute("data-ja", group.id);
      el.setAttribute("data-ja-opt", String(group.options.length));
      group.options.push(clean(own) || `option ${group.options.length + 1}`);
      if (input.checked) group.value = group.value ? `${group.value} || ${clean(own)}` : clean(own);
      group.required ||= required;
      continue;
    }

    const id = `f${n++}`;
    el.setAttribute("data-ja", id);
    const isCombo = el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list";
    let kind: FieldKind;
    let options: string[] = [];
    if (el.tagName === "SELECT") {
      kind = "select";
      options = [...(el as HTMLSelectElement).options].map((o) => o.text.trim()).filter((t) => t && !/^(select|choose|--)/i.test(t));
    } else if (el.tagName === "TEXTAREA") kind = "textarea";
    else if (isFile) kind = "file";
    else if (isCombo) kind = "combobox";
    else if (["email", "tel", "url", "number", "date"].includes(type)) kind = type as FieldKind;
    else kind = "text";

    const value =
      el.tagName === "SELECT"
        ? ((el as HTMLSelectElement).selectedOptions[0]?.text ?? "")
        : isFile
          ? String(input.files?.length ?? 0)
          : input.value;
    // A dropdown's own label can be just its choices ("Select... Yes No"); the question is around it.
    const optionNoise = (t: string): string => [...options].reduce((s, o) => s.split(o).join(" "), t).replace(/select\.*|choose\.*|--/gi, " ").replace(/[\s*✱.]+/g, " ").trim();
    const ownIsChoices = kind === "select" && optionNoise(own).length < 3;
    const context = contextOf(el, ownIsChoices ? [own, ...options] : [own]);
    // The question without the choices drawn under it ("Are you based in Canada? Select... Yes No").
    const withoutChoices = (t: string): string =>
      [...options].reduce((s, o) => s.replace(new RegExp(`(?<![A-Za-z0-9])${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "g"), " "), t).replace(/select\.{2,3}|choose\.{2,3}/gi, " ");
    const label = own && !PLACEHOLDER.test(own.trim()) && !ownIsChoices ? own : ownIsChoices ? withoutChoices(context) : context;
    fields.push({ id, kind, label: clean(label), context: clean(context), required: required || starred(context.split("\n")[0] ?? ""), options, value, hint: el.id || input.name || "" });
  }

  // Keep the questions in the order they appear on the page.
  fields.sort((a, b) => {
    const x = document.querySelector(`[data-ja="${a.id}"]`);
    const y = document.querySelector(`[data-ja="${b.id}"]`);
    return x && y && x !== y ? (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1) : 0;
  });

  const buttons = [...document.querySelectorAll<HTMLElement>("button, input[type=submit]")].filter(visible);
  const words = (b: HTMLElement): string => (text(b) || (b as HTMLInputElement).value || "").trim();
  // Never a button that logs in with another site, fills the form from a profile, or dismisses a banner.
  const usable = buttons.filter((b) => !/linkedin|indeed|apply with|autofill|dismiss|cancel|close|back/i.test(words(b)));
  const submitEl =
    usable.find((b) => /^(submit|send)( my)?( application)?$/i.test(words(b)) || /submit application|send application/i.test(words(b))) ??
    usable.find((b) => /submit/i.test(words(b))) ??
    usable.find((b) => (b as HTMLButtonElement).type === "submit") ??
    usable.find((b) => /apply/i.test(words(b)));
  if (submitEl) submitEl.setAttribute("data-ja-submit", "1");

  const unread = [...document.querySelectorAll("[data-field-path]")]
    .filter((e) => entryRequired(e) && !e.querySelector("[data-ja]") && visible(e))
    .map((e) => entryLabel(e))
    .filter(Boolean);
  return {
    url: location.href,
    title: document.title,
    fields,
    unread,
    hasPassword: [...document.querySelectorAll("input[type=password]")].some(visible),
    submit: submitEl ? "[data-ja-submit='1']" : null,
  };
}

/** Runs in the page: what each tagged field shows now, by field id. */
export function readValues(): Record<string, string> {
  const out: Record<string, string> = {};
  const text = (el: Element | null | undefined): string =>
    ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? "").replace(/\s+/g, " ").trim();
  for (const el of document.querySelectorAll<HTMLElement>("[data-ja]")) {
    const id = el.getAttribute("data-ja")!;
    const input = el as HTMLInputElement;
    const type = (input.type || "").toLowerCase();
    if (el.tagName === "BUTTON") {
      if (el.getAttribute("aria-pressed") === "true") out[id] = out[id] ? `${out[id]} || ${text(el)}` : text(el);
      else out[id] ??= "";
      continue;
    }
    if (type === "radio" || type === "checkbox") {
      if (input.checked) {
        const label = text(input.labels?.[0]) || input.getAttribute("aria-label") || "on";
        out[id] = out[id] ? `${out[id]} || ${label}` : label;
      } else out[id] ??= "";
      continue;
    }
    if (el.tagName === "SELECT") {
      out[id] = (el as HTMLSelectElement).selectedOptions[0]?.text.trim() ?? "";
      continue;
    }
    if (type === "file") {
      const box = el.closest("div, fieldset")?.parentElement;
      // Boards show the attached file's name next to the box.
      out[id] = input.files?.length ? input.files[0]!.name : /\.pdf\b/i.test(text(box)) ? (text(box).match(/[\w .()-]+\.pdf/i)?.[0] ?? "attached") : "";
      continue;
    }
    if (el.getAttribute("role") === "combobox") {
      // React-select and similar show the choice in a sibling, not in the input.
      const control = el.closest("[class*=control], [class*=Control]") ?? el.closest("[class*=container], [class*=Container]")?.parentElement;
      const single = control?.querySelector("[class*=single-value], [class*=singleValue], [class*=SingleValue]");
      const multi = control ? [...control.querySelectorAll("[class*=multi-value__label], [class*=multiValue] [class*=label]")].map(text) : [];
      out[id] = single ? text(single) : multi.length ? multi.join(" || ") : input.value;
      continue;
    }
    out[id] = input.value ?? "";
  }
  return out;
}
