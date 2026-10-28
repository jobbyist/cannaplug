import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { listCustomersFn } from "@/lib/admin.functions";

export type PickedCustomer = { id: string; name: string };
type Hit = { id: string; full_name: string | null; phone: string | null; email: string | null };

/** Attach a member to a till sale: type a name, phone or email; the database searches (no list is loaded up front). */
export function CustomerPicker({
  value,
  onChange,
}: {
  value: PickedCustomer | null;
  onChange: (c: PickedCustomer | null) => void;
}) {
  const [text, setText] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) {
      setHits([]);
      setState("idle");
      return;
    }
    let alive = true;
    setState("loading");
    const t = setTimeout(() => {
      listCustomersFn({ data: { search: q, limit: 6 } })
        .then((r) => {
          if (!alive) return;
          setHits(r.rows);
          setState("done");
        })
        .catch(() => alive && setState("error"));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [text]);

  if (value)
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm">
        <span className="font-medium">{value.name}</span>
        <button
          type="button"
          aria-label="Remove customer from this sale"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => onChange(null)}
        >
          <X size={14} />
        </button>
      </div>
    );

  return (
    <div className="grid gap-1">
      <Input
        aria-label="Find customer"
        placeholder="Walk-in customer. Type a name, phone or email to attach a member"
        value={text}
        maxLength={100}
        onChange={(e) => setText(e.target.value)}
      />
      {state === "error" && (
        <p role="alert" className="text-[0.68rem] text-destructive">
          Could not search customers. Try again.
        </p>
      )}
      {state === "done" && hits.length === 0 && (
        <p className="text-[0.68rem] text-muted-foreground">No member found.</p>
      )}
      {hits.length > 0 && (
        <ul className="overflow-hidden rounded-md border border-border bg-card text-sm">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted"
                onClick={() => {
                  onChange({ id: h.id, name: h.full_name?.trim() || h.email || h.id.slice(0, 8) });
                  setText("");
                  setHits([]);
                }}
              >
                <span className="font-medium">{h.full_name ?? "Unnamed"}</span>
                <span className="text-xs text-muted-foreground">{h.phone ?? h.email ?? ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
