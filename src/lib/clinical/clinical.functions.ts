import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyClinicalError } from "@/lib/clinical/logic";
import * as docs from "@/lib/clinical/documents-data.server";

/**
 * Server-function boundary for clinical documents. The acting user always comes from the verified JWT and
 * is passed to the database functions, which decide who may do what. The browser never supplies an actor,
 * a hash to trust, a signature level, a status, or a storage path.
 */

const uuid = z.string().uuid();
const key = z.string().min(8).max(120);
const docType = z.enum(["MEDICAL_LETTER", "PRESCRIPTION_ORDER"]);
const assurance = z.enum(["SIMPLE", "ADVANCED", "QUALIFIED"]);
const text = (max: number) => z.string().trim().max(max);

const clinicalFields = z
  .object({
    statement: text(4000).optional(),
    indication_summary: text(4000).optional(),
    treatment_summary: text(4000).optional(),
  })
  .strict();

// The practitioner types every value. Numbers are validated as numbers; nothing is defaulted here.
const prescriptionFields = z
  .object({
    medicine_name: text(200).nullish(),
    generic_name: text(200).nullish(),
    dosage_form: text(100).nullish(),
    strength: text(100).nullish(),
    quantity_numeric: z.number().finite().positive().lt(100000).nullish(),
    quantity_words: text(200).nullish(),
    directions: text(1000).nullish(),
    route: text(100).nullish(),
    frequency: text(200).nullish(),
    duration: text(200).nullish(),
    repeats: z.number().int().min(0).max(99).nullish(),
    indication: text(500).nullish(),
    special_instructions: text(1000).nullish(),
  })
  .strict();

const templateSchema = z.object({
  placeholders: z
    .array(
      z
        .object({
          key: z.string().max(60),
          required: z.boolean().optional(),
          clinical: z.boolean().optional(),
          label: z.string().max(80).optional(),
        })
        .strict(),
    )
    .max(60),
});

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw friendlyClinicalError(err);
  }
}

const auth = [requireSupabaseAuth] as const;

// ------------------------------------------------------------------ practitioner

export const getDoctorHomeFn = createServerFn({ method: "GET" })
  .middleware([...auth])
  .handler(({ context }) => run(() => docs.getMyDoctorProfile(context.userId)));

export const updateDoctorProfileFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) =>
    z
      .object({
        practice_name: text(200).nullish(),
        practice_address: text(400).nullish(),
        practice_phone: text(40).nullish(),
        practice_email: text(200).nullish(),
      })
      .strict()
      .parse(d),
  )
  .handler(({ context, data }) =>
    run(() =>
      docs.updateMyDoctorProfile(
        context.userId,
        Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as Record<
          string,
          string | null
        >,
      ),
    ),
  );

export const listPatientsFn = createServerFn({ method: "GET" })
  .middleware([...auth])
  .handler(({ context }) => run(() => docs.listMyPatients(context.userId)));

export const listDoctorDocumentsFn = createServerFn({ method: "GET" })
  .middleware([...auth])
  .handler(({ context }) => run(() => docs.listMyDocuments(context.userId)));

export const listDoctorAuditFn = createServerFn({ method: "GET" })
  .middleware([...auth])
  .handler(({ context }) => run(() => docs.listMyAuditEvents(context.userId)));

export const listTemplatesFn = createServerFn({ method: "GET" })
  .middleware([...auth])
  .handler(({ context }) => run(() => docs.listTemplates(context.userId)));

export const signingOptionsFn = createServerFn({ method: "GET" })
  .middleware([...auth])
  .validator((d) => z.object({ type: docType }).parse(d))
  .handler(({ context, data }) => run(() => docs.getSigningOptions(context.userId, data.type)));

