import { formatIsoDate, type DocumentType } from "@/lib/clinical/logic";

/**
 * Template engine for clinical documents.
 *
 * A template is plain text with whitelisted {{namespace.field}} placeholders. It carries wording and
 * layout only — never a signature, never clinical values. There is no HTML, no scripting and no
 * expression language: markup characters are rejected, unknown placeholders are rejected, and every
 * substituted value is sanitised. The output is the exact text that gets hashed, shown to the
 * practitioner, and printed to the PDF.
 *
 * The allowed-key list and the structural rules mirror `_template_validate` in the database; the
 * database is the enforcement point, this module gives immediate, friendly feedback and does the
 * rendering.
 */

export const ALLOWED_PLACEHOLDERS = [
  "doctor.title",
  "doctor.full_name",
  "doctor.hpcsa_number",
  "doctor.practice_number",
  "doctor.qualification",
  "doctor.speciality",
  "doctor.practice_name",
  "doctor.practice_address",
  "doctor.practice_phone",
  "doctor.practice_email",
  "member.full_name",
  "member.member_id",
  "member.date_of_birth",
  "document.issue_date",
  "document.expiry_date",
  "document.document_id",
  "prescription.medicine_name",
  "prescription.generic_name",
  "prescription.dosage_form",
  "prescription.strength",
  "prescription.quantity_numeric",
  "prescription.quantity_words",
  "prescription.directions",
  "prescription.route",
  "prescription.frequency",
  "prescription.duration",
  "prescription.repeats",
  "prescription.indication",
  "prescription.special_instructions",
  "clinical.statement",
  "clinical.indication_summary",
  "clinical.treatment_summary",
] as const;

export type PlaceholderKey = (typeof ALLOWED_PLACEHOLDERS)[number];
const ALLOWED = new Set<string>(ALLOWED_PLACEHOLDERS);

/** Prescription fields that must always appear in a prescription template. */
const RX_REQUIRED = [
  "medicine_name",
  "dosage_form",
  "strength",
  "quantity_numeric",
  "quantity_words",
  "directions",
  "route",
  "frequency",
  "duration",
  "repeats",
  "indication",
];

export type TemplateSchema = {
  placeholders: {
    key: string;
    required?: boolean | undefined;
    clinical?: boolean | undefined;
    label?: string | undefined;
  }[];
};

/** One namespace of values (doctor, member, document, prescription, clinical). Plain, serialisable values only. */
export type ValueBag = Record<string, string | number | boolean | null | undefined>;

export type RenderData = {
  doctor?: ValueBag | undefined;
  member?: ValueBag | undefined;
  document?: ValueBag | undefined;
  prescription?: ValueBag | undefined;
  clinical?: ValueBag | undefined;
};

export class TemplateError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [message],
  ) {
    super(message);
    this.name = "TemplateError";
  }
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MARKUP = /[<>]/;

/** Placeholder keys in the order they first appear (trimmed, not validated). */
export function extractPlaceholders(content: string): string[] {
  const seen: string[] = [];
  for (const m of content.matchAll(PLACEHOLDER)) {
    const key = m[1]!.trim();
    if (!seen.includes(key)) seen.push(key);
  }
  return seen;
}

/** Structural validation. Returns a list of problems; empty means the template is well formed. */
export function validateTemplate(
  type: DocumentType,
  content: string,
  schema: TemplateSchema,
): string[] {
  const problems: string[] = [];
  if (content.length < 20 || content.length > 20000)
    problems.push("Content must be 20–20 000 characters");
  if (MARKUP.test(content) || CONTROL.test(content))
    problems.push("Markup and control characters are not allowed in templates");
  const keys = extractPlaceholders(content);
  for (const k of keys) if (!ALLOWED.has(k)) problems.push(`Unknown placeholder {{${k}}}`);
  if (/[{}]/.test(content.replace(PLACEHOLDER, ""))) problems.push("Unbalanced braces");

  const entries = Array.isArray(schema?.placeholders) ? schema.placeholders : null;
  if (!entries) {
    problems.push('template_schema must be {"placeholders": [...]}');
  } else {
    const schemaKeys = new Set(entries.map((e) => e.key));
    for (const e of entries) {
      if (!ALLOWED.has(e.key)) problems.push("The schema names an unknown placeholder");
      const clinicalRequired =
        e.key.startsWith("clinical.") ||
        (e.key.startsWith("prescription.") &&
          RX_REQUIRED.includes(e.key.slice("prescription.".length)));
      if (clinicalRequired && e.required !== true)
        problems.push(`Clinical placeholder ${e.key} must be marked required`);
    }
    for (const k of keys)
      if (!schemaKeys.has(k)) problems.push(`{{${k}}} is missing from the schema`);
  }

  if (type === "MEDICAL_LETTER") {
    if (keys.some((k) => k.startsWith("prescription.")))
      problems.push("A medical letter cannot contain prescription fields");
    if (!keys.some((k) => k.startsWith("clinical.")))
      problems.push(
        "A medical letter needs at least one practitioner-entered {{clinical.*}} field",
      );
  } else {
    if (keys.some((k) => k.startsWith("clinical.")))
      problems.push("A prescription cannot contain clinical.* letter fields");
    for (const f of RX_REQUIRED)
      if (!keys.includes(`prescription.${f}`))
        problems.push(`A prescription template must contain {{prescription.${f}}}`);
    if (!keys.includes("document.expiry_date"))
      problems.push("A prescription template must contain {{document.expiry_date}}");
  }
  for (const must of [
    "doctor.full_name",
    "doctor.hpcsa_number",
    "document.document_id",
    "member.full_name",
  ])
    if (!keys.includes(must)) problems.push(`Templates must contain {{${must}}}`);
  return problems;
}

