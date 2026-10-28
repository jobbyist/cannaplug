import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { StaffBadge } from "@/components/StaffBadge";
import { searchPosCustomersFn } from "@/lib/pos.functions";

/** `staff` customers get the staff rate automatically (the database decides; this only shows it). */
export type PickedCustomer = { id: string; name: string; staff: boolean };
type Hit = {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  username?: string | null;
  id_status?: string | null;
  is_staff: boolean;
  /** False when this staff member cannot be attached by the person at the till (the database decides). */
  can_attach?: boolean;
  blocked_reason?: string | null;
};

/** Attach a member or a staff member to a till sale: type a name, phone or email; the database searches (no list is loaded up front). */
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
      searchPosCustomersFn({ data: { search: q } })
        .then((r) => {
          if (!alive) return;
          setHits(r as Hit[]);
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
        <span className="flex items-center gap-2 font-medium">
          {value.name}
          {value.staff && <StaffBadge />}
        </span>
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
        placeholder="Walk-in customer. Type a name, phone or email to attach a member or staff member"
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
        <p className="text-[0.68rem] text-muted-foreground">No member or staff member found.</p>
      )}
      {hits.length > 0 && (
        <ul className="overflow-hidden rounded-md border border-border bg-card text-sm">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                disabled={h.can_attach === false}
                title={h.can_attach === false ? (h.blocked_reason ?? undefined) : undefined}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                onClick={() => {
                  onChange({
                    id: h.id,
                    name: h.full_name?.trim() || h.email || h.id.slice(0, 8),
                    staff: h.is_staff,
                  });
                  setText("");
                  setHits([]);
                }}
              >
                <span className="flex flex-col">
                  <span className="flex items-center gap-2 font-medium">
                    {h.full_name ?? "Unnamed"}
                    {h.is_staff && <StaffBadge />}
                    {h.id_status === "provisional" && (
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[0.6rem] font-semibold uppercase text-amber-700">
                        ID provisionally approved
                      </span>
                    )}
                  </span>
                  {h.can_attach === false && h.blocked_reason && (
                    <span className="text-[0.65rem] font-normal text-muted-foreground">
                      {h.blocked_reason}
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {h.username ? `@${h.username}` : (h.phone ?? h.email ?? "")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