export const createDocumentFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) =>
    z
      .object({
        type: docType,
        memberId: uuid,
        templateId: uuid,
        clinical: clinicalFields.nullish(),
        prescription: prescriptionFields.nullish(),
        expiresAt: z.string().datetime({ offset: true }).nullish(),
        supersedes: uuid.nullish(),
        key,
      })
      .parse(d),
  )
  .handler(({ context, data }) =>
    run(() =>
      docs.createDocument(context.userId, {
        type: data.type,
        memberId: data.memberId,
        templateId: data.templateId,
        clinical: (data.clinical ?? null) as Record<string, string> | null,
        prescription: data.prescription ?? null,
        expiresAt: data.expiresAt ?? null,
        supersedes: data.supersedes ?? null,
        key: data.key,
      }),
    ),
  );

export const updateDraftFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) =>
    z
      .object({
        documentId: uuid,
        clinical: clinicalFields.nullish(),
        prescription: prescriptionFields.nullish(),
        setExpiry: z.boolean().default(false),
        expiresAt: z.string().datetime({ offset: true }).nullish(),
      })
      .parse(d),
  )
  .handler(({ context, data }) =>
    run(() =>
      docs.updateDraft(context.userId, {
        documentId: data.documentId,
        clinical: (data.clinical ?? null) as Record<string, string> | null,
        prescription: data.prescription ?? null,
        setExpiry: data.setExpiry,
        expiresAt: data.expiresAt ?? null,
      }),
    ),
  );

export const submitForReviewFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) => z.object({ documentId: uuid }).parse(d))
  .handler(({ context, data }) => run(() => docs.submitForReview(context.userId, data.documentId)));

export const getDoctorViewFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) => z.object({ documentId: uuid }).parse(d))
  .handler(({ context, data }) => run(() => docs.getDoctorView(context.userId, data.documentId)));

export const decideDocumentFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) =>
    z
      .object({
        documentId: uuid,
        decision: z.enum(["approve", "reject", "request_changes"]),
        expectedHash: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullish(),
        note: text(1000).nullish(),
      })
      .parse(d),
  )
  .handler(({ context, data }) =>
    run(() =>
      docs.decideDocument(context.userId, {
        documentId: data.documentId,
        decision: data.decision,
        expectedHash: data.expectedHash ?? null,
        note: data.note ?? null,
      }),
    ),
  );

export const signDocumentFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) =>
    z
      .object({
        documentId: uuid,
        expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
        provider: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
      })
      .parse(d),
  )
  .handler(({ context, data }) => run(() => docs.signDocument(context.userId, data)));

export const retryIssueFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) => z.object({ documentId: uuid }).parse(d))
  .handler(({ context, data }) => run(() => docs.retryIssue(context.userId, data.documentId)));

export const voidDocumentFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) => z.object({ documentId: uuid, reason: text(500).min(3) }).parse(d))
  .handler(({ context, data }) =>
    run(() => docs.voidDocument(context.userId, data.documentId, data.reason)),
  );

export const revokeDocumentFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) => z.object({ documentId: uuid, reason: text(500).min(3) }).parse(d))
  .handler(({ context, data }) =>
    run(() => docs.revokeDocument(context.userId, data.documentId, data.reason)),
  );

export const openDocumentFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) => z.object({ documentId: uuid, kind: z.enum(["VIEWED", "DOWNLOADED"]) }).parse(d))
  .handler(({ context, data }) =>
    run(() => docs.openDocument(context.userId, data.documentId, data.kind)),
  );

// ------------------------------------------------------------------ member

export const listMemberDocumentsFn = createServerFn({ method: "GET" })
  .middleware([...auth])
  .handler(({ context }) => run(() => docs.listMemberDocuments(context.userId)));

// ------------------------------------------------------------------ templates (practitioner or admin; the database decides)

export const createTemplateFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) =>
    z
      .object({
        type: docType,
        name: text(120).min(2),
        content: z.string().min(20).max(20000),
        schema: templateSchema,
        note: text(500).nullish(),
      })
      .parse(d),
  )
  .handler(({ context, data }) =>
    run(() => docs.createTemplate(context.userId, { ...data, note: data.note ?? null })),
  );

