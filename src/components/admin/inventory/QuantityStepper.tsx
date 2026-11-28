import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addQty, cleanQtyInput, roundQty, subQty } from "@/lib/qty";

const toNumber = (v: string) => (v === "" ? 0 : Number(v.replace(",", ".")) || 0);

/**
 * A quantity field with − / + buttons and optional one-tap amounts (e.g. +5, +10). Whole numbers by default; with
 * `decimals` (weighed products, in grams) it takes one decimal place, typed with a point or a comma (27.4 / 27,4).
 */
export function QuantityStepper({
  id,
  value,
  onChange,
  min = 0,
  max = 100000,
  quick = [],
  label,
  decimals = false,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
  quick?: number[];
  label: string;
  decimals?: boolean;
}) {
  const n = toNumber(value);
  const clamp = (x: number) =>
    String(Math.min(max, Math.max(min, decimals ? roundQty(x) : Math.trunc(x))));
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Decrease ${label}`}
          disabled={n <= min}
          onClick={() => onChange(clamp(subQty(n, 1)))}
        >
          <Minus size={16} />
        </Button>
        <Input
          id={id}
          inputMode={decimals ? "decimal" : "numeric"}
          className="h-10 w-28 text-center text-lg font-bold"
          value={value}
          onChange={(e) => {
            const cleaned = cleanQtyInput(e.target.value);
            if (cleaned === "") return onChange("");
            // while typing "27." keep the point; only cap at the most allowed
            onChange(toNumber(cleaned) > max ? String(max) : cleaned);
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Increase ${label}`}
          disabled={n >= max}
          onClick={() => onChange(clamp(addQty(n, 1)))}
        >
          <Plus size={16} />
        </Button>
      </div>
      {quick.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {quick.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onChange(clamp(addQty(n, q)))}
              className="rounded-full border border-border px-2.5 py-0.5 text-xs font-semibold hover:bg-muted"
            >
              +{q}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
