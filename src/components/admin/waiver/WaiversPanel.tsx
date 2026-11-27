import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listDabWaiversFn } from "@/lib/waiver.functions";
import { declineLabel } from "@/lib/waiver-text";
import { IncidentDialog } from "./IncidentDialog";

type Rows = Awaited<ReturnType<typeof listDabWaiversFn>>;
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    dateStyle: "medium",
    timeStyle: "short",
  });

/** Managers and admins: signed dab waivers, newest first. Opening one is logged. Kept for 3 years, then deleted. */
export function WaiversPanel() {
  const [rows, setRows] = useState<Rows | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [incident, setIncident] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await listDabWaiversFn({ data: search.trim() ? { search: search.trim() } : {} }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load waivers.");
    }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Dab waivers</h2>
        <p className="text-xs text-muted-foreground">
          Times in South African time (SAST). Each waiver is valid for one sale on the day it was
          signed, and is deleted after 3 years. Opening a waiver is recorded in the audit log.
        </p>
      </div>
      <Input
        placeholder="Search by customer name"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Search waivers"
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!rows && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {rows && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">No waivers found.</p>
      )}
      <ul className="divide-y rounded-md border">
        {(rows ?? []).map((w) => (
          <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
            <div>
              <p className="font-medium">{w.customer_name}</p>
              <p className="text-xs text-muted-foreground">
                {when(w.signed_at)} · signed in by {w.staff_name}
                {w.decline_reasons.length > 0 && (
                  <> · {w.decline_reasons.map(declineLabel).join("; ")}</>
                )}
              </p>
              <div className="mt-1 flex gap-1">
                <Badge variant={w.status === "valid" ? "secondary" : "destructive"}>
                  {w.status === "valid" ? (w.used ? "Used" : "Not used yet") : "Declined"}
                </Badge>
                {w.flagged && <Badge variant="outline">Flagged</Badge>}
                {w.has_incident && <Badge variant="destructive">Incident</Badge>}
              </div>
            </div>
            <div className="flex gap-2">
              <Button asChild size="sm" variant="outline">
                <a href={`/admin/waiver/${w.id}`} target="_blank" rel="noreferrer">
                  View / print
                </a>
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setIncident({ id: w.id, name: w.customer_name })}
              >
                {w.has_incident ? "Update incident" : "Record incident"}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {incident && (
        <IncidentDialog
          waiverId={incident.id}
          customerName={incident.name}
          open
          onOpenChange={(o) => !o && setIncident(null)}
          onSaved={() => void load()}
        />
      )}
    </div>
  );
}