export const updateTemplateDraftFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) =>
    z
      .object({
        templateId: uuid,
        content: z.string().min(20).max(20000),
        schema: templateSchema,
        note: text(500).nullish(),
      })
      .parse(d),
  )
  .handler(({ context, data }) =>
    run(() => docs.updateTemplateDraft(context.userId, { ...data, note: data.note ?? null })),
  );

export const newTemplateVersionFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) =>
    z
      .object({
        templateId: uuid,
        content: z.string().min(20).max(20000).nullish(),
        schema: templateSchema.nullish(),
        note: text(500).nullish(),
      })
      .parse(d),
  )
  .handler(({ context, data }) =>
    run(() =>
      docs.newTemplateVersion(context.userId, {
        templateId: data.templateId,
        content: data.content ?? null,
        schema: data.schema ?? null,
        note: data.note ?? null,
      }),
    ),
  );

export const submitTemplateFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) => z.object({ templateId: uuid }).parse(d))
  .handler(({ context, data }) => run(() => docs.submitTemplate(context.userId, data.templateId)));

export const decideTemplateFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) =>
    z
      .object({
        templateId: uuid,
        approve: z.boolean(),
        note: text(500).nullish(),
        effectiveUntil: z.string().datetime({ offset: true }).nullish(),
      })
      .parse(d),
  )
  .handler(({ context, data }) =>
    run(() =>
      docs.decideTemplate(context.userId, {
        templateId: data.templateId,
        approve: data.approve,
        note: data.note ?? null,
        effectiveUntil: data.effectiveUntil ?? null,
      }),
    ),
  );

export const retireTemplateFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) =>
    z.object({ templateId: uuid, revoke: z.boolean(), note: text(500).nullish() }).parse(d),
  )
  .handler(({ context, data }) =>
    run(() =>
      docs.retireTemplate(context.userId, {
        templateId: data.templateId,
        revoke: data.revoke,
        note: data.note ?? null,
      }),
    ),
  );

// ------------------------------------------------------------------ administration

export const adminOverviewFn = createServerFn({ method: "GET" })
  .middleware([...auth])
  .handler(({ context }) => run(() => docs.adminOverview(context.userId)));

export const adminListDocumentsFn = createServerFn({ method: "GET" })
  .middleware([...auth])
  .validator((d) => z.object({ status: z.string().max(30).nullish() }).parse(d ?? {}))
  .handler(({ context, data }) =>
    run(() => docs.adminListDocuments(context.userId, data.status ?? null)),
  );

export const adminListEventsFn = createServerFn({ method: "GET" })
  .middleware([...auth])
  .handler(({ context }) => run(() => docs.adminListEvents(context.userId)));

export const adminSearchMembersFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) => z.object({ query: z.string().max(60) }).parse(d))
  .handler(({ context, data }) => run(() => docs.adminSearchMembers(context.userId, data.query)));

export const adminSaveDoctorFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) =>
    z
      .object({
        userId: uuid,
        first_name: text(100).optional(),
        last_name: text(100).optional(),
        title: text(30).optional(),
        hpcsa_number: text(30).nullish(),
        practice_number: text(30).nullish(),
        qualification: text(200).nullish(),
        speciality: text(200).nullish(),
        practice_name: text(200).nullish(),
        practice_address: text(400).nullish(),
        practice_phone: text(40).nullish(),
        practice_email: text(200).nullish(),
        is_active: z.boolean().optional(),
      })
      .strict()
      .parse(d),
  )
  .handler(({ context, data }) => {
    const { userId, ...rest } = data;
    return run(() =>
      docs.adminSaveDoctor(
        context.userId,
        userId,
        Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Record<
          string,
          string | boolean | null
        >,
      ),
    );
  });

