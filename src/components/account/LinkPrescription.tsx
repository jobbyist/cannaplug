import { useEffect, useState } from "react";
import { FileCheck2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  linkPrescriptionToOrderFn,
  listLinkablePrescriptionsFn,
} from "@/lib/clinical/clinical.functions";

type Rx = Awaited<ReturnType<typeof listLinkablePrescriptionsFn>>[number];
const date = (iso: string) =>
  new Date(iso).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });

/**
 * Lets a member attach one of their own valid prescriptions to an open order, so staff can see the order is
 * covered (number and expiry only). Shown only when the member has a valid prescription.
 */
export function LinkPrescription({
  orderId,
  onDone,
}: {
  orderId: string;
  onDone: (msg: string) => void;
}) {
  const [options, setOptions] = useState<Rx[]>([]);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listLinkablePrescriptionsFn()
      .then((r) => {
        setOptions(r);
        setChoice(r[0]?.prescription_id ?? "");
      })
      .catch(() => setOptions([]));
  }, []);
  if (options.length === 0) return null;
  const link = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await linkPrescriptionToOrderFn({
        data: { orderId, prescriptionId: choice, key: crypto.randomUUID() },
      });
      onDone(`Prescription ${r.document_number} is linked to this order.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link the prescription.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-3 text-xs">
      <FileCheck2 size={14} className="text-primary" />
      <span>Covered by a prescription?</span>
      <select
        className="h-8 rounded-md border border-input bg-background px-2"
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
        aria-label="Prescription"
      >
        {options.map((o) => (
          <option key={o.prescription_id} value={o.prescription_id}>
            {o.document_number} · valid until {date(o.valid_until)}
          </option>
        ))}
      </select>
      <Button size="sm" variant="outline" disabled={busy || !choice} onClick={() => void link()}>
        {busy ? "Linking…" : "Link to this order"}
      </Button>
      {error && <span className="w-full text-destructive">{error}</span>}
    </div>
  );
}
