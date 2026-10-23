import logo from "@/assets/cannaplug-logo.png";
import { formatRand, type PaperSize, type ReceiptModel } from "@/lib/receipts/receipt-model";

const WIDTH: Record<PaperSize, string> = { "80mm": "72mm", "58mm": "50mm", a4: "170mm" };

/** The on-screen / printed receipt. Same content as the PDF; widths match the paper's printable area. */
export function ReceiptView({ receipt, paper }: { receipt: ReceiptModel; paper: PaperSize }) {
  const b = receipt.business;
  const small = paper === "58mm" ? "text-[9px]" : paper === "80mm" ? "text-[10px]" : "text-xs";
  const base = paper === "58mm" ? "text-[10px]" : paper === "80mm" ? "text-[11px]" : "text-sm";
  return (
    <article
      data-testid="receipt"
      data-paper={paper}
      className={`mx-auto bg-white text-[#111111] ${base}`}
      style={{ width: WIDTH[paper], fontFamily: "Inter, Arial, sans-serif" }}
    >
      <header className="text-center">
        <img src={logo} alt={b.trading_name} className="mx-auto mb-1" style={{ width: "60%" }} />
        <p className="font-bold text-[#0B3D20]">{b.legal_name}</p>
        {b.registration_number && (
          <p className={`${small} text-[#6B7280]`}>Reg. No. {b.registration_number}</p>
        )}
        {b.licence_lines.map((l) => (
          <p key={l} className={`${small} font-bold uppercase text-[#16A34A]`}>
            {l}
          </p>
        ))}
        <p className={small}>{b.address}</p>
        <p className={small}>{[b.phone, b.email].filter(Boolean).join(" | ")}</p>
        {receipt.vat && <p className={small}>VAT No. {receipt.vat.number}</p>}
      </header>
      <div className="my-1.5 h-0.5 bg-[#D4AF37]" />
      <p className="text-center font-bold text-[#0B3D20]">
        {receipt.vat ? "TAX INVOICE" : "RECEIPT"}
      </p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2">
        <dt className="font-bold">Receipt</dt>
        <dd className="text-right font-bold">{receipt.receiptNumber}</dd>
        <dt>Date</dt>
        <dd className="text-right">{receipt.issuedAtLocal}</dd>
        <dt>Served by</dt>
        <dd className="text-right">{receipt.cashier}</dd>
        {receipt.customer && (
          <>
            <dt>Customer</dt>
            <dd className="text-right">{receipt.customer}</dd>
          </>
        )}
      </dl>
      {receipt.status !== "completed" && (
        <p className="mt-1 text-center font-bold uppercase text-red-700">
          {receipt.status.replace("_", " ")}
        </p>
      )}
      <hr className="my-1.5 border-[#9CA3AF]" />
      <ul>
        {receipt.lines.map((l) => (
          <li key={l.name} className="py-0.5">
            <div className="flex justify-between gap-2">
              <span>{l.name}</span>
              <span className="whitespace-nowrap">{formatRand(l.total)}</span>
            </div>
            <div className={`${small} pl-2 text-[#6B7280]`}>
              {l.quantity}
              {l.unit ? ` ${l.unit}` : ""} × {formatRand(l.unitPrice)}
              {l.unit ? ` / ${l.unit}` : ""}
            </div>
          </li>
        ))}
      </ul>
      <hr className="my-1.5 border-[#9CA3AF]" />
      <div className="flex justify-between text-base font-extrabold text-[#0B3D20]">
        <span>TOTAL</span>
        <span>{formatRand(receipt.total)}</span>
      </div>
      {receipt.vat && (
        <div className={`flex justify-between ${small} text-[#6B7280]`}>
          <span>Includes VAT @ {receipt.vat.rate}%</span>
          <span>{formatRand(receipt.vat.amount)}</span>
        </div>
      )}
      <div className="mt-1">
        {receipt.tenders.map((t) => (
          <div key={t.label} className="flex justify-between">
            <span>{t.label}</span>
            <span>{formatRand(t.amount)}</span>
          </div>
        ))}
        {receipt.cashReceived != null && (
          <div className="flex justify-between">
            <span>Cash received</span>
            <span>{formatRand(receipt.cashReceived)}</span>
          </div>
        )}
        {receipt.change != null && (
          <div className="flex justify-between font-bold">
            <span>Change</span>
            <span>{formatRand(receipt.change)}</span>
          </div>
        )}
      </div>
      <hr className="my-1.5 border-[#9CA3AF]" />
      <footer className="text-center">
        {b.footer_message && <p className="font-bold text-[#0B3D20]">{b.footer_message}</p>}
        {b.returns_policy && <p className={`${small} text-[#6B7280]`}>{b.returns_policy}</p>}
        <p className={`${small} mt-1 font-bold text-[#16A34A]`}>cannaplug012.co.za</p>
      </footer>
    </article>
  );
}
