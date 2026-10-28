import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SearchFocus({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-[#D4AF37]/50 bg-[#D4AF37]/10 px-3 py-2 text-xs">
      <span>
        Showing search result: <b>{label}</b>
      </span>
      <button type="button" className="font-semibold text-primary" onClick={onClear}>
        Show all
      </button>
    </div>
  );
}
