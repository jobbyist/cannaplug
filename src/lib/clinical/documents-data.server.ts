import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { requestContext, verificationUrl, appBaseUrl } from "@/lib/clinical/context.server";
import { buildDocumentReadyEmail } from "@/lib/clinical/email";
import { generateVerificationToken, hashesEqual, sha256Hex } from "@/lib/clinical/hash";
import {
  ClinicalError,
  friendlyClinicalError,
  meetsAssurance,
  signaturePlaceholderValues,
  todayInSouthAfrica,
  validatePrescription,
  type AssuranceLevel,
  type DocumentType,
  type PrescriptionInput,
} from "@/lib/clinical/logic";
import { renderDocumentPdf, validatePdf, type PdfSignatureBlock } from "@/lib/clinical/pdf.server";
import type { SigningCompletion } from "@/lib/clinical/signature-provider";
import { SignatureProviderError } from "@/lib/clinical/signature-provider";
import { getSignatureProvider, hashSigned } from "@/lib/clinical/signature-providers.server";
import {
  renderTemplate,
  resolveLateBound,
  TemplateError,
  type RenderData,
  type TemplateSchema,
} from "@/lib/clinical/template-engine";

/**
 * Clinical documents data layer. Every call carries the acting user (from the verified JWT) and every
 * rule that matters — who may do what, the state machine, hashes, signature levels — is enforced by the
 * database functions, not here. This layer orchestrates: rendering, PDF generation, the signature
 * provider, storage, and email.
 *
 * Audit: reads of clinical content and of the stored PDF are recorded by the database functions before
 * anything is returned; this layer never logs document content, names or addresses.
 */

export const BUCKET = "clinical-documents";
const SIGNED_URL_SECONDS = 60;

const storage = () => supabaseAdmin.storage.from(BUCKET);

function unwrap<T>(res: { data: unknown; error: { message: string } | null }): T {
  if (res.error) throw friendlyClinicalError(res.error);
  return res.data as T;
}

async function rpc<T = Json>(name: string, args: Record<string, unknown>): Promise<T> {
  // The generated types describe each function; the dynamic name keeps one error path for all of them.
  const res = await (
    supabaseAdmin.rpc as unknown as (
      n: string,
      a: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }>
  )(name, args);
  return unwrap<T>(res);
}

const audit = () => {
  const { ip, userAgent } = requestContext();
  return { p_ip: ip, p_ua: userAgent };
};

// ---------------------------------------------------------------------------
// Practitioner
// ---------------------------------------------------------------------------

export type DoctorProfileRow = {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  title: string;
  hpcsa_number: string | null;
  practice_number: string | null;
  qualification: string | null;
  speciality: string | null;
  practice_name: string | null;
  practice_address: string | null;
  practice_phone: string | null;
  practice_email: string | null;
  verification_status: "pending" | "verified" | "suspended" | "revoked";
  prescribing_authorised: boolean;
  signature_status: "not_enrolled" | "enrolled" | "suspended";
  signature_provider: string | null;
  is_active: boolean;
};

const DOCTOR_COLUMNS =
  "id,user_id,first_name,last_name,title,hpcsa_number,practice_number,qualification,speciality,practice_name,practice_address,practice_phone,practice_email,verification_status,prescribing_authorised,signature_status,signature_provider,is_active";

