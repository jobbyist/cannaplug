import { createHmac, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "@/lib/clinical/hash";
import {
  SignatureProviderError,
  type SignatureProvider,
  type SigningCompletion,
  type SigningRequestInput,
  type SigningRequestResult,
  type SigningStatus,
} from "@/lib/clinical/signature-provider";

/**
 * Adapters. Credentials come from environment variables only; nothing here is exposed to the browser
 * (this file is `.server.ts`) and no private signing key ever lives in the repository.
 */

// ---------------------------------------------------------------------------------------------
// Internal attestation — a SIMPLE electronic signature only.
//
// The practitioner has reviewed the exact document and explicitly confirmed it while signed in. The
// adapter records an HMAC over (unsigned-PDF hash, content hash, practitioner, time) keyed with a
// server-side secret, so the record is tamper-evident and bound to this document. It is NOT a
// cryptographic signature on the PDF, carries no certificate, and is NOT equivalent to an advanced or
// qualified electronic signature. The registry records it as SIMPLE and the database refuses it for
// prescriptions.
// ---------------------------------------------------------------------------------------------

export const INTERNAL_PROVIDER = "internal_simple";

function attestationSecret(): string {
  const secret = process.env["SIGNATURE_ATTESTATION_SECRET"];
  if (!secret || secret.length < 32)
    throw new SignatureProviderError(
      "SIGNATURE_ATTESTATION_SECRET must be set to a random value of at least 32 characters",
      "provider_not_configured",
    );
  return secret;
}

const attestationMac = (input: {
  unsignedPdfHash: string;
  contentHash: string;
  userId: string;
  signedAt: string;
}) =>
  createHmac("sha256", attestationSecret())
    .update(`${input.unsignedPdfHash}|${input.contentHash}|${input.userId}|${input.signedAt}`)
    .digest("hex");

export class InternalAttestationProvider implements SignatureProvider {
  readonly name = INTERNAL_PROVIDER;

  async createSigningRequest(input: SigningRequestInput): Promise<SigningRequestResult> {
    const signedAt = new Date().toISOString();
    const mac = attestationMac({
      unsignedPdfHash: input.unsignedPdfHash,
      contentHash: input.contentHash,
      userId: input.signer.userId,
      signedAt,
    });
    const completion: SigningCompletion = {
      signatureReference: `ATT-${mac.slice(0, 32)}`,
      signedAt,
      metadata: {
        method: "SIMPLE_INTERNAL_ATTESTATION",
        signed_at: signedAt,
        mac,
        equivalent_to_advanced_or_qualified: false,
      },
    };
    return { status: "COMPLETED", requestId: `att-${input.documentUuid}`, completion };
  }

  async getSigningStatus(): Promise<SigningStatus> {
    return { status: "PENDING" };
  }

  async downloadSignedDocument(): Promise<Uint8Array> {
    throw new SignatureProviderError(
      "The internal attestation does not produce a signed file",
      "unsupported",
    );
  }

  async verifySignature(input: Parameters<SignatureProvider["verifySignature"]>[0]) {
    const mac = typeof input.metadata["mac"] === "string" ? (input.metadata["mac"] as string) : "";
    const signedAt =
      typeof input.metadata["signed_at"] === "string"
        ? (input.metadata["signed_at"] as string)
        : "";
    const expected = attestationMac({
      unsignedPdfHash: input.unsignedPdfHash,
      contentHash: input.contentHash,
      userId: input.userId,
      signedAt,
    });
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    const valid = a.length === b.length && timingSafeEqual(a, b);
    return {
      valid,
      assurance: "SIMPLE" as const,
      detail: valid
        ? "Internal attestation matches this document (simple electronic signature)"
        : "Internal attestation does not match",
    };
  }

  async cancelSigningRequest(): Promise<void> {}
}

// ---------------------------------------------------------------------------------------------
// External provider — a generic REST contract.
//
//   POST {API_URL}/signing-requests            {document_base64, document_sha256, signer, callback_url, reference}
//        -> {id, status: "pending"|"completed"|"failed", sign_url?}
//   GET  {API_URL}/signing-requests/{id}       -> {status, signed_at, signature_reference, certificate:{subject,issuer,serial}}
//   GET  {API_URL}/signing-requests/{id}/document   -> signed PDF bytes
//   POST {API_URL}/signing-requests/{id}/cancel
//   POST {API_URL}/verify                      {document_base64, signature_reference} -> {valid, detail}
//
// This is a provider-neutral contract, not a vendor integration: a real provider needs a thin adapter
// that maps its API to these calls, and its method must be confirmed by compliance before the registry
// row is raised above SIMPLE. Webhook calls are authenticated with an HMAC (see verifyWebhookSignature).
// ---------------------------------------------------------------------------------------------

export const EXTERNAL_PROVIDER = "external_generic";

function externalConfig() {
  const url = process.env["EXTERNAL_SIGNATURE_API_URL"];
  const key = process.env["EXTERNAL_SIGNATURE_API_KEY"];
  if (!url || !key)
    throw new SignatureProviderError(
      "EXTERNAL_SIGNATURE_API_URL and EXTERNAL_SIGNATURE_API_KEY must be set",
      "provider_not_configured",
    );
  return { url: url.replace(/\/+$/, ""), key };
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

async function call<T>(path: string, init: RequestInit & { raw?: boolean } = {}): Promise<T> {
  const { url, key } = externalConfig();
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SignatureProviderError(
      "The signature provider could not be reached",
      "provider_unreachable",
    );
  }
  if (!res.ok)
    throw new SignatureProviderError(
      `The signature provider refused the request (${res.status})`,
      "provider_error",
    );
  return (init.raw ? new Uint8Array(await res.arrayBuffer()) : await res.json()) as T;
}

type ExternalStatus = {
  status: "pending" | "completed" | "failed" | "cancelled";
  signed_at?: string;
  signature_reference?: string;
  certificate?: { subject?: string; issuer?: string; serial?: string };
  failure_code?: string;
};

async function completionFrom(id: string, s: ExternalStatus): Promise<SigningCompletion> {
  if (!s.signature_reference || !s.signed_at)
    throw new SignatureProviderError(
      "The provider reported completion without a signature record",
      "provider_error",
    );
  const signedPdf = await call<Uint8Array>(`/signing-requests/${encodeURIComponent(id)}/document`, {
    raw: true,
    method: "GET",
  });
  return {
    signatureReference: s.signature_reference,
    signedAt: s.signed_at,
    certificateSubject: s.certificate?.subject,
    certificateIssuer: s.certificate?.issuer,
    certificateSerial: s.certificate?.serial,
    metadata: { provider_request_id: id },
    signedPdf,
  };
}

export class ExternalHttpProvider implements SignatureProvider {
  readonly name = EXTERNAL_PROVIDER;

  async createSigningRequest(input: SigningRequestInput): Promise<SigningRequestResult> {
    if (!input.signer.providerRef)
      throw new SignatureProviderError(
        "The practitioner is not enrolled with the signature provider",
        "not_enrolled",
      );
    const res = await call<{ id: string; status: string; sign_url?: string }>("/signing-requests", {
      method: "POST",
      body: JSON.stringify({
        reference: input.documentId,
        document_base64: toBase64(input.unsignedPdf),
        document_sha256: input.unsignedPdfHash,
        signer: {
          reference: input.signer.providerRef,
          name: input.signer.fullName,
          email: input.signer.email,
        },
        callback_url: input.callbackUrl,
      }),
    });
    if (res.status === "failed")
      return { status: "FAILED", requestId: res.id, code: "provider_rejected" };
    if (res.status === "completed") {
      const s = await call<ExternalStatus>(`/signing-requests/${encodeURIComponent(res.id)}`);
      return {
        status: "COMPLETED",
        requestId: res.id,
        completion: await completionFrom(res.id, s),
      };
    }
    return { status: "PENDING", requestId: res.id, redirectUrl: res.sign_url };
  }

  async getSigningStatus(requestId: string): Promise<SigningStatus> {
    const s = await call<ExternalStatus>(`/signing-requests/${encodeURIComponent(requestId)}`);
    if (s.status === "completed")
      return { status: "COMPLETED", completion: await completionFrom(requestId, s) };
    if (s.status === "failed")
      return { status: "FAILED", code: s.failure_code ?? "provider_failed" };
    if (s.status === "cancelled") return { status: "CANCELLED" };
    return { status: "PENDING" };
  }

  downloadSignedDocument(requestId: string): Promise<Uint8Array> {
    return call<Uint8Array>(`/signing-requests/${encodeURIComponent(requestId)}/document`, {
      raw: true,
      method: "GET",
    });
  }

  async verifySignature(input: Parameters<SignatureProvider["verifySignature"]>[0]) {
    const res = await call<{ valid: boolean; detail?: string }>("/verify", {
      method: "POST",
      body: JSON.stringify({
        document_base64: toBase64(input.signedPdf),
        signature_reference: input.signatureReference,
      }),
    });
    // The assurance of an external signature is whatever compliance recorded in the registry; the caller
    // reads that, never this adapter.
    return {
      valid: res.valid === true,
      assurance: "SIMPLE" as const,
      detail: res.detail ?? "Verified by provider",
    };
  }

  async cancelSigningRequest(requestId: string): Promise<void> {
    await call(`/signing-requests/${encodeURIComponent(requestId)}/cancel`, {
      method: "POST",
      body: "{}",
    });
  }
}

/** Constant-time check of the provider's webhook HMAC (hex SHA-256 of the raw body). */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret = process.env["EXTERNAL_SIGNATURE_WEBHOOK_SECRET"],
): boolean {
  if (!secret || !signatureHeader) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = signatureHeader
    .replace(/^sha256=/, "")
    .trim()
    .toLowerCase();
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

const PROVIDERS: Record<string, () => SignatureProvider> = {
  [INTERNAL_PROVIDER]: () => new InternalAttestationProvider(),
  [EXTERNAL_PROVIDER]: () => new ExternalHttpProvider(),
};

export function getSignatureProvider(name: string): SignatureProvider {
  const make = PROVIDERS[name];
  if (!make) throw new SignatureProviderError("Unknown signature provider", "unknown_provider");
  return make();
}

/** SHA-256 of whatever bytes a provider returned (used for hash-after-signature). */
export const hashSigned = (bytes: Uint8Array) => sha256Hex(bytes);
