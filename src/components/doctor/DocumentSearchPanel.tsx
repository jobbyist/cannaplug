import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { searchDoctorDocumentsFn } from "@/lib/clinical/clinical.functions";

type Result = Awaited<ReturnType<typeof searchDoctorDocumentsFn>>;
export type DocumentRow = Result["rows"][number];

const STATUSES = [
  ["", "Any status"],
  ["DRAFT", "Draft"],
  ["PENDING_DOCTOR_REVIEW", "Waiting for review"],
  ["APPROVED", "Approved (to sign)"],
  ["SIGNING", "Signing"],
  ["ISSUED", "Issued"],
  ["EXPIRED", "Expired"],
  ["REVOKED", "Revoked"],
  ["VOID", "Void"],
] as const;
const TYPES = [
  ["", "Any type"],
  ["MEDICAL_LETTER", "Medical letter"],
  ["PRESCRIPTION_ORDER", "Prescription / order"],
] as const;
const PAGE = 25;

/** Practitioner's documents: search by patient or reference, filter by status, type and date, page through all. */
export function DocumentSearchPanel({
  renderTable,
  refreshKey,
}: {
  renderTable: (rows: DocumentRow[]) => React.ReactNode;
  refreshKey: number;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [res, setRes] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setRes(
        await searchDoctorDocumentsFn({
          data: {
            query: query.trim() || null,
            status: (status || null) as never,
            type: (type || null) as never,
            from: from || null,
            to: to || null,
            limit: PAGE,
            offset,
          },
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not search documents.");
    }
  }, [query, status, type, from, to, offset]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250); // debounce typing
    return () => clearTimeout(t);
  }, [load, refreshKey]);

  const total = res?.total ?? 0;
  const reset =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setOffset(0);
    };
  const select = "h-9 rounded-md border border-input bg-background px-2 text-sm";

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs">
          Search
          <Input
            placeholder="Patient name or document number"
            value={query}
            maxLength={80}
            onChange={(e) => reset(setQuery)(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Status
          <select
            className={select}
            value={status}
            onChange={(e) => reset(setStatus)(e.target.value)}
          >
            {STATUSES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Type
          <select className={select} value={type} onChange={(e) => reset(setType)(e.target.value)}>
            {TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          From
          <Input type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          To
          <Input type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} />
        </label>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {renderTable(res?.rows ?? [])}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {total === 0
            ? "No documents"
            : `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}`}
        </span>
        <span className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={offset + PAGE >= total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Next
          </Button>
        </span>
      </div>
    </section>
  );
}
