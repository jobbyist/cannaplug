/**
 * ID verification — pure rules shared by the browser, the server functions and the tests.
 * The database is the authority (age check, ownership, state machine); everything here is either
 * presentation or an early, friendly version of a check the database repeats.
 */

export type VerificationStatus = "unverified" | "pending" | "verified" | "rejected" | "expired";
const STATUSES: VerificationStatus[] = ["unverified", "pending", "verified", "rejected", "expired"];
export type DocumentType = "sa_id" | "passport" | "drivers_licence";
export type RejectionCode =
  "unreadable" | "expired_document" | "name_mismatch" | "dob_mismatch" | "underage" | "other";

export const DOCUMENT_TYPES: { value: DocumentType; label: string }[] = [
  { value: "sa_id", label: "South African ID (card or book)" },
  { value: "passport", label: "Passport" },
  { value: "drivers_licence", label: "Driver's licence" },
];

export const documentTypeLabel = (type: string | null | undefined) =>
  DOCUMENT_TYPES.find((d) => d.value === type)?.label ?? "ID document";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** South African IDs do not expire; passports and driver's licences do. */
export const documentNeedsExpiry = (type: string | null | undefined) =>
  type === "passport" || type === "drivers_licence";

const MAX_EXPIRY_YEARS = 15;

/** Early, friendly version of the database's expiry rule (the database is the authority). */
export function expiryProblem(
  type: string,
  expiresOn: string,
  today: Date = new Date(),
): string | null {
  if (!documentNeedsExpiry(type)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) || Number.isNaN(Date.parse(expiresOn)))
    return "Enter the expiry date shown on your document.";
  const todayIso = iso(today.getFullYear(), today.getMonth() + 1, today.getDate());
  if (expiresOn < todayIso) return "That document has expired. Upload a current one.";
  if (expiresOn > iso(today.getFullYear() + MAX_EXPIRY_YEARS, today.getMonth() + 1, 28))
    return "Enter the expiry date shown on your document.";
  return null;
}

/** True once a document's expiry date has passed (a missing date means it never expires). */
export const isExpired = (expiresOn: string | null | undefined, today: Date = new Date()) =>
  Boolean(expiresOn) &&
  (expiresOn as string) < iso(today.getFullYear(), today.getMonth() + 1, today.getDate());

/** What the reviewer picks, and what the member is told (never internal notes). */
export const REJECTION_REASONS: { code: RejectionCode; label: string; memberMessage: string }[] = [
  {
    code: "unreadable",
    label: "Photo unreadable or cropped",
    memberMessage: "We couldn't read your document. Upload a clear, uncropped photo or scan.",
  },
  {
    code: "expired_document",
    label: "Document expired",
    memberMessage: "That document has expired. Upload a current one.",
  },
  {
    code: "name_mismatch",
    label: "Name doesn't match the account",
    memberMessage: "The name on the document doesn't match your account name.",
  },
  {
    code: "dob_mismatch",
    label: "Date of birth doesn't match",
    memberMessage: "The date of birth on the document doesn't match what you entered.",
  },
  {
    code: "underage",
    label: "Under 18",
    memberMessage: "You must be 18 or older to shop with CannaPlug.",
  },
  { code: "other", label: "Other (add a note)", memberMessage: "Your ID could not be approved." },
];

export const rejectionMessage = (code: string | null | undefined, note?: string | null) => {
  const base =
    REJECTION_REASONS.find((r) => r.code === code)?.memberMessage ??
    "Your ID could not be approved.";
  return code === "other" && note ? `${base} ${note}` : base;
};

// ---- Files ---------------------------------------------------------------------------------

export const ID_MAX_BYTES = 5 * 1024 * 1024;
export const ID_MAX_ATTEMPTS = 5;
export const ID_BUCKET = "id-documents";

export const ID_MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};
export const ID_ACCEPT = Object.keys(ID_MIME_TO_EXT).join(",");

const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * True only for a path in the exact shape the server mints: `<userId>/<uuid>.<jpg|png|webp|pdf>`.
 * Checked BEFORE any storage access, so a traversal path (`<me>/../<other>/x.jpg`) can never be
 * downloaded, inspected or deleted on another member's behalf. The database repeats the same rule.
 */
export function isOwnUploadPath(userId: string, path: string): boolean {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return false;
  return new RegExp(`^${userId}/${UUID_RE}\\.(jpg|png|webp|pdf)$`, "i").test(path);
}