/** The caller's own practitioner profile, or null if they are not a practitioner. */
export async function getMyDoctorProfile(userId: string): Promise<DoctorProfileRow | null> {
  const res = await supabaseAdmin
    .from("doctor_profiles")
    .select(DOCTOR_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  return unwrap<DoctorProfileRow | null>(res);
}

export const updateMyDoctorProfile = (userId: string, data: Record<string, string | null>) =>
  rpc("doctor_update_own_profile", { p_actor: userId, p_data: data as Json });

export const listMyPatients = (userId: string) =>
  rpc<PatientRow[]>("doctor_list_patients", { p_actor: userId });
export const listMyDocuments = (userId: string) =>
  rpc<DoctorDocumentRow[]>("doctor_list_documents", { p_actor: userId });
export const listMyAuditEvents = (userId: string) =>
  rpc<EventRow[]>("clinical_document_doctor_events", { p_actor: userId, p_limit: 200 });

export type PatientRow = {
  member_id: string;
  member_ref: string;
  full_name: string | null;
  date_of_birth: string | null;
  identity_verified: boolean;
  documents: number;
};
export type DoctorDocumentRow = {
  id: string;
  document_id: string;
  document_type: DocumentType;
  status: string;
  patient: string | null;
  member_id: string;
  created_at: string;
  issued_at: string | null;
  expires_at: string | null;
  template_version: number;
  document_version: number;
};
export type EventRow = {
  id: number;
  document_id: string;
  event_type: string;
  actor_role: string;
  created_at: string;
  ip_address?: string | null;
};

// ---------------------------------------------------------------------------
// Templates (read for practitioners; administrative changes below)
// ---------------------------------------------------------------------------

export type TemplateRow = {
  id: string;
  document_type: DocumentType;
  name: string;
  version: number;
  status: "DRAFT" | "PENDING_APPROVAL" | "ACTIVE" | "ARCHIVED" | "REVOKED";
  template_content: string;
  template_schema: TemplateSchema;
  change_note: string | null;
  review_note: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  effective_from: string | null;
  effective_until: string | null;
  created_at: string;
};

export const listTemplates = (userId: string) =>
  rpc<TemplateRow[]>("template_list", { p_actor: userId });

export const createTemplate = (
  userId: string,
  i: {
    type: DocumentType;
    name: string;
    content: string;
    schema: TemplateSchema;
    note: string | null;
  },
) =>
  rpc("template_create", {
    p_actor: userId,
    p_type: i.type,
    p_name: i.name,
    p_content: i.content,
    p_schema: i.schema as unknown as Json,
    p_note: i.note,
  });
export const updateTemplateDraft = (
  userId: string,
  i: { templateId: string; content: string; schema: TemplateSchema; note: string | null },
) =>
  rpc("template_update_draft", {
    p_actor: userId,
    p_template_id: i.templateId,
    p_content: i.content,
    p_schema: i.schema as unknown as Json,
    p_note: i.note,
  });
export const newTemplateVersion = (
  userId: string,
  i: {
    templateId: string;
    content: string | null;
    schema: TemplateSchema | null;
    note: string | null;
  },
) =>
  rpc("template_new_version", {
    p_actor: userId,
    p_template_id: i.templateId,
    p_content: i.content,
    p_schema: i.schema as unknown as Json,
    p_note: i.note,
  });
export const submitTemplate = (userId: string, templateId: string) =>
  rpc("template_submit", { p_actor: userId, p_template_id: templateId });
export const decideTemplate = (
  userId: string,
  i: { templateId: string; approve: boolean; note: string | null; effectiveUntil: string | null },
) =>
  rpc("template_decide", {
    p_actor: userId,
    p_template_id: i.templateId,
    p_approve: i.approve,
    p_note: i.note,
    p_effective_until: i.effectiveUntil,
  });
export const retireTemplate = (
  userId: string,
  i: { templateId: string; revoke: boolean; note: string | null },
) =>
  rpc("template_retire", {
    p_actor: userId,
    p_template_id: i.templateId,
    p_revoke: i.revoke,
    p_note: i.note,
  });

// ---------------------------------------------------------------------------
// Document lifecycle (practitioner)
// ---------------------------------------------------------------------------

export type CreateDocumentInput = {
  type: DocumentType;
  memberId: string;
  templateId: string;
  clinical: Record<string, string> | null;
  prescription: PrescriptionInput | null;
  expiresAt: string | null;
  supersedes: string | null;
  key: string;
};

export function createDocument(userId: string, i: CreateDocumentInput) {
  return rpc<{ id: string; document_id: string; status: string }>("clinical_document_create", {
    p_actor: userId,
    p_type: i.type,
    p_member_id: i.memberId,
    p_template_id: i.templateId,
    p_clinical: (i.clinical ?? {}) as Json,
    p_prescription: (i.prescription ?? {}) as Json,
    p_expires_at: i.expiresAt,
    p_token: generateVerificationToken(),
    p_idempotency_key: i.key,
    p_supersedes: i.supersedes,
    ...audit(),
  });
}

export const updateDraft = (
  userId: string,
  i: {
    documentId: string;
    clinical: Record<string, string> | null;
    prescription: PrescriptionInput | null;
    setExpiry: boolean;
    expiresAt: string | null;
  },
) =>
  rpc("clinical_document_update_draft", {
    p_actor: userId,
    p_doc: i.documentId,
    p_clinical: i.clinical as Json,
    p_prescription: i.prescription as Json,
    p_expires_at: i.expiresAt,
    p_set_expiry: i.setExpiry,
    ...audit(),
  });

/** DRAFT -> PENDING_DOCTOR_REVIEW: re-reads identity, validates, renders, and freezes + hashes the text. */
export async function submitForReview(userId: string, documentId: string) {
  const prepared = await rpc<{
    document_type: DocumentType;
    snapshot: RenderData;
    snapshot_hash: string;
    template: { content: string; schema: TemplateSchema };
  }>("clinical_document_prepare", {
    p_actor: userId,
    p_doc: documentId,
    p_issue_date: todayInSouthAfrica(),
  });

  if (prepared.document_type === "PRESCRIPTION_ORDER") {
    // Presence and format only (e.g. quantity words agree with figures). Never a clinical judgement.
    const expiry = prepared.snapshot.document?.["expiry_date"];
    const problems = validatePrescription(
      (prepared.snapshot.prescription ?? {}) as PrescriptionInput,
      typeof expiry === "string" && expiry ? `${expiry}T23:59:59+02:00` : null,
    );
    if (problems.length)
      throw new ClinicalError(
        `The prescription needs attention: ${problems.map((p) => p.message).join("; ")}`,
        "prescription_incomplete",
      );
  }
  let rendered: string;
  try {
    rendered = renderTemplate(
      prepared.template.content,
      prepared.template.schema,
      prepared.snapshot,
    );
  } catch (err) {
    if (err instanceof TemplateError) throw new ClinicalError(err.message, "template_invalid");
    throw err;
  }
  return rpc<{ id: string; status: string; document_hash: string }>("clinical_document_submit", {
    p_actor: userId,
    p_doc: documentId,
    p_rendered: rendered,
    p_snapshot_hash: prepared.snapshot_hash,
    ...audit(),
  });
}

export type DoctorView = {
  id: string;
  document_id: string;
  document_type: DocumentType;
  status: string;
  member_id: string;
  template_id: string;
  template_version: number;
  document_version: number;
  document_hash: string | null;
  rendered_content: string | null;
  snapshot: RenderData;
  expires_at: string | null;
  issued_at: string | null;
  created_at: string;
  review_note: string | null;
  revocation_reason: string | null;
  has_pdf: boolean;
  /** Present for a DRAFT prescription so the practitioner can keep editing. Never defaulted. */
  prescription?: PrescriptionInput | null;
};

/** The practitioner's view of one of their documents (audited). Includes the exact text to be signed. */
export async function getDoctorView(userId: string, documentId: string): Promise<DoctorView> {
  const view = await rpc<DoctorView>("clinical_document_doctor_view", {
    p_actor: userId,
    p_doc: documentId,
    ...audit(),
  });
  if (view.document_type === "PRESCRIPTION_ORDER") {
    const rx = await supabaseAdmin
      .from("prescription_orders")
      .select(
        "medicine_name,generic_name,dosage_form,strength,quantity_numeric,quantity_words,directions,route,frequency,duration,repeats,indication,special_instructions",
      )
      .eq("document_id", documentId)
      .maybeSingle();
    view.prescription = unwrap<PrescriptionInput | null>(rx);
  }
  return view;
}

export const decideDocument = (
  userId: string,
  i: {
    documentId: string;
    decision: "approve" | "reject" | "request_changes";
    expectedHash: string | null;
    note: string | null;
  },
) =>
  rpc("clinical_document_decide", {
    p_actor: userId,
    p_doc: i.documentId,
    p_decision: i.decision,
    p_expected_hash: i.expectedHash,
    p_note: i.note,
    ...audit(),
  });

export const voidDocument = (userId: string, documentId: string, reason: string) =>
  rpc("clinical_document_void", {
    p_actor: userId,
    p_doc: documentId,
    p_reason: reason,
    ...audit(),
  });

export const revokeDocument = (userId: string, documentId: string, reason: string) =>
  rpc("clinical_document_revoke", {
    p_actor: userId,
    p_doc: documentId,
    p_reason: reason,
    ...audit(),
  });

// ---------------------------------------------------------------------------
// Signing and issuing
// ---------------------------------------------------------------------------

export type SigningOption = {
  provider: string;
  displayName: string;
  assurance: AssuranceLevel;
  usable: boolean;
  reason?: string | undefined;
};

/** Which signature methods could sign this kind of document right now (a mirror of the database gates). */
export async function getSigningOptions(
  userId: string,
  type: DocumentType,
): Promise<{ required: AssuranceLevel; policyConfirmed: boolean; options: SigningOption[] }> {
  const doctor = await getMyDoctorProfile(userId);
  const [{ data: policy }, { data: providers }] = await Promise.all([
    supabaseAdmin
      .from("document_signature_policy")
      .select("required_assurance,confirmed_at")
      .eq("document_type", type)
      .maybeSingle(),
    supabaseAdmin
      .from("signature_providers")
      .select("provider,display_name,assurance_level,enabled,confirmed_at"),
  ]);
  const required = (policy?.required_assurance ?? "ADVANCED") as AssuranceLevel;
  const options = (providers ?? []).map((p): SigningOption => {
    const assurance = p.assurance_level as AssuranceLevel;
    let reason: string | undefined;
    if (!p.enabled || !p.confirmed_at) reason = "Not enabled and confirmed by compliance";
    else if (!meetsAssurance(assurance, required))
      reason = `Below the required ${required.toLowerCase()} level`;
    else if (
      assurance !== "SIMPLE" &&
      (doctor?.signature_status !== "enrolled" || doctor.signature_provider !== p.provider)
    )
      reason = "You are not enrolled with this provider";
    return {
      provider: p.provider,
      displayName: p.display_name,
      assurance,
      usable: !reason,
      reason,
    };
  });
  return { required, policyConfirmed: Boolean(policy?.confirmed_at), options };
}

type DocForSigning = {
  id: string;
  document_id: string;
  document_type: DocumentType;
  member_id: string;
  doctor_id: string;
  status: string;
  rendered_content: string | null;
  document_hash: string | null;
  source_data_snapshot: RenderData;
  verification_token: string;
  approved_at: string | null;
  expires_at: string | null;
};

async function loadForSigning(documentId: string): Promise<DocForSigning> {
  const res = await supabaseAdmin
    .from("medical_documents")
    .select(
      "id,document_id,document_type,member_id,doctor_id,status,rendered_content,document_hash,source_data_snapshot,verification_token,approved_at,expires_at",
    )
    .eq("id", documentId)
    .maybeSingle();
  const doc = unwrap<DocForSigning | null>(res);
  if (!doc) throw new ClinicalError("That document could not be found", "document_not_found");
  return doc;
}

function pdfInput(doc: DocForSigning, signature: PdfSignatureBlock | null) {
  const doctor = (doc.source_data_snapshot.doctor ?? {}) as Record<string, string | undefined>;
  return {
    documentId: doc.document_id,
    documentType: doc.document_type,
    // The frozen text carries {{signature.*}} tokens; the PDF shows PENDING before signing and the facts after.
    content: resolveLateBound(
      doc.rendered_content ?? "",
      signaturePlaceholderValues(
        signature
          ? {
              practitioner: signature.practitioner,
              assurance: signature.assurance,
              signedAt: signature.signedAt,
            }
          : null,
      ),
    ),
    issueDate: (doc.source_data_snapshot.document?.["issue_date"] as string | undefined) ?? null,
    expiresAt: doc.expires_at,
    verificationUrl: verificationUrl(doc.verification_token),
    createdAt: new Date(doc.approved_at ?? Date.now()),
    signature,
    doctor,
  };
}

const practitionerName = (doc: DocForSigning) => {
  const d = (doc.source_data_snapshot.doctor ?? {}) as Record<string, string | undefined>;
  return `${d["title"] ?? "Dr"} ${d["full_name"] ?? ""}`.trim();
};

/**
 * "Approve & Sign" second half: the practitioner has already approved the exact hash. Builds the unsigned
 * PDF, hands it to the provider, and — when the provider completes — stores, records and issues.
 */
export async function signDocument(
  userId: string,
  i: { documentId: string; expectedHash: string; provider: string },
) {
  const doc = await loadForSigning(i.documentId);
  if (doc.status !== "APPROVED")
    throw new ClinicalError(
      "That action is not available for the document's current status",
      "invalid_transition",
    );
  if (!doc.rendered_content || !doc.document_hash)
    throw new ClinicalError("The document has no frozen content", "invalid_transition");
  // The text being signed must hash to the value the practitioner approved — recomputed here, enforced in the database.
  const actual = await sha256Hex(doc.rendered_content);
  if (!hashesEqual(actual, doc.document_hash) || !hashesEqual(actual, i.expectedHash))
    throw new ClinicalError(
      "The document changed after you reviewed it. Reload and review it again",
      "hash_mismatch",
    );

  const doctor = await getMyDoctorProfile(userId);
  if (!doctor) throw new ClinicalError("You do not have permission for this action", "forbidden");

  const unsignedPdf = await renderDocumentPdf(pdfInput(doc, null));
  const check = await validatePdf(unsignedPdf);
  if (!check.ok)
    throw new ClinicalError("The document could not be prepared for signing", "pdf_invalid");
  const unsignedHash = await sha256Hex(unsignedPdf);

  // Database gates: approved status, hash, enabled+confirmed provider, assurance >= policy, enrolment.
  await rpc("clinical_document_begin_signing", {
    p_actor: userId,
    p_doc: doc.id,
    p_expected_hash: doc.document_hash,
    p_provider: i.provider,
    p_unsigned_pdf_hash: unsignedHash,
    p_provider_request_id: null,
    ...audit(),
  });

  const provider = getSignatureProvider(i.provider);
  const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);
  let result;
  try {
    result = await provider.createSigningRequest({
      documentId: doc.document_id,
      documentUuid: doc.id,
      contentHash: doc.document_hash,
      unsignedPdf,
      unsignedPdfHash: unsignedHash,
      signer: {
        userId,
        fullName: practitionerName(doc),
        hpcsaNumber: doctor.hpcsa_number ?? "",
        providerRef: null,
        email: authUser.user?.email ?? null,
      },
      callbackUrl: `${appBaseUrl()}/api/public/signatures/webhook`,
    });
  } catch (err) {
    await rpc("clinical_document_signing_failed", {
      p_actor: userId,
      p_doc: doc.id,
      p_code: err instanceof SignatureProviderError ? err.code : "provider_error",
      p_cancelled: false,
      ...audit(),
    });
    throw new ClinicalError(
      err instanceof SignatureProviderError && err.code === "provider_not_configured"
        ? "The signature provider is not configured"
        : "The document could not be signed. Please try again.",
      "signing_failed",
    );
  }

  if (result.status === "FAILED") {
    await rpc("clinical_document_signing_failed", {
      p_actor: userId,
      p_doc: doc.id,
      p_code: result.code,
      p_cancelled: false,
      ...audit(),
    });
    throw new ClinicalError(
      "The signature provider did not sign the document. Please try again.",
      "signing_failed",
    );
  }
  if (result.status === "PENDING") {
    await rpc("clinical_document_set_provider_request", {
      p_actor: userId,
      p_doc: doc.id,
      p_request_id: result.requestId,
    });
    return { status: "SIGNING" as const, redirectUrl: result.redirectUrl ?? null };
  }
  return finalizeSigning({
    doc,
    userId,
    actor: userId,
    provider: i.provider,
    completion: result.completion,
    unsignedPdfHash: unsignedHash,
  });
}

