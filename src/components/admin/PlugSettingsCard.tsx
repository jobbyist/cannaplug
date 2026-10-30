import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getPlugSettingsFn, setPlugSettingsFn } from "@/lib/plug-settings.functions";

type Data = Awaited<ReturnType<typeof getPlugSettingsFn>>;

/**
 * /admin → Settings: the Ask The Plug safety buffer. A product is only offered to a member while the shop has at least
 * this many units free (on hand minus held), so a card is still true when the member taps Reserve. Fast sellers get a
 * higher buffer because their last units go at the till while a member is reading. Managers and admins can edit.
 */
export function PlugSettingsCard() {
  const [data, setData] = useState<Data | null>(null);
  const [draft, setDraft] = useState({ d: "", f: "", u: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    try {
      const v = await getPlugSettingsFn();
      setData(v);
      setDraft({ d: String(v.bufferDefault), f: String(v.bufferFast), u: String(v.fastUnits) });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not load the settings." });
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    const [d, f, u] = [Number(draft.d), Number(draft.f), Number(draft.u)];
    if (![d, f, u].every((n) => Number.isInteger(n) && n >= 1)) {
      setMsg({ ok: false, text: "Enter whole numbers, 1 or more." });
      return;
    }
    if (f < d) {
      setMsg({ ok: false, text: "The fast-seller buffer can't be lower than the normal buffer." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const v = await setPlugSettingsFn({
        data: { bufferDefault: d, bufferFast: f, fastUnits: u, key: crypto.randomUUID() },
      });
      setData(v);
      setMsg({ ok: true, text: "Saved. Ask The Plug uses these numbers from the next match." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Nothing was changed." });
    } finally {
      setBusy(false);
    }
  };

  const field = (id: "d" | "f" | "u", label: string, hint: string) => (
    <label className="block text-sm">
      <span className="font-medium">{label}</span>
      <Input
        aria-label={label}
        inputMode="numeric"
        className="mt-1 h-9 w-28"
        value={draft[id]}
        onChange={(e) => setDraft((x) => ({ ...x, [id]: e.target.value }))}
      />
      <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
    </label>
  );

  return (
    <section
      className="mt-8 rounded-xl border border-border bg-card p-5"
      aria-labelledby="plug-buffer-title"
    >
      <h2 id="plug-buffer-title" className="font-display text-lg font-extrabold uppercase">
        Ask The Plug stock buffer
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Ask The Plug only recommends a product while at least this many units are free, so the
        recommendation is still true when a member taps Reserve. Fast sellers need more, because
        their last units sell at the till while a member is deciding.
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
        <>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {field("d", "Units kept back", "Normal products. Default 2.")}
            {field("f", "Units kept back (fast sellers)", "Default 4.")}
            {field("u", "Fast seller means", "Units sold in 7 days. Default 10.")}
          </div>
          <div className="mt-4">
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
