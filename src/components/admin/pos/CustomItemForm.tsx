import { useState, type FormEvent } from "react";
import { PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { customItemProblem, customLine, parseCents, type CartLine } from "./pos-logic";

/**
 * "Custom item" on the till: type a name and price for something that isn't in the product list. It is added to this
 * sale only; it is never saved as a product and never counts against stock. The database checks it again and records
 * who sold it.
 */
export function CustomItemForm({ onAdd }: { onAdd: (line: CartLine) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("1");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setPrice("");
    setQty("1");
    setError(null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = customItemProblem(name, price);
    if (problem) return setError(problem);
    const q = Number(qty);
    if (!Number.isInteger(q) || q < 1 || q > 9999) return setError("Quantity must be 1 or more.");
    onAdd(customLine(name, parseCents(price)!, q));
    reset();
    setOpen(false);
  };

  if (!open)
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mb-3"
        onClick={() => setOpen(true)}
      >
        <PencilLine size={14} /> Custom item
      </Button>
    );
  return (
    <form
      onSubmit={submit}
      className="mb-3 grid gap-2 rounded-lg border border-dashed border-border p-3"
      aria-label="Custom item"
    >
      <p className="text-xs text-muted-foreground">
        For something that isn&apos;t in the product list. It is added to this sale only and is not
        saved as a product.
      </p>
      <div className="grid gap-2 sm:grid-cols-[1fr_8rem_5rem]">
        <div className="grid gap-1">
          <Label htmlFor="pos-custom-name">Item name</Label>
          <Input
            id="pos-custom-name"
            autoFocus
            maxLength={80}
            placeholder="e.g. Gift wrapping"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="pos-custom-price">Price (R)</Label>
          <Input
            id="pos-custom-price"
            inputMode="decimal"
            placeholder="0.00"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="pos-custom-qty">Qty</Label>
          <Input
            id="pos-custom-qty"
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          Add to sale
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            reset();
            setOpen(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