/** Stores the final PDF, records the signature, and issues the document. Used for both sync and webhook completion. */
async function finalizeSigning(i: {
  doc: DocForSigning;
  userId: string;
  actor: string | null;
  provider: string;
  completion: SigningCompletion;
  unsignedPdfHash: string;
}) {
  const { doc, completion } = i;
  const { data: row } = await supabaseAdmin
    .from("signature_providers")
    .select("assurance_level,signature_method")
    .eq("provider", i.provider)
    .maybeSingle();
  if (!row)
    throw new ClinicalError(
      "No enabled and confirmed signature method is available",
      "signature_provider_unavailable",
    );

  const doctor = (doc.source_data_snapshot.doctor ?? {}) as Record<string, string | undefined>;
  const finalPdf =
    completion.signedPdf ??
    (await renderDocumentPdf(
      pdfInput(doc, {
        practitioner: practitionerName(doc),
        registrationNumber: doctor["hpcsa_number"] ?? "",
        assurance: row.assurance_level as AssuranceLevel,
        method: row.signature_method,
        signedAt: completion.signedAt,
        reference: completion.signatureReference,
      }),
    ));
  const check = await validatePdf(finalPdf);
  if (!check.ok) {
    await rpc("clinical_document_signing_failed", {
      p_actor: i.actor,
      p_doc: doc.id,
      p_code: `pdf_${check.reason}`,
      p_cancelled: false,
      ...audit(),
    });
    throw new ClinicalError(
      "The signed document failed validation and was not stored",
      "pdf_invalid",
    );
  }
  const hashAfter = await hashSigned(finalPdf);
  const path = `${doc.member_id}/${doc.id}/${crypto.randomUUID()}.pdf`;
  const up = await storage().upload(path, finalPdf, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (up.error)
    throw new ClinicalError(
      "The document could not be stored. Please try again.",
      "storage_failed",
    );

  try {
    await rpc("clinical_document_complete_signing", {
      p_actor: i.actor,
      p_doc: doc.id,
      p_sig: {
        signature_reference: completion.signatureReference,
        signed_at: completion.signedAt,
        certificate_subject: completion.certificateSubject ?? null,
        certificate_issuer: completion.certificateIssuer ?? null,
        certificate_serial: completion.certificateSerial ?? null,
        hash_after: hashAfter,
        metadata: completion.metadata,
      } as Json,
      ...audit(),
    });
  } catch (err) {
    await storage().remove([path]);
    throw err;
  }
  return issueStored(doc, i.actor, path);
}

async function issueStored(doc: DocForSigning, actor: string | null, path: string) {
  await rpc("clinical_document_issue", {
    p_actor: actor,
    p_doc: doc.id,
    p_pdf_path: path,
    ...audit(),
  });
  void notifyIssued(doc.member_id, doc.id);
  return { status: "ISSUED" as const, redirectUrl: null };
}

/** A SIGNED document whose issue step failed: find the stored file that matches the signature hash and finish. */
export async function retryIssue(userId: string | null, documentId: string) {
  const doc = await loadForSigning(documentId);
  if (doc.status !== "SIGNED")
    throw new ClinicalError(
      "That action is not available for the document's current status",
      "invalid_transition",
    );
  if (userId) {
    const d = await getMyDoctorProfile(userId);
    if (!d || d.id !== doc.doctor_id)
      throw new ClinicalError("You do not have permission for this action", "forbidden");
  }
  const { data: sig } = await supabaseAdmin
    .from("document_signatures")
    .select("document_hash_after_signature")
    .eq("document_id", documentId)
    .eq("status", "COMPLETED")
    .maybeSingle();
  const { data: files } = await storage().list(`${doc.member_id}/${doc.id}`);
  for (const f of files ?? []) {
    const path = `${doc.member_id}/${doc.id}/${f.name}`;
    const dl = await storage().download(path);
    if (
      dl.data &&
      hashesEqual(
        await sha256Hex(new Uint8Array(await dl.data.arrayBuffer())),
        sig?.document_hash_after_signature,
      )
    )
      return issueStored(doc, userId, path);
  }
  throw new ClinicalError(
    "The signed file could not be found. Please contact support.",
    "storage_failed",
  );
}

/** Webhook completion for an asynchronous provider. Only acts on a document that is waiting on that request. */
export async function completeExternalSigning(requestId: string) {
  const { data: sig } = await supabaseAdmin
    .from("document_signatures")
    .select("document_id,signature_provider,document_hash_before_signature,status")
    .eq("provider_request_id", requestId)
    .eq("status", "PENDING")
    .maybeSingle();
  if (!sig) return { handled: false as const };
  const doc = await loadForSigning(sig.document_id);
  if (doc.status !== "SIGNING") return { handled: false as const };
  const provider = getSignatureProvider(sig.signature_provider);
  const status = await provider.getSigningStatus(requestId);
  if (status.status === "COMPLETED") {
    await finalizeSigning({
      doc,
      userId: "",
      actor: null,
      provider: sig.signature_provider,
      completion: status.completion,
      unsignedPdfHash: sig.document_hash_before_signature,
    });
    return { handled: true as const, status: "ISSUED" };
  }
  if (status.status === "FAILED" || status.status === "CANCELLED") {
    await rpc("clinical_document_signing_failed", {
      p_actor: null,
      p_doc: doc.id,
      p_code: status.status === "FAILED" ? status.code : "cancelled",
      p_cancelled: status.status === "CANCELLED",
      ...audit(),
    });
    return { handled: true as const, status: status.status };
  }
  return { handled: true as const, status: "PENDING" };
}

// ---------------------------------------------------------------------------
// Member
// ---------------------------------------------------------------------------

export type MemberDocumentRow = {
  id: string;
  document_id: string;
  document_type: DocumentType;
  status: string;
  issued_at: string | null;
  expires_at: string | null;
  verification_token: string;
  practitioner: string;
};

export const listMemberDocuments = (userId: string) =>
  rpc<MemberDocumentRow[]>("member_list_documents", { p_user: userId });

/** Audit first, then a 60-second signed URL. The bucket is private and has no client policy. */
export async function openDocument(
  userId: string,
  documentId: string,
  kind: "VIEWED" | "DOWNLOADED",
) {
  const access = await rpc<{ path: string; document_id: string }>("clinical_document_access", {
    p_actor: userId,
    p_doc: documentId,
    p_kind: kind,
    ...audit(),
  });
  const signed = await storage().createSignedUrl(
    access.path,
    SIGNED_URL_SECONDS,
    kind === "DOWNLOADED" ? { download: `${access.document_id}.pdf` } : undefined,
  );
  if (signed.error || !signed.data)
    throw new ClinicalError("We couldn't open that document. Please try again.", "storage_failed");
  return { url: signed.data.signedUrl, expiresInSeconds: SIGNED_URL_SECONDS };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** Best effort: never blocks or fails issuance. Records only that a notification was sent or failed. */
export async function notifyIssued(memberId: string, documentId: string): Promise<void> {
  let ok = false;
  try {
    const key = process.env["RESEND_API_KEY"];
    const from = process.env["DOCUMENT_EMAIL_FROM"];
    if (key && from) {
      const { data } = await supabaseAdmin.auth.admin.getUserById(memberId);
      const to = data.user?.email;
      if (to) {
        const mail = buildDocumentReadyEmail(`${appBaseUrl()}/member/documents`);
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            from,
            to,
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        ok = res.ok;
      }
    }
  } catch {
    ok = false;
  }
  await supabaseAdmin.rpc("clinical_document_log_notification", {
    p_doc: documentId,
    p_ok: ok,
    p_channel: "email",
  });
}

// ---------------------------------------------------------------------------
// Administration (admin only; checked again by every database function)
// ---------------------------------------------------------------------------

export type AdminDocumentRow = {
  id: string;
  document_id: string;
  document_type: DocumentType;
  status: string;
  practitioner: string;
  member_ref: string;
  template_version: number;
  document_version: number;
  created_at: string;
  issued_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  signature_status: string | null;
  assurance: string | null;
};

export const adminListDocuments = (userId: string, status: string | null) =>
  rpc<AdminDocumentRow[]>("clinical_document_admin_list", {
    p_actor: userId,
    p_status: status,
    p_limit: 200,
  });
export const adminListEvents = (userId: string) =>
  rpc<EventRow[]>("clinical_document_admin_events", { p_actor: userId, p_limit: 300 });

export async function adminOverview(userId: string) {
  // Reading through the caller's own (RLS-limited) rights is not possible from the service client, so the
  // admin role is asserted by the first function call; the table reads below are configuration only.
  await rpc("clinical_document_admin_list", { p_actor: userId, p_status: null, p_limit: 1 });
  const [doctors, providers, policy, retention, verifications] = await Promise.all([
    supabaseAdmin.from("doctor_profiles").select(DOCTOR_COLUMNS).order("last_name"),
    supabaseAdmin
      .from("signature_providers")
      .select(
        "provider,display_name,assurance_level,signature_method,enabled,confirmed_at,confirmation_note",
      ),
    supabaseAdmin
      .from("document_signature_policy")
      .select("document_type,required_assurance,confirmed_at,confirmation_note"),
    supabaseAdmin
      .from("clinical_retention_policy")
      .select("record_class,proposed_min_years,basis,status,purge_enabled"),
    supabaseAdmin
      .from("document_verifications")
      .select("verification_status,verified_at,document_id")
      .order("verified_at", { ascending: false })
      .limit(100),
  ]);
  return {
    doctors: unwrap<DoctorProfileRow[]>(doctors),
    providers: unwrap<
      {
        provider: string;
        display_name: string;
        assurance_level: AssuranceLevel;
        signature_method: string;
        enabled: boolean;
        confirmed_at: string | null;
        confirmation_note: string | null;
      }[]
    >(providers),
    policy: unwrap<
      {
        document_type: DocumentType;
        required_assurance: AssuranceLevel;
        confirmed_at: string | null;
        confirmation_note: string | null;
      }[]
    >(policy),
    retention: unwrap<
      {
        record_class: string;
        proposed_min_years: number;
        basis: string;
        status: string;
        purge_enabled: boolean;
      }[]
    >(retention),
    verifications:
      unwrap<{ verification_status: string; verified_at: string; document_id: string }[]>(
        verifications,
      ),
  };
}

export const adminSaveDoctor = (
  userId: string,
  targetUserId: string,
  data: Record<string, string | boolean | null>,
) => rpc("doctor_admin_upsert", { p_actor: userId, p_user_id: targetUserId, p_data: data as Json });

export const adminSetDoctorStatus = (
  userId: string,
  i: {
    doctorId: string;
    status: string;
    note: string | null;
    prescribing: boolean;
    signatureStatus: string | null;
    signatureProvider: string | null;
    signatureProviderRef: string | null;
  },
) =>
  rpc("doctor_admin_set_status", {
    p_actor: userId,
    p_doctor_id: i.doctorId,
    p_status: i.status,
    p_note: i.note,
    p_prescribing_authorised: i.prescribing,
    p_signature_status: i.signatureStatus,
    p_signature_provider: i.signatureProvider,
    p_signature_provider_ref: i.signatureProviderRef,
  });

export const adminAssignPatient = (
  userId: string,
  i: { doctorId: string; memberId: string; assign: boolean },
) =>
  rpc("doctor_assign_patient", {
    p_actor: userId,
    p_doctor_id: i.doctorId,
    p_member_id: i.memberId,
    p_assign: i.assign,
  });

export const adminSetProvider = (
  userId: string,
  i: { provider: string; assurance: AssuranceLevel; enabled: boolean; note: string },
) =>
  rpc("signature_provider_set", {
    p_actor: userId,
    p_provider: i.provider,
    p_assurance: i.assurance,
    p_enabled: i.enabled,
    p_note: i.note,
  });

export const adminSetPolicy = (
  userId: string,
  i: { type: DocumentType; required: AssuranceLevel; note: string },
) =>
  rpc("signature_policy_set", {
    p_actor: userId,
    p_type: i.type,
    p_required: i.required,
    p_note: i.note,
  });

/** Members an administrator can assign to a practitioner: names only (no health or ID data). */
export async function adminSearchMembers(userId: string, query: string) {
  await rpc("clinical_document_admin_list", { p_actor: userId, p_status: null, p_limit: 1 });
  const q = query
    .trim()
    .replace(/[%_,()]/g, " ")
    .slice(0, 60);
  let req = supabaseAdmin.from("profiles").select("id,full_name").order("full_name").limit(25);
  if (q) req = req.ilike("full_name", `%${q}%`);
  return unwrap<{ id: string; full_name: string | null }[]>(await req);
}

/** Moves overdue documents to EXPIRED (cron). */
export const expireDueDocuments = () => rpc<number>("clinical_document_expire_due", {});
