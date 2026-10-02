import type { UserClient } from "@/lib/member-data.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";
import { friendlyMemberError, MemberError } from "@/lib/member-logic";
import {
  ID_BUCKET,
  ID_MAX_ATTEMPTS,
  ID_MAX_BYTES,
  ID_MIME_TO_EXT,
  isOwnUploadPath,
  sniffMime,
  type DocumentType,
} from "@/lib/verification-logic";

/**
 * ID verification data layer.
 *
 *  - Members never touch storage or the verification table directly. The server mints a one-time signed
 *    upload URL for a path inside the member's own folder; the browser uploads straight to the private
 *    bucket; then `submitVerification` checks the stored bytes and records the submission through a
 *    service-only RPC (the 18+ rule, folder ownership, attempt cap and state machine live in the database).
 *  - Reviewers (manager and above) see ID images only through a 60-second signed URL, and the view is
 *    written to the audit log BEFORE the URL is minted.
 */

const SIGNED_VIEW_SECONDS = 60;
const MAX_FILES_PER_MEMBER = 10;

const storage = () => supabaseAdmin.storage.from(ID_BUCKET);

function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw friendlyMemberError(res.error);
  return res.data as T;
}

// ---- Member --------------------------------------------------------------------------------

/** The member's own row, read through RLS + the column grant (no storage path, no declared DOB). */
export async function getMyVerification(db: UserClient) {
  return unwrap(
    await db
      .from("customer_verification")
      .select(
        "status,document_type,submitted_at,reviewed_at,rejection_code,rejection_note,attempt_count",
      )
      .maybeSingle(),
  );
}

export async function createIdUpload(userId: string, mime: string) {
  const ext = ID_MIME_TO_EXT[mime];
  if (!ext) throw new MemberError("Upload a JPG, PNG, WebP or PDF.");

  const { data: row } = await supabaseAdmin
    .from("customer_verification")
    .select("status,attempt_count")
    .eq("user_id", userId)
    .maybeSingle();
  if (row?.status === "verified") throw friendlyMemberError(new Error("already_verified"));
  if (row?.status === "pending") throw friendlyMemberError(new Error("verification_pending"));
  if ((row?.attempt_count ?? 0) >= ID_MAX_ATTEMPTS)
    throw friendlyMemberError(new Error("too_many_attempts"));

  // Bound what an account can leave in storage before it ever submits.
  const { data: existing } = await storage().list(userId, { limit: MAX_FILES_PER_MEMBER + 1 });
  if ((existing?.length ?? 0) >= MAX_FILES_PER_MEMBER)
    throw new MemberError("Too many uploads — please contact CannaPlug support.");

  const path = `${userId}/${crypto.randomUUID()}.${ext}`;
  const { data, error } = await storage().createSignedUploadUrl(path);
  if (error || !data) throw new MemberError("We couldn't start your upload. Please try again.");
  return { path, token: data.token };
}

/** Looks at what is actually stored: size, and the real file type from its first bytes. */
async function inspectUpload(path: string): Promise<string | null> {
  const { data, error } = await storage().download(path);
  if (error || !data) return "We couldn't find your upload — please try again.";
  if (data.size > ID_MAX_BYTES) return "That file is over 5 MB. Upload a smaller photo or scan.";
  const head = new Uint8Array(await data.slice(0, 16).arrayBuffer());
  const detected = sniffMime(head);
  const ext = path.split(".").pop();
  if (!detected || ID_MIME_TO_EXT[detected] !== ext)
    return "That file doesn't look like a JPG, PNG, WebP or PDF.";
  return null;
}

