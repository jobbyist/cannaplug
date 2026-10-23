import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { clinicalReadinessFn } from "@/lib/clinical/clinical.functions";

type Item = Awaited<ReturnType<typeof clinicalReadinessFn>>[number];

/** What still blocks issuing medical letters and prescriptions, each with the exact action to take (admin only). */
export function ReadinessChecklist() {
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => {
    clinicalReadinessFn()
      .then(setItems)
      .catch(() => setItems(null));
  }, []);
  if (!items) return null;
  const open = items.filter((i) => !i.ok);
  return (
    <section className="rounded-xl border border-border bg-card p-4 text-sm">
      <p className="mb-2 font-semibold">
        {open.length === 0
          ? "Ready to issue documents"
          : `Before documents can be issued: ${open.length} item${open.length === 1 ? "" : "s"} left`}
      </p>
      <ul className="grid gap-1.5">
        {items.map((i) => (
          <li key={i.label} className="flex items-start gap-2">
            {i.ok ? (
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-primary" />
            ) : (
              <CircleAlert size={16} className="mt-0.5 shrink-0 text-amber-600" />
            )}
            <span>
              <span className={i.ok ? "text-muted-foreground" : "font-medium"}>{i.label}</span>
              {!i.ok && <span className="block text-xs text-muted-foreground">{i.action}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
