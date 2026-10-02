/**
 * Pure helpers for clinical documents. No I/O and no server imports, so the server data layer, the
 * browser and the unit tests all share them.
 *
 * NOTHING here makes a clinical decision. Validation only checks that a value the practitioner typed is
 * present and well formed (for example that the quantity in words agrees with the quantity in figures).
 * It never proposes, defaults, corrects or infers a dosage, strength, quantity, route, frequency,
 * duration, repeat count, indication or any other treatment detail.
 */

export type DocumentType = "MEDICAL_LETTER" | "PRESCRIPTION_ORDER";
export type DocumentStatus =
  | "DRAFT"
  | "PENDING_DOCTOR_REVIEW"
  | "APPROVED"
  | "SIGNING"
  | "SIGNED"
  | "ISSUED"
  | "EXPIRED"
  | "REVOKED"
  | "VOID";
export type AssuranceLevel = "SIMPLE" | "ADVANCED" | "QUALIFIED";

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  MEDICAL_LETTER: "Medical letter",
  PRESCRIPTION_ORDER: "Prescription / order",
};

export const STATUS_LABELS: Record<DocumentStatus, string> = {
  DRAFT: "Draft",
  PENDING_DOCTOR_REVIEW: "Awaiting practitioner review",
  APPROVED: "Approved — awaiting signature",
  SIGNING: "Being signed",
  SIGNED: "Signed",
  ISSUED: "Issued",
  EXPIRED: "Expired",
  REVOKED: "Revoked",
  VOID: "Void",
};

export const ASSURANCE_LABELS: Record<AssuranceLevel, string> = {
  SIMPLE: "Simple electronic signature",
  ADVANCED: "Advanced electronic signature",
  QUALIFIED: "Qualified electronic signature",
};

const RANK: Record<AssuranceLevel, number> = { SIMPLE: 1, ADVANCED: 2, QUALIFIED: 3 };
export const assuranceRank = (level: AssuranceLevel) => RANK[level];
export const meetsAssurance = (have: AssuranceLevel, need: AssuranceLevel) =>
  RANK[have] >= RANK[need];

export const documentTypeLabel = (t: string) => DOCUMENT_TYPE_LABELS[t as DocumentType] ?? t;
export const statusLabel = (s: string) => STATUS_LABELS[s as DocumentStatus] ?? s;

/** Reference prefix per document type, e.g. CP-MED-2026-000184. Display only; the database assigns it. */
export const DOCUMENT_NUMBER_PATTERN = /^CP-(MED|RX)-\d{4}-\d{6}$/;

// ---------------------------------------------------------------------------
// Prescription: presence and format only
// ---------------------------------------------------------------------------

export type PrescriptionInput = {
  medicine_name?: string | null | undefined;
  generic_name?: string | null | undefined;
  dosage_form?: string | null | undefined;
  strength?: string | null | undefined;
  quantity_numeric?: number | null | undefined;
  quantity_words?: string | null | undefined;
  directions?: string | null | undefined;
  route?: string | null | undefined;
  frequency?: string | null | undefined;
  duration?: string | null | undefined;
  repeats?: number | null | undefined;
  indication?: string | null | undefined;
  special_instructions?: string | null | undefined;
};

/** Every one of these must be entered by the practitioner. Generic name and special instructions are optional. */
export const PRESCRIPTION_REQUIRED_FIELDS = [
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
] as const satisfies readonly (keyof PrescriptionInput)[];