const DATE_KEYS = new Set(["document.issue_date", "document.expiry_date", "member.date_of_birth"]);
const MULTILINE_KEYS = new Set([
  "clinical.statement",
  "clinical.indication_summary",
  "clinical.treatment_summary",
  "prescription.directions",
  "prescription.special_instructions",
]);

/**
 * Normalises one substituted value. Throws on markup (the database already refuses it; this is the second
 * line of defence). Control characters are removed, whitespace is collapsed, and only the designated
 * free-text fields may span lines.
 */
export function sanitiseValue(key: string, raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  let text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : "";
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  text = text.normalize("NFC").replace(/\r\n?/g, "\n");
  if (MARKUP.test(text))
    throw new TemplateError(`The value for ${key} contains markup, which is not allowed`);
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "");
  if (MULTILINE_KEYS.has(key)) {
    text = text
      .split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } else {
    text = text.replace(/\s+/g, " ").trim();
  }
  if (DATE_KEYS.has(key)) return formatIsoDate(text) ?? text;
  return text.slice(0, 4000);
}

function lookup(data: RenderData, key: string): unknown {
  const [ns, field] = key.split(".") as [keyof RenderData, string];
  const bag = data[ns];
  return bag ? bag[field] : undefined;
}

/**
 * Renders a template to the final text. Missing REQUIRED values are an error (listing every one). A line
 * whose placeholders were all optional and empty is dropped, so labels never dangle.
 */
export function renderTemplate(content: string, schema: TemplateSchema, data: RenderData): string {
  const problems = validateTemplateShape(content);
  if (problems.length) throw new TemplateError("The template is not valid", problems);
  const required = new Set(schema.placeholders.filter((p) => p.required).map((p) => p.key));
  const missing: string[] = [];

  const out: string[] = [];
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    let hadPlaceholder = false;
    let anyValue = false;
    const rendered = line.replace(PLACEHOLDER, (_m, rawKey: string) => {
      const key = rawKey.trim();
      hadPlaceholder = true;
      const value = sanitiseValue(key, lookup(data, key));
      if (value === "") {
        if (required.has(key) && !missing.includes(key)) missing.push(key);
        return "";
      }
      anyValue = true;
      return value;
    });
    // Only a label remains (every placeholder on the line was empty): omit the line. A required value that
    // is missing is still reported below.
    if (hadPlaceholder && !anyValue) continue;
    out.push(rendered.replace(/[ \t]+$/g, ""));
  }
  if (missing.length)
    throw new TemplateError(
      `Missing required value${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
      missing.map((k) => `Missing ${k}`),
    );
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Shape checks needed to render safely (the full validation runs when a template is saved). */
function validateTemplateShape(content: string): string[] {
  const problems: string[] = [];
  if (MARKUP.test(content) || CONTROL.test(content))
    problems.push("Markup and control characters are not allowed");
  for (const k of extractPlaceholders(content))
    if (!ALLOWED.has(k)) problems.push(`Unknown placeholder {{${k}}}`);
  if (/[{}]/.test(content.replace(PLACEHOLDER, ""))) problems.push("Unbalanced braces");
  return problems;
}

const OPTIONAL_KEYS = new Set([
  "prescription.generic_name",
  "prescription.special_instructions",
  "doctor.qualification",
  "doctor.speciality",
  "doctor.practice_number",
  "doctor.practice_name",
  "doctor.practice_address",
  "doctor.practice_phone",
  "doctor.practice_email",
  "document.expiry_date",
]);

/**
 * A schema derived from the template text: every placeholder listed, clinical ones required (the database
 * insists), identity ones required, and only the genuinely optional ones (generic name, special
 * instructions, practice contact details, expiry on a letter) left optional. The expiry date of a
 * prescription is also required by the database when the document is created.
 */
export function defaultSchemaFor(type: DocumentType, content: string): TemplateSchema {
  return {
    placeholders: extractPlaceholders(content)
      .filter((k) => ALLOWED.has(k))
      .map((key) => ({
        key,
        required:
          key === "document.expiry_date" && type === "PRESCRIPTION_ORDER"
            ? true
            : !OPTIONAL_KEYS.has(key),
        clinical: key.startsWith("clinical.") || key.startsWith("prescription."),
      })),
  };
}
