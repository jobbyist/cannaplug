import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";
import type { NoticeAudience, NoticeKind, NoticeStatus } from "@/lib/team-notifications";

export type NoticeInput = {
  title: string;
  body: string;
  kind: NoticeKind;
  audience: NoticeAudience;
  status: NoticeStatus;
  pinned: boolean;
  changeAt: string | null;
  changeTitle: string | null;
  changeBody: string | null;
};

export async function saveNotice(userId: string, id: string | null, n: NoticeInput, key: string) {
  await assertRole(userId, "manager");
  const { data, error } = await supabaseAdmin.rpc("team_notification_save", {
    p_actor: userId,
    p_id: id,
    p_title: n.title,
    p_body: n.body,
    p_kind: n.kind,
    p_min_role: n.audience,
    p_status: n.status,
    p_pinned: n.pinned,
    p_change_at: n.changeAt,
    p_change_title: n.changeTitle,
    p_change_body: n.changeBody,
    p_idempotency_key: key,
  });
  if (error) throw error;
  return data as unknown as { id: string; status: string };
}

export async function markNoticesRead(userId: string, ids: string[]) {
  await assertRole(userId, "budtender");
  const { data, error } = await supabaseAdmin.rpc("team_notification_mark_read", {
    p_actor: userId,
    p_ids: ids,
  });
  if (error) throw error;
  return data as number;
}
