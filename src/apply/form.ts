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
    const required = input.required || el.getAttribute("aria-required") === "true" || starred(own);

    if (type === "radio" || type === "checkbox") {
      const key = `${type}:${name || el.id}`;
      const members = name ? [...document.querySelectorAll<HTMLInputElement>(`input[type=${type}][name="${CSS.escape(name)}"]`)] : [input];
      let group = name ? groups.get(key) : undefined;
      if (!group) {
        const id = `f${n++}`;
        const optionLabels = members.map((m) => ownLabel(m));
        const context = contextOf(el, optionLabels, members.length);
        let question = context;
        for (const o of optionLabels) if (o) question = question.split(o).join(" ");
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
    const context = contextOf(el, [own]);
    const label = own && !PLACEHOLDER.test(own.trim()) ? own : context;
    fields.push({ id, kind, label: clean(label), context: clean(context), required: required || starred(context.split("\n")[0] ?? ""), options, value, hint: el.id || input.name || "" });
  }

  const buttons = [...document.querySelectorAll<HTMLElement>("button, input[type=submit]")].filter(visible);
  const submitEl =
    buttons.find((b) => /submit|send application|apply/i.test(text(b) || (b as HTMLInputElement).value || "")) ??
    buttons.find((b) => (b as HTMLButtonElement).type === "submit");
  if (submitEl) submitEl.setAttribute("data-ja-submit", "1");

  return {
    url: location.href,
    title: document.title,
    fields,
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
