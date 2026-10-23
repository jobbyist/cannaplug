import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ReceiptView } from "@/components/admin/receipts/ReceiptView";
import { useAuth } from "@/hooks/useAuth";
import { getPosReceiptFn } from "@/lib/receipts.functions";
import type { PaperSize, ReceiptModel } from "@/lib/receipts/receipt-model";

const PAGE: Record<PaperSize, string> = { "80mm": "80mm auto", "58mm": "58mm auto", a4: "A4" };

export const Route = createFileRoute("/admin_/pos/receipt/$saleId")({
  head: () => ({
    meta: [{ title: "Receipt | CannaPlug" }, { name: "robots", content: "noindex" }],
  }),
  validateSearch: z.object({
    paper: z.enum(["80mm", "58mm", "a4"]).catch("80mm"),
    print: z
      .union([z.literal(1), z.literal("1")])
      .optional()
      .catch(undefined),
  }),
  component: ReceiptPage,
});

function ReceiptPage() {
  const { saleId } = Route.useParams();
  const { paper, print } = Route.useSearch();
  const { user, loading } = useAuth();
  const [receipt, setReceipt] = useState<ReceiptModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading || !user) return;
    getPosReceiptFn({ data: { saleId } })
      .then(setReceipt)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the receipt."));
  }, [loading, user, saleId]);

  useEffect(() => {
    if (!receipt || !print) return undefined;
    const t = setTimeout(() => window.print(), 300);
    return () => clearTimeout(t);
  }, [receipt, print]);

  if (!loading && !user) return <p className="p-6 text-sm">Sign in to view receipts.</p>;
  if (error) return <p className="p-6 text-sm">{error}</p>;
  if (!receipt) return <p className="p-6 text-sm">Loading receipt…</p>;
  return (
    <div className="min-h-screen bg-white py-4 print:py-0">
      <style>{`@page { size: ${PAGE[paper]}; margin: ${paper === "a4" ? "15mm" : "3mm"}; }
@media print { body { background: #fff !important; } .no-print { display: none !important; } }`}</style>
      <div className="no-print mb-3 flex justify-center gap-2">
        <button
          type="button"
          className="rounded-md bg-[#0B3D20] px-3 py-1.5 text-sm text-white"
          onClick={() => window.print()}
        >
          Print
        </button>
        <button
          type="button"
          className="rounded-md border px-3 py-1.5 text-sm"
          onClick={() => window.close()}
        >
          Close
        </button>
      </div>
      <ReceiptView receipt={receipt} paper={paper} />
    </div>
  );
}
