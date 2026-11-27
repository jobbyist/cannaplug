import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { WaiverView } from "@/components/admin/waiver/WaiverView";
import { useAuth } from "@/hooks/useAuth";
import { getReceiptSettingsFn } from "@/lib/receipts.functions";
import { getDabWaiverFn } from "@/lib/waiver.functions";
import type { WaiverRecord } from "@/lib/waiver-data.server";

export const Route = createFileRoute("/admin_/waiver/$waiverId")({
  head: () => ({
    meta: [{ title: "Dab waiver | CannaPlug" }, { name: "robots", content: "noindex" }],
  }),
  component: WaiverPage,
});

type Business = Parameters<typeof WaiverView>[0]["business"];

function WaiverPage() {
  const { waiverId } = Route.useParams();
  const { user, loading } = useAuth();
  const [waiver, setWaiver] = useState<WaiverRecord | null>(null);
  const [business, setBusiness] = useState<Business>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading || !user) return;
    getDabWaiverFn({ data: { waiverId } })
      .then(setWaiver)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the waiver."));
    getReceiptSettingsFn()
      .then((s) => setBusiness(s as unknown as Business))
      .catch(() => undefined);
  }, [loading, user, waiverId]);

  if (!loading && !user) return <p className="p-6 text-sm">Sign in to view waivers.</p>;
  if (error) return <p className="p-6 text-sm">{error}</p>;
  if (!waiver) return <p className="p-6 text-sm">Loading waiver…</p>;
  return (
    <div className="min-h-screen bg-white py-4 print:py-0">
      <style>{`@page { size: A4; margin: 12mm; }
@media print { body { background: #fff !important; } .no-print { display: none !important; } }`}</style>
      <div className="no-print mb-3 flex justify-center gap-2">
        <button
          type="button"
          className="rounded-md bg-[#0B3D20] px-3 py-1.5 text-sm text-white"
          onClick={() => window.print()}
        >
          Print / save as PDF
        </button>
        <button
          type="button"
          className="rounded-md border px-3 py-1.5 text-sm"
          onClick={() => window.close()}
        >
          Close
        </button>
      </div>
      <WaiverView waiver={waiver} business={business} />
    </div>
  );
}
