import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyMemberError } from "@/lib/member-logic";
import type { UserClient } from "@/lib/member-data.server";
import {
  createIdUpload,
  getMyVerification,
  listVerifications,
  pendingVerificationCount,
  reviewVerification,
  submitVerification,
  viewVerificationDocument,
} from "@/lib/verification-data.server";

/**
 * Server-function boundary for ID verification. The acting user always comes from the verified JWT;
 * a member can only ever act on themselves, and reviewer functions re-check the manager role.
 */

const uuid = z.string().uuid();
const idempotencyKey = z.string().min(8).max(120);

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw friendlyMemberError(err);
  }
}

export const getMyVerificationFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => run(() => getMyVerification(context.supabase as UserClient)));

export const createIdUploadFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) =>
    z
      .object({ mime: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]) })
      .parse(d),
  )
  .handler(({ context, data }) => run(() => createIdUpload(context.userId, data.mime)));

export const submitVerificationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        documentType: z.enum(["sa_id", "passport", "drivers_licence"]),
        path: z.string().min(40).max(120),
        dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        key: idempotencyKey,
      })
      .parse(d),
  )
  .handler(({ context, data }) => run(() => submitVerification(context.userId, data)));

export const listVerificationsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ scope: z.enum(["pending", "decided"]) }).parse(d))
  .handler(({ context, data }) => run(() => listVerifications(context.userId, data.scope)));

export const pendingVerificationCountFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => run(() => pendingVerificationCount(context.userId)));

export const viewVerificationDocumentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ userId: uuid }).parse(d))
  .handler(({ context, data }) => run(() => viewVerificationDocument(context.userId, data.userId)));

export const reviewVerificationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        userId: uuid,
        decision: z.enum(["approve", "reject"]),
        rejectionCode: z
          .enum([
            "unreadable",
            "expired_document",
            "name_mismatch",
            "dob_mismatch",
            "underage",
            "other",
          ])
          .nullable()
          .optional(),
        note: z.string().trim().max(500).nullable().optional(),
        key: idempotencyKey,
      })
      .parse(d),
  )
  .handler(({ context, data }) =>
    run(() =>
      reviewVerification(context.userId, {
        userId: data.userId,
        decision: data.decision,
        rejectionCode: data.rejectionCode ?? null,
        note: data.note ?? null,
        key: data.key,
      }),
    ),
  );
