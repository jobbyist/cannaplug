import { hashesEqual } from "@/lib/clinical/hash";
import {
  ASSURANCE_LABELS,
  documentTypeLabel,
  formatInstantDate,
  type AssuranceLevel,
} from "@/lib/clinical/logic";

/**
 * Public verification: turns what the database knows (and what the stored PDF actually hashes to) into
 * the minimum a stranger scanning a QR code is allowed to learn.
 *
 * It never carries a name, date of birth, diagnosis, medicine, dosage, address or any other health or
 * identity information about the member, and never the clinical text.
 */

export type VerificationStatus =
  | "VALID"
  | "REVOKED"
  | "EXPIRED"
  | "VOID"
  | "NOT_ISSUED"
  | "INTEGRITY_FAILURE"
  | "NOT_FOUND"
  | "RATE_LIMITED";

/** What `document_verify_lookup` returns to the server (never forwarded to the browser as-is). */
export type VerifyLookup = {
  found: boolean;
  id?: string;
  document_id?: string;
  document_type?: string;
  status?: string;
  issued_at?: string | null;
  expires_at?: string | null;
  practitioner?: string | undefined;
  registration_verified?: boolean;
  stored_hash?: string | null;
  content_hash_ok?: boolean;
  signature_completed?: boolean;
  assurance?: string | null;
  pdf_path?: string | null;
  pdf_hash_expected?: string | null;
};

export type PublicVerification = {
  status: VerificationStatus;
  documentId?: string | undefined;
  documentType?: string | undefined;
  issued?: string | null | undefined;
  expires?: string | null | undefined;
  practitioner?: string | undefined;
  registration?: "Verified" | "Not currently verified" | undefined;
  /** Present for VALID documents only. */
  signature?: string | undefined;
};

/**
 * Decides the outcome. A document is VALID only when it is issued, unexpired, not revoked/void, its stored
 * text still matches its hash, a completed signature exists, AND the stored PDF still hashes to the value
 * recorded at signing. `observedPdfHash` is null when the file is missing or unreadable.
 */
export function evaluateVerification(
  lookup: VerifyLookup,
  observedPdfHash: string | null,
): VerificationStatus {
  if (!lookup.found) return "NOT_FOUND";
  switch (lookup.status) {
    case "REVOKED":
      return "REVOKED";
    case "VOID":
      return "VOID";
    case "EXPIRED":
      return "EXPIRED";
    case "ISSUED":
      break;
    default:
      return "NOT_ISSUED";
  }
  if (!lookup.content_hash_ok || !lookup.signature_completed) return "INTEGRITY_FAILURE";
  if (!observedPdfHash || !hashesEqual(observedPdfHash, lookup.pdf_hash_expected))
    return "INTEGRITY_FAILURE";
  return "VALID";
}

/** Whether the stored PDF must be read to decide (only an issued document can be VALID). */
export const needsPdfCheck = (lookup: VerifyLookup) =>
  lookup.found === true && lookup.status === "ISSUED";

/** The only shape ever sent to the public page. */
export function toPublicVerification(
  lookup: VerifyLookup,
  status: VerificationStatus,
): PublicVerification {
  if (status === "NOT_FOUND" || status === "RATE_LIMITED") return { status };
  const base: PublicVerification = {
    status,
    documentId: lookup.document_id,
    documentType: documentTypeLabel(lookup.document_type ?? ""),
  };
  if (status === "NOT_ISSUED" || status === "INTEGRITY_FAILURE") return base;
  return {
    ...base,
    issued: formatInstantDate(lookup.issued_at),
    expires: formatInstantDate(lookup.expires_at),
    practitioner: lookup.practitioner,
    registration: lookup.registration_verified ? "Verified" : "Not currently verified",
    ...(status === "VALID" && lookup.assurance
      ? {
          signature: ASSURANCE_LABELS[lookup.assurance as AssuranceLevel] ?? "Electronic signature",
        }
      : {}),
  };
}