export const PRESCRIPTION_FIELD_LABELS: Record<keyof PrescriptionInput, string> = {
  medicine_name: "Medicine name",
  generic_name: "Generic name",
  dosage_form: "Dosage form",
  strength: "Strength",
  quantity_numeric: "Quantity (figures)",
  quantity_words: "Quantity (words)",
  directions: "Directions for use",
  route: "Route",
  frequency: "Frequency",
  duration: "Duration",
  repeats: "Repeats",
  indication: "Indication",
  special_instructions: "Special instructions",
};

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function intToWords(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? ` ${ONES[n % 10]}` : "");
  if (n < 1000)
    return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` and ${intToWords(n % 100)}` : ""}`;
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  return `${intToWords(thousands)} thousand${rest ? (rest < 100 ? " and " : " ") + intToWords(rest) : ""}`;
}

/** English words for a positive number below 100 000 with up to three decimals; null if out of range. */
export function numberToWords(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0 || value >= 100000) return null;
  const text = value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  const [whole, frac] = text.split(".") as [string, string | undefined];
  let words = intToWords(Number(whole));
  if (frac) words += ` point ${[...frac].map((d) => ONES[Number(d)]).join(" ")}`;
  return words;
}

/** Lower-case, drop punctuation, hyphens and the filler "and", so "Twenty-eight" equals "twenty eight". */
export const normaliseWords = (s: string) =>
  s
    .toLowerCase()
    .replace(/[-–—,.]/g, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "and")
    .join(" ");

/** True when the practitioner's words say the same number as the figures. */
export function quantityWordsMatch(numeric: number, words: string): boolean {
  const expected = numberToWords(numeric);
  return expected !== null && normaliseWords(expected) === normaliseWords(words);
}

export type PrescriptionProblem = {
  field: keyof PrescriptionInput | "expiry_date";
  message: string;
};

const present = (v: unknown) => typeof v === "string" && v.trim().length > 0;

/**
 * Completeness and format check. Returns problems; an empty list means "complete", never "clinically
 * appropriate". `expiresAt` is the practitioner's chosen expiry (required for a prescription).
 */
export function validatePrescription(
  rx: PrescriptionInput,
  expiresAt: Date | string | null | undefined,
  now: Date = new Date(),
): PrescriptionProblem[] {
  const problems: PrescriptionProblem[] = [];
  for (const field of PRESCRIPTION_REQUIRED_FIELDS) {
    const v = rx[field];
    const ok =
      field === "quantity_numeric" || field === "repeats" ? typeof v === "number" : present(v);
    if (!ok)
      problems.push({
        field,
        message: `${PRESCRIPTION_FIELD_LABELS[field]} must be entered by the practitioner`,
      });
  }
  if (typeof rx.quantity_numeric === "number") {
    if (
      !Number.isFinite(rx.quantity_numeric) ||
      rx.quantity_numeric <= 0 ||
      rx.quantity_numeric >= 100000
    )
      problems.push({
        field: "quantity_numeric",
        message: "Quantity must be greater than 0 and below 100 000",
      });
    else if (
      present(rx.quantity_words) &&
      !quantityWordsMatch(rx.quantity_numeric, rx.quantity_words!)
    )
      problems.push({
        field: "quantity_words",
        message: `Quantity in words does not match the figures (${rx.quantity_numeric})`,
      });
  }
  if (
    typeof rx.repeats === "number" &&
    (!Number.isInteger(rx.repeats) || rx.repeats < 0 || rx.repeats > 99)
  )
    problems.push({ field: "repeats", message: "Repeats must be a whole number from 0 to 99" });
  if (!expiresAt)
    problems.push({
      field: "expiry_date",
      message: "An expiry date must be entered by the practitioner",
    });
  else if (new Date(expiresAt).getTime() <= now.getTime())
    problems.push({ field: "expiry_date", message: "The expiry date must be in the future" });
  return problems;
}

// ---------------------------------------------------------------------------
// Dates (Africa/Johannesburg; deterministic, no locale data needed)
// ---------------------------------------------------------------------------

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-10-02" -> "02 October 2026". Returns null for anything that is not an ISO date. */
export function formatIsoDate(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${m[3]} ${month} ${m[1]}` : null;
}

