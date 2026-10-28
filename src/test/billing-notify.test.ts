import { describe, expect, it, vi } from "vitest";
import { pfParamString, pfSignature, type PayFastConfig } from "@/lib/payments/payfast";
import type { FetchLike } from "@/lib/payments/provider";
import {
  DEFAULT_BILLING_MERCHANT,
  billingPayfastFromEnv,
  handleBillingNotify,
  type BillingNotifyDeps,
} from "@/lib/billing/payfast-notify";

const CFG: PayFastConfig = {
  merchantId: DEFAULT_BILLING_MERCHANT,
  merchantKey: "",
  passphrase: "billing-pass",
  sandbox: false,
};
const IP = "197.97.145.144";
const pairs = (over: Record<string, string> = {}): [string, string][] =>
  Object.entries({
    m_payment_id: "",
    pf_payment_id: "1089250",
    payment_status: "COMPLETE",
    item_name: "Real-Time ID Verification API Credits",
    amount_gross: "100.00",
    merchant_id: DEFAULT_BILLING_MERCHANT,
    ...over,
  });
const body = (p = pairs(), passphrase: string | null = CFG.passphrase) =>
  `${pfParamString(p)}&signature=${pfSignature(pfParamString(p), passphrase)}`;
const fetchOk =
  (answer = "VALID"): FetchLike =>
  async () => ({
    ok: true,
    status: 200,
    text: async () => answer,
  });

function setup(over: Partial<BillingNotifyDeps> = {}) {
  const recordPayment = vi.fn(async () => ({ recorded: true }));
  const deps: BillingNotifyDeps = {
    cfg: CFG,
    fetchFn: fetchOk(),
    resolveHost: async () => [IP],
    recordPayment,
    ...over,
  };
  const run = (b: string, ip: string | null = IP, svc: "payfast" | "verifynow" = "verifynow") =>
    handleBillingNotify(deps, svc, b, new Headers(), ip);
  return { run, recordPayment };
}

describe("billing Payfast notify", () => {
  it("logs a verified payment against the right billing account", async () => {
    const { run, recordPayment } = setup();
    expect((await run(body())).status).toBe(200);
    expect(recordPayment).toHaveBeenCalledWith({
      slug: "verifynow-id",
      paymentId: "1089250",
      status: "COMPLETE",
      amountCents: 10000,
      itemName: "Real-Time ID Verification API Credits",
    });
    await run(body(), IP, "payfast");
    expect(recordPayment).toHaveBeenLastCalledWith(
      expect.objectContaining({ slug: "payfast-gateway" }),
    );
  });

  it("refuses a wrong signature, a wrong passphrase, a foreign address and a failed Payfast validation", async () => {
    const a = setup();
    expect((await a.run(body(pairs(), "other-pass"))).status).toBe(401);
    expect(
      (await a.run(body().replace(/signature=.*/, "signature=" + "0".repeat(32)))).status,
    ).toBe(401);
    expect((await a.run(body(), "203.0.113.9")).status).toBe(401);
    const b = setup({ fetchFn: fetchOk("INVALID") });
    expect((await b.run(body())).status).toBe(401);
    expect((await a.run("not a form body")).status).toBe(400);
    expect(a.recordPayment).not.toHaveBeenCalled();
    expect(b.recordPayment).not.toHaveBeenCalled();
  });

  it("refuses a payment made to a different merchant", async () => {
    const { run, recordPayment } = setup();
    expect((await run(body(pairs({ merchant_id: "10000100" })))).status).toBe(400);
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it("asks Payfast to retry when it cannot verify, or when notifications are not configured", async () => {
    const down = setup({ resolveHost: async () => [] });
    expect((await down.run(body())).status).toBe(503);
    const off = setup({ cfg: null });
    expect((await off.run(body())).status).toBe(503);
    expect(down.recordPayment).not.toHaveBeenCalled();
  });

  it("a database failure surfaces so Payfast resends", async () => {
    const { run } = setup({
      recordPayment: async () => {
        throw new Error("db down");
      },
    });
    await expect(run(body())).rejects.toThrow("db down");
  });

  it("reads the merchant settings from the environment, defaulting the merchant and never guessing", () => {
    expect(billingPayfastFromEnv({})).toBeNull();
    expect(billingPayfastFromEnv({ BILLING_PAYFAST_PASSPHRASE: "p" })).toMatchObject({
      merchantId: "25538645",
      sandbox: false,
    });
    expect(
      billingPayfastFromEnv({ BILLING_PAYFAST_PASSPHRASE: "p", BILLING_PAYFAST_ENV: "sandbox" })
        ?.sandbox,
    ).toBe(true);
    expect(
      billingPayfastFromEnv({ BILLING_PAYFAST_PASSPHRASE: "p", BILLING_PAYFAST_ENV: "x" }),
    ).toBeNull();
    expect(
      billingPayfastFromEnv({
        BILLING_PAYFAST_PASSPHRASE: "p",
        BILLING_PAYFAST_MERCHANT_ID: "abc",
      }),
    ).toBeNull();
  });
});
