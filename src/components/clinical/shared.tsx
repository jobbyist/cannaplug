import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { statusLabel } from "@/lib/clinical/logic";

const VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ISSUED: "default",
  SIGNED: "default",
  APPROVED: "secondary",
  PENDING_DOCTOR_REVIEW: "secondary",
  SIGNING: "secondary",
  DRAFT: "outline",
  EXPIRED: "outline",
  REVOKED: "destructive",
  VOID: "destructive",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={VARIANT[status] ?? "outline"}>{statusLabel(status)}</Badge>;
}

export function Notice({ tone, children }: { tone: "error" | "ok" | "warn"; children: ReactNode }) {
  const cls =
    tone === "error"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : tone === "warn"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
        : "border-primary/30 bg-primary/10 text-foreground";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`mb-4 rounded-lg border px-4 py-3 text-xs ${cls}`}
    >
      {children}
    </div>
  );
}

export const selectClass =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
