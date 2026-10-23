import { useState } from "react";
import { Download, Mail, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { emailPosReceiptFn, posReceiptPdfFn } from "@/lib/receipts.functions";
import { PAPER_SIZES, type PaperSize } from "@/lib/receipts/receipt-model";

const PAPER_KEY = "cannaplug.pos.paper";
const LABEL: Record<PaperSize, string> = { "80mm": "80 mm", "58mm": "58 mm", a4: "A4" };

function savedPaper(): PaperSize {
  try {
    const v = window.localStorage.getItem(PAPER_KEY);
    return PAPER_SIZES.includes(v as PaperSize) ? (v as PaperSize) : "80mm";
  } catch {
    return "80mm";
  }
}

/** Print (80 mm, 58 mm or A4), download the PDF, or email it — for any till sale. */
export function ReceiptActions({
  saleId,
  defaultEmail,
}: {
  saleId: string;
  defaultEmail?: string | null;
}) {
  const [paper, setPaper] = useState<PaperSize>(() =>
    typeof window === "undefined" ? "80mm" : savedPaper(),
  );
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [busy, setBusy] = useState<"pdf" | "email" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const choose = (p: PaperSize) => {
    setPaper(p);
    try {
      window.localStorage.setItem(PAPER_KEY, p);
    } catch {
      /* per-device convenience only */
    }
  };

  const print = () =>
    window.open(
      `/admin/pos/receipt/${saleId}?paper=${paper}&print=1`,
      "_blank",
      "noopener,width=480,height=720",
    );

  const download = async () => {
    setBusy("pdf");
    setMessage(null);
    try {
      const { filename, base64 } = await posReceiptPdfFn({ data: { saleId, paper } });
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not create the PDF.");
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    setBusy("email");
    setMessage(null);
    try {
      await emailPosReceiptFn({ data: { saleId, email, paper } });
      setMessage(`Receipt emailed to ${email}.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not email the receipt.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 space-y-2" data-testid="receipt-actions">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold">Paper</span>
        {PAPER_SIZES.map((p) => (
          <Button
            key={p}
            type="button"
            size="sm"
            variant={p === paper ? "default" : "outline"}
            aria-pressed={p === paper}
            onClick={() => choose(p)}
          >
            {LABEL[p]}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={print}>
          <Printer size={14} /> Print
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void download()}
        >
          <Download size={14} /> {busy === "pdf" ? "Preparing…" : "PDF"}
        </Button>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Input
          type="email"
          required
          placeholder="Customer email"
          aria-label="Customer email for the receipt"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={busy !== null || !email}>
          <Mail size={14} /> {busy === "email" ? "Sending…" : "Email"}
        </Button>
      </form>
      {message && (
        <p role="status" className="text-xs">
          {message}
        </p>
      )}
    </div>
  );
}
