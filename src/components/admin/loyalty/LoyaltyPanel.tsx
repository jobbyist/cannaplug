import { useCallback, useEffect, useRef, useState } from "react";
import { Gift, Recycle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomerPicker, type PickedCustomer } from "@/components/admin/pos/CustomerPicker";
import { ReceiptActions } from "@/components/admin/receipts/ReceiptActions";
import {
  getLoyaltyDeskFn,
  recordPlugBackReturnFn,
  redeemPlugBackFn,
  redeemPointsRewardFn,
} from "@/lib/loyalty-desk.functions";
import type { LoyaltyDesk } from "@/lib/loyalty-desk.server";
import { notifyAdminTabs } from "@/lib/admin-sync";
import { rand } from "@/lib/cart";
import { HISTORY_LABEL, newKey, tubeProgress, tubesLine } from "./loyalty-logic";

type Done = { saleId?: string; receipt?: string; text: string };

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Staff redeem a member's points and Plug Back tubes for free products. Every reward is an R0 till sale. */
export function LoyaltyPanel() {
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [desk, setDesk] = useState<LoyaltyDesk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [tubes, setTubes] = useState("");
  // One key per intended action: a retry after a network error reuses it, so nothing is given twice.
  const keys = useRef<Record<string, string>>({});
  const keyFor = (action: string) => (keys.current[action] ??= newKey(action));

  const load = useCallback(async (c: PickedCustomer) => {
    setError(null);
    try {
      setDesk(await getLoyaltyDeskFn({ data: { customerId: c.id } }));
    } catch (e) {
      setDesk(null);
      setError(e instanceof Error ? e.message : "Could not load the member.");
    }
  }, []);

  useEffect(() => {
    setDone(null);
    setPick({});
    setTubes("");
    keys.current = {};
    if (customer) void load(customer);
    else setDesk(null);
  }, [customer, load]);

  async function act(action: string, run: () => Promise<Done>) {
    if (!customer || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await run();
      delete keys.current[action];
      setDone(result);
      notifyAdminTabs("stock");
      await load(customer);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work and nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  const till = desk?.till ?? null;
  const pb = desk?.plugBack ?? null;

  return (
    <div className="grid gap-4" data-testid="loyalty-panel">
      <div>
        <h2 className="font-display text-xl font-bold text-forest">Loyalty</h2>
        <p className="text-sm text-muted-foreground">
          Give a member their free products: points rewards and Plug Back (10 returned pre-roll
          tubes = 1 free Greenhouse pre-roll). Each reward is rung up as a R0 sale on your open
          till, so stock and receipts stay right.
        </p>
      </div>

      <CustomerPicker value={customer} onChange={setCustomer} />

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {done && (
        <div role="status" className="rounded-xl border border-leaf/40 bg-leaf/10 p-4 text-sm">
          <p className="font-semibold text-forest">{done.text}</p>
          {done.saleId && (
            <>
              <p className="text-xs text-muted-foreground">Receipt {done.receipt}</p>
              <ReceiptActions saleId={done.saleId} />
            </>
          )}
        </div>
      )}

      {customer && desk && !till && (
        <p role="note" className="rounded-md border border-gold/50 bg-gold/10 px-3 py-2 text-sm">
          Open your till in the POS tab first. Rewards are rung up as R0 sales on your till session.
        </p>
      )}

      {customer && desk && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section
            className="grid content-start gap-3 rounded-xl border border-border bg-card p-4"
            aria-label="Points rewards"
          >
            <header className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 font-semibold text-forest">
                <Gift size={16} aria-hidden /> Points rewards
              </h3>
              <span
                className="rounded-full bg-forest px-3 py-1 text-xs font-semibold text-cream"
                data-testid="points-balance"
              >
                {desk.points} point{desk.points === 1 ? "" : "s"}
              </span>
            </header>
            {desk.rewards.map((r) => {
              const enough = desk.points >= r.points_cost;
              const chosen = pick[r.code] ?? "";
              return (
                <div key={r.code} className="grid gap-2 rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{r.name}</p>
                    <span className="text-xs text-muted-foreground">{r.points_cost} points</span>
                  </div>
                  <select
                    aria-label={`Product for ${r.name}`}
                    className={selectClass}
                    value={chosen}
                    onChange={(e) => setPick({ ...pick, [r.code]: e.target.value })}
                  >
                    <option value="">Choose a product</option>
                    {r.products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.available} in stock)
                      </option>
                    ))}
                  </select>
                  {!enough && (
                    <p className="text-xs text-muted-foreground">
                      {r.points_cost - desk.points} more point
                      {r.points_cost - desk.points === 1 ? "" : "s"} needed.
                    </p>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || !till || !enough || !chosen}
                    onClick={() =>
                      act(`pts-${r.code}-${chosen}`, async () => {
                        const res = await redeemPointsRewardFn({
                          data: {
                            sessionId: till!.sessionId,
                            customerId: customer.id,
                            productId: chosen,
                            rewardCode: r.code,
                            key: keyFor(`pts-${r.code}-${chosen}`),
                          },
                        });
                        return {
                          saleId: res.sale.sale_id,
                          receipt: res.sale.receipt_number,
                          text: `${r.name} given for ${r.points_cost} points.`,
                        };
                      })
                    }
                  >
                    Redeem for {r.points_cost} points
                  </Button>
                </div>
              );
            })}
            {desk.rewards.length === 0 && (
              <p className="text-sm text-muted-foreground">No rewards are on offer right now.</p>
            )}
          </section>

          {pb && (
            <section
              className="grid content-start gap-3 rounded-xl border border-border bg-card p-4"
              aria-label="Plug Back"
            >
              <header className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 font-semibold text-forest">
                  <Recycle size={16} aria-hidden /> Plug Back
                </h3>
                <span
                  className="rounded-full bg-leaf px-3 py-1 text-xs font-semibold text-white"
                  data-testid="tube-balance"
                >
                  {pb.tubes} tube{pb.tubes === 1 ? "" : "s"}
                </span>
              </header>
              <div>
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={tubeProgress(pb.tubes, pb.tubes_per_reward)}
                  aria-label="Progress to the next free pre-roll"
                  className="h-2 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full bg-leaf"
                    style={{ width: `${tubeProgress(pb.tubes, pb.tubes_per_reward)}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {tubesLine(pb.tubes, pb.tubes_per_reward)}
                </p>
              </div>

              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = Number(tubes);
                  if (!Number.isInteger(n) || n < 1 || n > 100) return;
                  void act(`tubes-${n}`, async () => {
                    const r = await recordPlugBackReturnFn({
                      data: { customerId: customer.id, tubes: n, key: keyFor(`tubes-${n}`) },
                    });
                    setTubes("");
                    return { text: `${r.recorded} tube${r.recorded === 1 ? "" : "s"} recorded.` };
                  });
                }}
              >
                <label className="grid flex-1 gap-1 text-xs font-medium">
                  Tubes brought back
                  <Input
                    inputMode="numeric"
                    placeholder="e.g. 5"
                    value={tubes}
                    onChange={(e) => setTubes(e.target.value.replace(/\D/g, "").slice(0, 3))}
                  />
                </label>
                <Button type="submit" size="sm" disabled={busy || !tubes || Number(tubes) < 1}>
                  Record tubes
                </Button>
              </form>

              <div className="grid gap-2 rounded-lg border border-border p-3">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Sparkles size={14} aria-hidden /> Free Greenhouse pre-roll ({pb.tubes_per_reward}{" "}
                  tubes)
                </p>
                <select
                  aria-label="Greenhouse pre-roll to give"
                  className={selectClass}
                  value={pick["plugback"] ?? ""}
                  onChange={(e) => setPick({ ...pick, plugback: e.target.value })}
                >
                  <option value="">Choose a pre-roll</option>
                  {pb.products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({rand(p.price_rand)})
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || !till || pb.rewards_available < 1 || !pick["plugback"]}
                  onClick={() =>
                    act(`pb-${pick["plugback"]}`, async () => {
                      const res = await redeemPlugBackFn({
                        data: {
                          sessionId: till!.sessionId,
                          customerId: customer.id,
                          productId: pick["plugback"]!,
                          key: keyFor(`pb-${pick["plugback"]}`),
                        },
                      });
                      return {
                        saleId: res.sale_id,
                        receipt: res.receipt_number,
                        text: `Free Greenhouse pre-roll given for ${res.tubes_spent} tubes.`,
                      };
                    })
                  }
                >
                  Give free pre-roll
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                Brought back so far: {pb.lifetime_tubes} tubes · Free pre-rolls given:{" "}
                {pb.rewards_given}
              </p>
              {pb.history.length > 0 && (
                <ul
                  className="grid gap-1 text-xs text-muted-foreground"
                  aria-label="Recent Plug Back activity"
                >
                  {pb.history.map((h, i) => (
                    <li key={i} className="flex justify-between">
                      <span>{HISTORY_LABEL[h.kind] ?? h.kind}</span>
                      <span>
                        {h.tubes > 0 ? "+" : ""}
                        {h.tubes} · {new Date(h.at).toLocaleDateString("en-ZA")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