export const adminSetDoctorStatusFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) =>
    z
      .object({
        doctorId: uuid,
        status: z.enum(["pending", "verified", "suspended", "revoked"]),
        note: text(500).nullish(),
        prescribing: z.boolean().default(false),
        signatureStatus: z.enum(["not_enrolled", "enrolled", "suspended"]).nullish(),
        signatureProvider: z
          .string()
          .regex(/^[a-z][a-z0-9_]{1,40}$/)
          .nullish(),
        signatureProviderRef: text(200).nullish(),
      })
      .parse(d),
  )
  .handler(({ context, data }) =>
    run(() =>
      docs.adminSetDoctorStatus(context.userId, {
        doctorId: data.doctorId,
        status: data.status,
        note: data.note ?? null,
        prescribing: data.prescribing,
        signatureStatus: data.signatureStatus ?? null,
        signatureProvider: data.signatureProvider ?? null,
        signatureProviderRef: data.signatureProviderRef ?? null,
      }),
    ),
  );

export const adminAssignPatientFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) => z.object({ doctorId: uuid, memberId: uuid, assign: z.boolean() }).parse(d))
  .handler(({ context, data }) => run(() => docs.adminAssignPatient(context.userId, data)));

export const adminSetProviderFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) =>
    z
      .object({
        provider: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
        assurance,
        enabled: z.boolean(),
        note: text(1000),
      })
      .parse(d),
  )
  .handler(({ context, data }) => run(() => docs.adminSetProvider(context.userId, data)));

export const adminSetPolicyFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) => z.object({ type: docType, required: assurance, note: text(1000) }).parse(d))
  .handler(({ context, data }) => run(() => docs.adminSetPolicy(context.userId, data)));

// ------------------------------------------------------------------ document requests

export const listMyRequestsFn = createServerFn({ method: "GET" })
  .middleware([...auth])
  .handler(({ context }) => run(() => docs.listMyRequests(context.userId)));

export const createMyRequestFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) => z.object({ type: docType, note: text(500).nullish(), key }).parse(d))
  .handler(({ context, data }) =>
    run(() =>
      docs.createMyRequest(context.userId, {
        type: data.type,
        note: data.note || null,
        key: data.key,
      }),
    ),
  );

export const cancelMyRequestFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) => z.object({ requestId: uuid }).parse(d))
  .handler(({ context, data }) => run(() => docs.cancelMyRequest(context.userId, data.requestId)));

export const adminListRequestsFn = createServerFn({ method: "GET" })
  .middleware([...auth])
  .validator((d) => z.object({ status: z.string().max(20).nullish() }).parse(d ?? {}))
  .handler(({ context, data }) =>
    run(() => docs.adminListRequests(context.userId, data.status ?? null)),
  );

export const adminCreateRequestFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) =>
    z
      .object({
        memberId: uuid,
        type: docType,
        doctorId: uuid.nullish(),
        reference: text(200).nullish(),
        key,
      })
      .parse(d),
  )
  .handler(({ context, data }) =>
    run(() =>
      docs.adminCreateRequest(context.userId, {
        memberId: data.memberId,
        type: data.type,
        doctorId: data.doctorId ?? null,
        reference: data.reference || null,
        key: data.key,
      }),
    ),
  );

export const adminAssignRequestFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) => z.object({ requestId: uuid, doctorId: uuid }).parse(d))
  .handler(({ context, data }) =>
    run(() => docs.adminAssignRequest(context.userId, data.requestId, data.doctorId)),
  );

export const declineRequestFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) => z.object({ requestId: uuid, reason: text(500).min(3) }).parse(d))
  .handler(({ context, data }) =>
    run(() => docs.declineRequest(context.userId, data.requestId, data.reason)),
  );

export const listDoctorRequestsFn = createServerFn({ method: "GET" })
  .middleware([...auth])
  .handler(({ context }) => run(() => docs.listDoctorRequests(context.userId)));

export const linkRequestDocumentFn = createServerFn({ method: "POST" })
  .middleware([...auth])
  .validator((d) => z.object({ requestId: uuid, documentId: uuid }).parse(d))
  .handler(({ context, data }) =>
    run(() => docs.linkRequestDocument(context.userId, data.requestId, data.documentId)),
  );
