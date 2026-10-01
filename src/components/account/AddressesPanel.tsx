import { useState, type FormEvent } from "react";
import { MapPin, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { deleteAddressFn, saveAddressFn, setDefaultAddressFn } from "@/lib/member.functions";
import type { MemberAccount } from "@/lib/member-data.server";

type Address = MemberAccount["addresses"][number];

const EMPTY = {
  label: "Home",
  recipient_name: "",
  phone: "",
  line1: "",
  line2: "",
  suburb: "",
  city: "",
  province: "",
  postal_code: "",
  delivery_notes: "",
};
type Draft = typeof EMPTY;

const toDraft = (a: Address): Draft => ({
  label: a.label,
  recipient_name: a.recipient_name ?? "",
  phone: a.phone ?? "",
  line1: a.line1,
  line2: a.line2 ?? "",
  suburb: a.suburb ?? "",
  city: a.city ?? "",
  province: a.province ?? "",
  postal_code: a.postal_code ?? "",
  delivery_notes: a.delivery_notes ?? "",
});

export function AddressesPanel({
  account,
  reload,
}: {
  account: MemberAccount;
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const ok = await run(() =>
      saveAddressFn({
        data: { addressId: editing.id, address: editing.draft, makeDefault },
      }),
    );
    if (ok) setEditing(null);
  };

  const field = (key: keyof Draft, label: string, props: { required?: boolean } = {}) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`addr-${key}`}>{label}</Label>
      <Input
        id={`addr-${key}`}
        value={editing?.draft[key] ?? ""}
        required={props.required ?? false}
        onChange={(e) =>
          setEditing((prev) =>
            prev ? { ...prev, draft: { ...prev.draft, [key]: e.target.value } } : prev,
          )
        }
      />
    </div>
  );

  return (
    <div className="max-w-2xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-display text-lg font-bold uppercase">Delivery addresses</h2>
        {!editing && (
          <Button
            size="sm"
            onClick={() => {
              setMakeDefault(account.addresses.length === 0);
              setEditing({ id: null, draft: EMPTY });
            }}
            disabled={account.addresses.length >= 10}
          >
            <Plus size={14} className="mr-1.5" /> Add address
          </Button>
        )}
      </div>
      {error && (
        <p className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {editing && (
        <form
          onSubmit={(e) => void submit(e)}
          className="mb-6 grid gap-4 rounded-xl border border-border bg-card p-6"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {field("label", "Label (e.g. Home, Work)", { required: true })}
            {field("recipient_name", "Recipient name")}
            {field("phone", "Contact number")}
            {field("line1", "Street address", { required: true })}
            {field("line2", "Apartment, unit, building")}
            {field("suburb", "Suburb")}
            {field("city", "City")}
            {field("province", "Province")}
            {field("postal_code", "Postal code")}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="addr-delivery_notes">Delivery notes</Label>
            <Textarea
              id="addr-delivery_notes"
              rows={2}
              value={editing.draft.delivery_notes}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  draft: { ...editing.draft, delivery_notes: e.target.value },
                })
              }
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={makeDefault}
              onChange={(e) => setMakeDefault(e.target.checked)}
            />
            Use as my default address
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save address"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {account.addresses.length === 0 && !editing ? (
        <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
          No saved addresses yet. Add one to speed up checkout.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {account.addresses.map((a) => (
            <div key={a.id} className="rounded-xl border border-border bg-card p-5">
              <div className="mb-2 flex items-center justify-between">
                <p className="flex items-center gap-1.5 text-sm font-semibold">
                  <MapPin size={14} className="text-primary" /> {a.label}
                </p>
                {a.is_default && <Badge>Default</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">
                {[a.recipient_name, a.line1, a.line2, a.suburb, a.city, a.province, a.postal_code]
                  .filter(Boolean)
                  .join(", ")}
              </p>
              {a.delivery_notes && (
                <p className="mt-1 text-xs italic text-muted-foreground">{a.delivery_notes}</p>
              )}
              <div className="mt-3 flex items-center gap-1">
                <button
                  type="button"
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Edit address"
                  onClick={() => {
                    setMakeDefault(a.is_default);
                    setEditing({ id: a.id, draft: toDraft(a) });
                  }}
                >
                  <Pencil size={14} />
                </button>
                {!a.is_default && (
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label="Make default"
                    title="Make default"
                    onClick={() =>
                      void run(() => setDefaultAddressFn({ data: { addressId: a.id } }))
                    }
                  >
                    <Star size={14} />
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                  aria-label="Delete address"
                  onClick={() => void run(() => deleteAddressFn({ data: { addressId: a.id } }))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