/** Identifies the real file type from its first bytes — the browser-declared type is not trusted. */
export function sniffMime(bytes: Uint8Array): string | null {
  const is = (offset: number, ...sig: number[]) => sig.every((b, i) => bytes[offset + i] === b);
  if (is(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (is(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (is(0, 0x52, 0x49, 0x46, 0x46) && is(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (is(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  return null;
}

/** Client-side pre-check so a member isn't made to wait for an upload that will be refused. */
export function checkIdFile(file: { size: number; type: string }): string | null {
  if (!ID_MIME_TO_EXT[file.type]) return "Upload a JPG, PNG, WebP or PDF.";
  if (file.size <= 0) return "That file is empty.";
  if (file.size > ID_MAX_BYTES) return "That file is over 5 MB. Upload a smaller photo or scan.";
  return null;
}

// ---- Age -----------------------------------------------------------------------------------

/** The latest birth date (YYYY-MM-DD) that is 18+ today. Used as the date input's `max`. */
export function latestAdultBirthDate(today: Date = new Date()): string {
  const y = today.getFullYear() - 18;
  const m = today.getMonth() + 1;
  const d = today.getDate();
  // 29 Feb has no 18-years-ago twin in a non-leap year: the 28th is the conservative day.
  const leapSafe =
    m === 2 && d === 29 && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 28 : d;
  return iso(y, m, leapSafe);
}

export const earliestBirthDate = (today: Date = new Date()) =>
  iso(today.getFullYear() - 120, today.getMonth() + 1, Math.min(today.getDate(), 28));

export function dobProblem(dob: string, today: Date = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(dob)))
    return "Enter your date of birth.";
  if (dob < earliestBirthDate(today)) return "Enter your date of birth.";
  if (dob > latestAdultBirthDate(today)) return "You must be 18 or older to shop with CannaPlug.";
  return null;
}

// ---- Status presentation -------------------------------------------------------------------

export type VerificationRow = {
  status: string;
  document_type?: string | null;
  submitted_at?: string | null;
  reviewed_at?: string | null;
  rejection_code?: string | null;
  rejection_note?: string | null;
  attempt_count?: number | null;
  document_expires_on?: string | null;
};

export type VerificationView = {
  status: VerificationStatus;
  label: string;
  tone: "neutral" | "warning" | "success" | "danger";
  headline: string;
  detail: string;
  canOrder: boolean;
  canSubmit: boolean;
  attemptsLeft: number;
};

export function verificationView(row: VerificationRow | null | undefined): VerificationView {
  const status: VerificationStatus = STATUSES.includes(row?.status as VerificationStatus)
    ? (row!.status as VerificationStatus)
    : "unverified";
  const attemptsLeft = Math.max(0, ID_MAX_ATTEMPTS - (row?.attempt_count ?? 0));
  const open = status === "unverified" || status === "rejected" || status === "expired";
  const base = { status, canOrder: status === "verified", attemptsLeft };
  // A verified member whose passport / driver's licence has expired cannot order (the database enforces
  // it at the gate); show them that, and let them upload a current document.
  if (status === "verified" && isExpired(row?.document_expires_on)) {
    return {
      ...base,
      status: "expired",
      canOrder: false,
      label: "Expired",
      tone: "danger",
      headline: "Your ID document has expired",
      detail: `Your ${documentTypeLabel(row?.document_type).toLowerCase()} expired on ${row?.document_expires_on}. Upload a current one to keep ordering.`,
      canSubmit: true,
      attemptsLeft: ID_MAX_ATTEMPTS,
    };
  }
  switch (status) {
    case "verified":
      return {
        ...base,
        label: "Verified",
        tone: "success",
        headline: "Your ID is verified",
        detail: row?.document_expires_on
          ? `You can place orders. Valid until ${row.document_expires_on}.`
          : "You can place orders.",
        canSubmit: false,
      };
    case "pending":
      return {
        ...base,
        label: "In review",
        tone: "warning",
        headline: "Your ID is being reviewed",
        detail: "We review IDs by hand. You'll see the result here as soon as it's done.",
        canSubmit: false,
      };
    case "rejected":
      return {
        ...base,
        label: "Not approved",
        tone: "danger",
        headline: "We couldn't approve your ID",
        detail: rejectionMessage(row?.rejection_code, row?.rejection_note),
        canSubmit: attemptsLeft > 0,
      };
    case "expired":
      return {
        ...base,
        label: "Expired",
        tone: "danger",
        headline: "Please verify your ID again",
        detail: "Your previous verification has expired.",
        canSubmit: open && attemptsLeft > 0,
      };
    default:
      return {
        ...base,
        label: "Not verified",
        tone: "neutral",
        headline: "Verify your ID to start ordering",
        detail: "CannaPlug is for adults only. Upload a photo of your ID — it takes a minute.",
        canSubmit: attemptsLeft > 0,
      };
  }
}
