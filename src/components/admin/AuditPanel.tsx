import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { listAuditEventsFn } from "@/lib/payments.functions";

type Rows = Awaited<ReturnType<typeof listAuditEventsFn>>;
const GROUPS = [
  ["", "Everything"],
  ["pos_", "POS"],
  ["order_", "Orders"],
  ["eft_", "EFT"],
  ["payment_", "Payments"],
  ["role_", "Roles"],
  ["id_verification", "ID checks"],
  ["stock_", "Stock"],
] as const;
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-ZA", { dateStyle: "short", timeStyle: "medium" });

/** Manager-only, read-only. The log itself is append-only in the database. */
export function AuditPanel() {
  const [rows, setRows] = useState<Rows | null>(null);
  const [group, setGroup] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setRows(
        await listAuditEventsFn({
          data: { ...(group ? { actionPrefix: group } : {}), limit: 150 },
        }),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the audit log.");
    }
  }, [group]);
  useEffect(() => void load(), [load]);

  if (error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {error} (The audit log is visible to managers and admins.)
      </p>
    );
  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-display text-xl font-extrabold uppercase">Audit log</h1>
      <p className="text-xs text-muted-foreground">
        Every staff and till action is recorded with who did it. Entries cannot be edited or
        deleted.
      </p>
      <div className="flex flex-wrap gap-2">
        {GROUPS.map(([prefix, label]) => (
          <Button
            key={label}
            size="sm"
            variant={group === prefix ? "default" : "outline"}
            onClick={() => setGroup(prefix)}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="p-2">When</th>
              <th className="p-2">Who</th>
              <th className="p-2">Action</th>
              <th className="p-2">Detail</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.id} className="border-t border-border align-top">
                <td className="whitespace-nowrap p-2">{when(r.created_at)}</td>
                <td className="p-2">
                  {r.actor_name ?? (r.actor_user_id ? r.actor_user_id.slice(0, 8) : "system")}
                </td>
                <td className="p-2">
                  <Badge variant="secondary">{r.action.replaceAll("_", " ")}</Badge>
                </td>
                <td
                  className="max-w-[420px] truncate p-2 font-mono text-[0.65rem] text-muted-foreground"
                  title={JSON.stringify(r.metadata)}
                >
                  {JSON.stringify(r.metadata)}
                </td>
              </tr>
            ))}
            {rows && rows.length === 0 && (
              <tr>
                <td className="p-3 text-muted-foreground" colSpan={4}>
                  No events.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
