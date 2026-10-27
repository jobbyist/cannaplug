import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** A whole-number field with − / + buttons and optional one-tap amounts (e.g. +5, +10). */
export function QuantityStepper({
  id,
  value,
  onChange,
  min = 0,
  max = 100000,
  quick = [],
  label,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
  quick?: number[];
  label: string;
}) {
  const n = value === "" ? 0 : Number(value);
  const clamp = (x: number) => String(Math.min(max, Math.max(min, Math.trunc(x))));
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Decrease ${label}`}
          disabled={n <= min}
          onClick={() => onChange(clamp(n - 1))}
        >
          <Minus size={16} />
        </Button>
        <Input
          id={id}
          inputMode="numeric"
          className="h-10 w-28 text-center text-lg font-bold"
          value={value}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, "");
            onChange(digits === "" ? "" : clamp(Number(digits)));
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Increase ${label}`}
          disabled={n >= max}
          onClick={() => onChange(clamp(n + 1))}
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
              onClick={() => onChange(clamp(n + q))}
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
