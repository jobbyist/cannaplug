import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";
import { ID_BUCKET } from "@/lib/verification-logic";
import { friendlyMemberError } from "@/lib/member-logic";
import type { AccountAction, AccountState } from "@/lib/account-lifecycle";

/**
 * Members close their own account (deactivate now, or ask for deletion); an admin completes a deletion.
 * Every rule lives in the database (open orders, staff accounts, who may delete, what is anonymised, the audit row).
 * The browser sends only the action and an idempotency key: never a user id.
 */

export async function getAccountState(userId: string): Promise<AccountState> {
  const { data, error } = await supabaseAdmin.rpc("member_account_state", { p_user: userId });
  if (error) throw friendlyMemberError(error);
  return data as unknown as AccountState;
}

export async function setAccountStatus(userId: string, action: AccountAction, key: string) {
  const { data, error } = await supabaseAdmin.rpc("member_account_set_status", {
    p_user: userId,
    p_action: action,
    p_idempotency_key: key,
  });
  if (error) throw friendlyMemberError(error);
  return data as unknown as AccountState;
}

export type DeleteAccountResult = {
  deleted: true;
  kept: { orders: number; medical_documents: number };
  /** Follow-up steps that did not finish; the account is already anonymised in the database. */
  warnings: string[];
};

/**
 * Admin: complete a deletion. The database anonymises the member and returns what outside systems still hold:
 * the ID photos in private storage are removed, and the sign-in email is replaced and the login blocked so the
 * kept rows (orders, receipts, clinical records) no longer identify anyone.
 */
export async function deleteMemberAccount(
  actorId: string,
  memberId: string,
  reason: string,
  key: string,
): Promise<DeleteAccountResult> {
  await assertRole(actorId, "admin");
  const { data, error } = await supabaseAdmin.rpc("admin_account_delete", {
    p_actor: actorId,
    p_user: memberId,
    p_reason: reason,
    p_idempotency_key: key,
  });
  if (error) throw error;
  const r = data as unknown as {
    email_placeholder: string;
    id_document_paths: string[];
    kept: { orders: number; medical_documents: number };
    replayed?: boolean;
  };

  const warnings: string[] = [];
  try {
    // The recorded paths, plus anything else left in the member's own folder.
    const store = supabaseAdmin.storage.from(ID_BUCKET);
    const paths = new Set<string>(r.id_document_paths ?? []);
    const listed = await store.list(memberId, { limit: 100 });
    if (listed.error) throw listed.error;
    for (const f of listed.data ?? []) if (f.name) paths.add(`${memberId}/${f.name}`);
    if (paths.size > 0) {
      const removed = await store.remove([...paths]);
      if (removed.error) throw removed.error;
    }
  } catch {
    warnings.push("The ID photos could not be removed from storage. Remove them by hand.");
  }
  try {
    const res = await supabaseAdmin.auth.admin.updateUserById(memberId, {
      email: r.email_placeholder,
      email_confirm: true,
      user_metadata: {},
      ban_duration: "876000h",
    });
    if (res.error) throw res.error;
  } catch {
    warnings.push("The sign-in could not be blocked. Block this user in the Supabase dashboard.");
  }
  return { deleted: true, kept: r.kept, warnings };
}