/** Today's date in South Africa as YYYY-MM-DD. */
export const todayInSouthAfrica = (now: Date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(now);

/** Any timestamp -> "02 October 2026" in South African time. */
export const formatInstantDate = (iso: string | null | undefined) =>
  iso
    ? formatIsoDate(
        new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(new Date(iso)),
      )
    : null;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const CLINICAL_MESSAGES: Record<string, string> = {
  forbidden: "You do not have permission for this action",
  document_not_found: "That document could not be found",
  document_not_ready: "That document has not been issued yet",
  document_locked: "That document can no longer be edited — void it and create a new version",
  invalid_transition: "That action is not available for the document's current status",
  hash_mismatch: "The document changed after you reviewed it. Reload and review it again",
  review_required: "Open the document for review before approving it",
  snapshot_changed: "The document's data changed while it was being prepared. Please try again",
  template_unavailable: "That template is not active. Choose an active, approved template",
  template_locked: "Only a draft template can be edited — create a new version instead",
  template_invalid: "The template is not valid",
  template_placeholder: "Replace the placeholder wording with practitioner-approved text first",
  signature_policy_unconfirmed:
    "The required signature level for this document type has not been confirmed by compliance yet",
  signature_provider_unavailable: "No enabled and confirmed signature method is available",
  signature_level_insufficient:
    "No available signature method meets the level required for this document",
  signature_not_enrolled: "The practitioner is not enrolled with the signature provider",
  member_not_verified: "The member's identity must be verified first",
  member_profile_incomplete: "The member's profile needs a full name and date of birth",
  prescription_incomplete: "The prescription is incomplete",
  prescription_invalid: "The prescription is not valid",
  self_verification_forbidden: "Another administrator must do this — you cannot verify yourself",
  confirmation_required: "Record who confirmed this and on what basis",
  invalid_input: "Some of the information entered is not valid",
  idempotency_conflict: "That request was already used for something different. Please retry",
};

/** Codes whose detail text is safe and useful to show (field names, never values). */
const SHOW_DETAIL = new Set([
  "prescription_incomplete",
  "prescription_invalid",
  "template_invalid",
  "invalid_input",
  "invalid_transition",
  "signature_level_insufficient",
  "confirmation_required",
]);

export class ClinicalError extends Error {
  constructor(
    message: string,
    readonly code: string = "clinical_error",
  ) {
    super(message);
    this.name = "ClinicalError";
  }
}

/** Maps database/provider errors to a message that is safe to show. Never echoes unknown internals. */
export function friendlyClinicalError(err: unknown): Error {
  if (err instanceof ClinicalError) return err;
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
  const code = /^([a-z_]+)(?::|$)/.exec(raw)?.[1];
  if (code && CLINICAL_MESSAGES[code]) {
    const detail = raw.slice(code.length + 1).trim();
    return new ClinicalError(
      SHOW_DETAIL.has(code) && detail
        ? `${CLINICAL_MESSAGES[code]}: ${detail}`
        : CLINICAL_MESSAGES[code]!,
      code,
    );
  }
  if (/row-level security|permission denied/i.test(raw))
    return new ClinicalError("You do not have permission for this action", "forbidden");
  return new ClinicalError("The action could not be completed. Please retry.", "clinical_error");
}

// ---------------------------------------------------------------------------
// Late-bound signature placeholders
// ---------------------------------------------------------------------------

export const SIGNATURE_PENDING_STATUS = "Pending — applied when the practitioner signs";
export const SIGNATURE_PENDING_DATE = "Pending";

/** Values for {{signature.status}} / {{signature.signed_at}}: pending before signing, the facts after. */
export function signaturePlaceholderValues(
  sig: { practitioner: string; assurance: AssuranceLevel; signedAt: string } | null,
) {
  if (!sig)
    return {
      "signature.status": SIGNATURE_PENDING_STATUS,
      "signature.signed_at": SIGNATURE_PENDING_DATE,
    };
  return {
    "signature.status": `Signed electronically by ${sig.practitioner} (${ASSURANCE_LABELS[sig.assurance].toLowerCase()})`,
    "signature.signed_at": `${new Intl.DateTimeFormat("en-ZA", { dateStyle: "long", timeStyle: "short", timeZone: "Africa/Johannesburg" }).format(new Date(sig.signedAt))} (SAST)`,
  };
}
