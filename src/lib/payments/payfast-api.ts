import { createHash } from "node:crypto";
import type { FetchLike } from "./provider";
import { pfEncode, type PayFastConfig } from "./payfast";

/**
 * PayFast's merchant API (developers.payfast.co.za → "API"), read-only use: the Transaction History, which lists
 * every movement on the PayFast account with its Gross, Fee, Net and running Balance. That running balance is the
 * account balance net of PayFast's fees, and payouts to the bank appear in it as debits.
 *
 * Request signing, as PayFast's PHP SDK does it (Auth::generateApiSignature): the headers `merchant-id`, `version`
 * and `timestamp`, plus the query parameters, plus `passphrase`; sorted by key; values URL-encoded the PHP way;
 * MD5. In sandbox the query also gets `testing=true`, which is not part of the signature.
 */
export const PAYFAST_API_BASE = "https://api.payfast.co.za";

export function payfastApiSignature(
  fields: Record<string, string>,
  passphrase: string | null,
): string {
  const all: Record<string, string> = { ...fields };
  if (passphrase) all["passphrase"] = passphrase;
  const s = Object.keys(all)
    .filter((k) => k !== "signature")
    .sort()
    .map((k) => `${k}=${pfEncode(all[k]!)}`)
    .join("&");
  return createHash("md5").update(s).digest("hex");
}

/** PHP `date("Y-m-d\TH:i:sO")` in South African time, e.g. 2026-10-27T21:00:00+0200. */
export function payfastTimestamp(now: Date = new Date()): string {
  const sast = new Date(now.getTime() + 2 * 3600_000);
  return `${sast.toISOString().slice(0, 19)}+0200`;
}

export type HistoryQuery = { from: string; to: string; offset?: number; limit?: number };

export async function fetchTransactionHistory(
  cfg: PayFastConfig,
  fetchFn: FetchLike,
  q: HistoryQuery,
  now: Date = new Date(),
): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from) || !/^\d{4}-\d{2}-\d{2}$/.test(q.to))
    throw new Error("invalid dates");
  const query: Record<string, string> = { from: q.from, to: q.to };
  if (q.offset != null) query["offset"] = String(q.offset);
  if (q.limit != null) query["limit"] = String(q.limit);
  const headers: Record<string, string> = {
    "merchant-id": cfg.merchantId,
    version: "v1",
    timestamp: payfastTimestamp(now),
  };
  const signature = payfastApiSignature({ ...headers, ...query }, cfg.passphrase);
  const qs = new URLSearchParams({ ...query, ...(cfg.sandbox ? { testing: "true" } : {}) });
  const base = (cfg.baseOverride ?? PAYFAST_API_BASE).replace(/\/+$/, "");
  const res = await fetchFn(`${base}/transactions/history?${qs.toString()}`, {
    method: "GET",
    headers: { ...headers, signature },
  });
  // PayFast's error bodies are not shown to anyone: they can echo request details.
  if (!res.ok) throw new Error(`PayFast API answered ${res.status}`);
  return res.text();
}

/** One line of the history, WITHOUT the buyer's name, email or any free text PayFast includes about them. */
export type HistoryRow = {
  date: string;
  type: string;
  sign: "CREDIT" | "DEBIT" | string;
  fundingType: string;
  gross: number;
  fee: number;
  net: number;
  balance: number;
  mPaymentId: string;
  pfPaymentId: string;
  /** PayFast's description, kept only for payout / fee / refund lines (never for buyer payments). */
  description: string;
};

/** RFC 4180 CSV (quoted fields may hold commas and doubled quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

const amount = (s: string | undefined) => {
  const v = Number((s ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(v) ? v : 0;
};

export const isPayoutType = (type: string, description = "") =>
  /payout|withdraw|settle/i.test(type) || /payout|withdrawal/i.test(description);

export function parseHistory(csv: string): HistoryRow[] {
  const rows = parseCsv(csv.trim());
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const at = (name: string) => header.indexOf(name);
  const idx = {
    date: at("date"),
    type: at("type"),
    sign: at("sign"),
    description: at("description"),
    funding: at("funding type"),
    gross: at("gross"),
    fee: at("fee"),
    net: at("net"),
    balance: at("balance"),
    m: at("m payment id"),
    pf: at("pf payment id"),
  };
  if (idx.date < 0 || idx.balance < 0 || idx.net < 0) throw new Error("unexpected history format");
  return rows.slice(1).map((r) => {
    const type = (r[idx.type] ?? "").trim();
    const description = (r[idx.description] ?? "").trim();
    const internal = type !== "FUNDS_RECEIVED";
    return {
      date: (r[idx.date] ?? "").trim(),
      type,
      sign: (r[idx.sign] ?? "").trim().toUpperCase(),
      fundingType: (r[idx.funding] ?? "").trim(),
      gross: amount(r[idx.gross]),
      fee: amount(r[idx.fee]),
      net: amount(r[idx.net]),
      balance: amount(r[idx.balance]),
      mPaymentId: (r[idx.m] ?? "").trim().slice(0, 100),
      pfPaymentId: (r[idx.pf] ?? "").trim().slice(0, 40),
      // Buyer payments carry the buyer's item text; keep descriptions for our own account movements only.
      description: internal ? description.slice(0, 120) : "",
    };
  });
}