export async function submitVerification(
  userId: string,
  input: { documentType: DocumentType; path: string; dob: string; key: string },
) {
  if (!isOwnUploadPath(userId, input.path))
    throw friendlyMemberError(new Error("invalid_document_path"));
  const problem = await inspectUpload(input.path);
  if (problem) {
    await storage().remove([input.path]);
    throw new MemberError(problem);
  }
  const result = unwrap(
    await supabaseAdmin.rpc("verification_submit", {
      p_user_id: userId,
      p_document_type: input.documentType,
      p_document_path: input.path,
      p_dob: input.dob,
      p_idempotency_key: input.key,
    }),
  );
  // Data minimisation: earlier (rejected / abandoned) uploads are no longer needed.
  const { data: files } = await storage().list(userId, { limit: 100 });
  const stale = (files ?? []).map((f) => `${userId}/${f.name}`).filter((p) => p !== input.path);
  if (stale.length) await storage().remove(stale);
  return result;
}

// ---- Reviewer ------------------------------------------------------------------------------

export type VerificationQueueItem = {
  user_id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  document_type: string | null;
  declared_dob: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  rejection_code: string | null;
  rejection_note: string | null;
  attempt_count: number;
};

export async function listVerifications(
  actor: string,
  scope: "pending" | "decided",
): Promise<VerificationQueueItem[]> {
  await assertRole(actor, "manager");
  const base = supabaseAdmin
    .from("customer_verification")
    .select(
      "user_id,status,document_type,declared_dob,submitted_at,reviewed_at,rejection_code,rejection_note,attempt_count",
    );
  const { data, error } =
    scope === "pending"
      ? await base.eq("status", "pending").order("submitted_at", { ascending: true }).limit(100)
      : await base
          .in("status", ["verified", "rejected"])
          .order("reviewed_at", { ascending: false })
          .limit(50);
  if (error) throw friendlyMemberError(error);
  const rows = data ?? [];
  const ids = rows.map((r) => r.user_id);
  const profiles = ids.length
    ? ((await supabaseAdmin.from("profiles").select("id,full_name,phone").in("id", ids)).data ?? [])
    : [];
  const emails = new Map<string, string | null>();
  await Promise.all(
    ids.map(async (id) => {
      const { data: user } = await supabaseAdmin.auth.admin.getUserById(id);
      emails.set(id, user?.user?.email ?? null);
    }),
  );
  return rows.map((r) => {
    const profile = profiles.find((p) => p.id === r.user_id);
    return {
      ...r,
      full_name: profile?.full_name ?? null,
      phone: profile?.phone ?? null,
      email: emails.get(r.user_id) ?? null,
    };
  });
}

export async function pendingVerificationCount(actor: string): Promise<number> {
  await assertRole(actor, "manager");
  const { count, error } = await supabaseAdmin
    .from("customer_verification")
    .select("user_id", { count: "exact", head: true })
    .eq("status", "pending");
  if (error) throw friendlyMemberError(error);
  return count ?? 0;
}

/** Audit first, then a short-lived URL. A failed audit write means no URL. */
export async function viewVerificationDocument(actor: string, userId: string) {
  const logged = unwrap(
    await supabaseAdmin.rpc("verification_log_document_view", {
      p_actor: actor,
      p_user_id: userId,
    }),
  ) as { path: string; document_type: string };
  const { data, error } = await storage().createSignedUrl(logged.path, SIGNED_VIEW_SECONDS);
  if (error || !data) throw new MemberError("The document could not be opened. Please retry.");
  const isPdf = logged.path.endsWith(".pdf");
  return {
    url: data.signedUrl,
    documentType: logged.document_type,
    isPdf,
    expiresInSeconds: SIGNED_VIEW_SECONDS,
  };
}

export async function reviewVerification(
  actor: string,
  input: {
    userId: string;
    decision: "approve" | "reject";
    rejectionCode: string | null;
    note: string | null;
    key: string;
  },
) {
  return unwrap(
    await supabaseAdmin.rpc("verification_review", {
      p_actor: actor,
      p_user_id: input.userId,
      p_decision: input.decision,
      p_rejection_code: input.rejectionCode,
      p_note: input.note,
      p_idempotency_key: input.key,
    }),
  );
}
