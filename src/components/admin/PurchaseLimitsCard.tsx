import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listPurchaseLimitsFn, setPurchaseLimitFn } from "@/lib/launch-rules.functions";

type Data = Awaited<ReturnType<typeof listPurchaseLimitsFn>>;

/** /admin → Settings: optional daily purchase limits per category. Admins edit; managers see them. */
export function PurchaseLimitsCard() {
  const [data, setData] = useState<Data | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    try {
      const d = await listPurchaseLimitsFn();
      setData(d);
      setDraft(
        Object.fromEntries(
          d.limits.map((l) => [l.category, l.daily_max ? String(l.daily_max) : ""]),
        ),
      );
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not load the limits." });
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const save = async (category: string, enabled: boolean) => {
    const max = Number(draft[category]);
    if (!Number.isInteger(max) || max < 1) {
      setMsg({ ok: false, text: `Enter a whole number for ${category} first.` });
      return;
    }
    setBusy(category);
    setMsg(null);
    try {
      await setPurchaseLimitFn({
        data: { category, dailyMax: max, enabled, key: crypto.randomUUID() },
      });
      setMsg({
        ok: true,
        text: `${category}: ${enabled ? `limit of ${max} per day is on` : "limit switched off"}.`,
      });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Nothing was changed." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="mt-8 rounded-xl border border-border bg-card p-5"
      aria-labelledby="limits-title"
    >
      <h2 id="limits-title" className="font-display text-lg font-extrabold uppercase">
        Daily purchase limits
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        The most one member can buy per category in one day (South African time), online and at the
        till together. Count items, or grams for products sold by weight. A till sale only counts
        when the customer is chosen on the sale. All limits are off until an admin switches one on.
      </p>
      {msg && (
        <p
          role={msg.ok ? "status" : "alert"}
          className={`mt-3 text-xs ${msg.ok ? "text-primary" : "text-destructive"}`}
        >
          {msg.text}
        </p>
      )}
      {!data && !msg && <p className="mt-3 text-sm text-muted-foreground">Loading…</p>}
      {data && (
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1">Category</th>
              <th>Most per day</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.limits.map((l) => (
              <tr key={l.category} className="border-t border-border">
                <td className="py-2 font-medium">{l.category}</td>
                <td>
                  {data.canEdit ? (
                    <Input
                      aria-label={`${l.category} limit per day`}
                      inputMode="numeric"
                      className="h-8 w-24"
                      value={draft[l.category] ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [l.category]: e.target.value }))}
                    />
                  ) : (
                    (l.daily_max ?? "—")
                  )}
                </td>
                <td>{l.enabled ? "On" : "Off"}</td>
                <td className="text-right">
                  {data.canEdit && (
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => void save(l.category, true)}
                      >
                        {l.enabled ? "Save" : "Switch on"}
                      </Button>
                      {l.enabled && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy !== null}
                          onClick={() => void save(l.category, false)}
                        >
                          Switch off
                        </Button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && !data.canEdit && (
        <p className="mt-3 text-xs text-muted-foreground">Only an admin can change these limits.</p>
      )}
    </section>
  );
}
