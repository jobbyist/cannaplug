import type { AssuranceLevel } from "@/lib/clinical/logic";

/**
 * Signature-provider abstraction.
 *
 * The application is decoupled from any single provider: it talks to this interface, and which adapter
 * is used (and what assurance level that adapter's output is treated as) is decided by the
 * `signature_providers` registry in the database — a recorded, human-confirmed compliance decision.
 * Adapters never claim an assurance level themselves, and nothing here stores or reuses a signature image.
 *
 *   SIMPLE     a simple electronic signature (e.g. the internal attestation adapter).
 *   ADVANCED   an advanced electronic signature: only valid if the actual provider/method satisfies the
 *              applicable legal and technical requirements. Compliance must confirm that, not code.
 *   QUALIFIED  a qualified electronic signature issued under a recognised qualified service.
 */

export type { AssuranceLevel };

export type SignerIdentity = {
  userId: string;
  fullName: string;
  hpcsaNumber: string;
  /** The practitioner's identifier at the provider, recorded when they were enrolled. Null for SIMPLE. */
  providerRef: string | null;
  email: string | null;
};

export type SigningRequestInput = {
  /** Human document reference (CP-MED-…). */
  documentId: string;
  documentUuid: string;
  /** SHA-256 of the frozen rendered text the practitioner approved. */
  contentHash: string;
  /** The exact bytes the provider is asked to sign (the unsigned PDF), and their SHA-256. */
  unsignedPdf: Uint8Array;
  unsignedPdfHash: string;
  signer: SignerIdentity;
  /** Where an asynchronous provider should notify completion. */
  callbackUrl?: string | undefined;
};

export type SigningCompletion = {
  signatureReference: string;
  signedAt: string; // ISO timestamp
  certificateSubject?: string | undefined;
  certificateIssuer?: string | undefined;
  certificateSerial?: string | undefined;
  metadata: Record<string, string | number | boolean | null>;
  /** The provider-signed document, when the provider returns one. Absent for the internal attestation. */
  signedPdf?: Uint8Array | undefined;
};

export type SigningRequestResult =
  | { status: "COMPLETED"; requestId: string; completion: SigningCompletion }
  | { status: "PENDING"; requestId: string; redirectUrl?: string | undefined }
  | { status: "FAILED"; requestId: string; code: string };

export type SigningStatus =
  | { status: "COMPLETED"; completion: SigningCompletion }
  | { status: "PENDING" | "CANCELLED" }
  | { status: "FAILED"; code: string };

export type SignatureVerification = {
  valid: boolean;
  assurance: AssuranceLevel;
  detail: string;
};

export interface SignatureProvider {
  /** Registry key (matches signature_providers.provider). */
  readonly name: string;
  createSigningRequest(input: SigningRequestInput): Promise<SigningRequestResult>;
  getSigningStatus(requestId: string): Promise<SigningStatus>;
  downloadSignedDocument(requestId: string): Promise<Uint8Array>;
  verifySignature(input: {
    signedPdf: Uint8Array;
    signatureReference: string;
    metadata: Record<string, unknown>;
    unsignedPdfHash: string;
    contentHash: string;
    userId: string;
  }): Promise<SignatureVerification>;
  cancelSigningRequest(requestId: string): Promise<void>;
}

export class SignatureProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SignatureProviderError";
  }
}
