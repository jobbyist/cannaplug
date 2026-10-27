import { Input } from "@/components/ui/input";
import type { DiscountInput } from "./pos-logic";

/** A percentage-or-rand discount entry. Empty means "no discount". Validation lives in pos-logic and on the server. */
export function DiscountEditor({
  label,
  value,
  onChange,
  invalid,
}: {
  label: string;
  value: DiscountInput | undefined;
  onChange: (next: DiscountInput | undefined) => void;
  invalid?: boolean;
}) {
  const kind = value?.kind ?? "percent";
  return (
    <div className="flex items-center gap-2">
      <select
        aria-label={`${label} type`}
        className="h-8 rounded-md border border-input bg-background px-1.5 text-xs"
        value={kind}
        onChange={(e) =>
          onChange({ kind: e.target.value as DiscountInput["kind"], value: value?.value ?? "" })
        }
      >
        <option value="percent">% off</option>
        <option value="amount">R off</option>
      </select>
      <Input
        aria-label={label}
        aria-invalid={invalid || undefined}
        className="h-8 w-24 text-sm"
        inputMode="decimal"
        placeholder={kind === "percent" ? "e.g. 10" : "e.g. 15.50"}
        value={value?.value ?? ""}
        onChange={(e) => onChange(e.target.value ? { kind, value: e.target.value } : undefined)}
      />
    </div>
  );
}
