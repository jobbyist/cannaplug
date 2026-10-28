import { describe, expect, it, vi } from "vitest";
import {
  handlePayPalSubscriptionEvent,
  isSubscriptionEventType,
  peekEventType,
  type PayPalSubscriptionDeps,
} from "@/lib/billing/paypal-subscription";
import type { PayPalConfig } from "@/lib/payments/paypal";
import type { FetchLike } from "@/lib/payments/provider";

const CFG: PayPalConfig = {
  clientId: "cid",
  clientSecret: "secret",
  webhookId: "WH-ID-1",
  merchantId: "MERCH1",
  env: "sandbox",
};
const HEADERS = () =>
  new Headers({
    "paypal-transmission-id": "tid-1",
    "paypal-transmission-time": "2026-10-30T08:00:00Z",
    "paypal-transmission-sig": "sig",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "paypal-auth-algo": "SHA256withRSA",
  });
const body = (event_type: string, resource: Record<string, unknown>) =>
  JSON.stringify({ id: "WH-EVT-1", event_type, resource });
const sale = (over: Record<string, unknown> = {}) => ({
  id: "SALE-1",
  billing_agreement_id: "I-ABC12345",
  amount: { total: "25.00", currency: "USD" },
  ...over,
});
const fetchWith =
  (status: string): FetchLike =>
  async (url) => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify(
        url.endsWith("/v1/oauth2/token")
          ? { access_token: "tok" }
          : { verification_status: status },
      ),
  });

function setup(over: Partial<PayPalSubscriptionDeps> = {}) {
  const recordSale = vi.fn(async () => {});
  const subscriptionEvent = vi.fn(async () => {});
  const deps: PayPalSubscriptionDeps = {
    cfg: CFG,
    fetchFn: fetchWith("SUCCESS"),
    recordSale,
    subscriptionEvent,
    ...over,
  };
  return { deps, recordSale, subscriptionEvent };
}

describe("PayPal subscription webhook for the Billing tab", () => {
  it("recognises only subscription and sale events, and leaves order events to the shop flow", async () => {
    expect(isSubscriptionEventType("PAYMENT.SALE.COMPLETED")).toBe(true);
    expect(isSubscriptionEventType("BILLING.SUBSCRIPTION.CANCELLED")).toBe(true);
    expect(isSubscriptionEventType("PAYMENT.CAPTURE.COMPLETED")).toBe(false);
    expect(peekEventType("not json")).toBeNull();
    const { deps, recordSale } = setup();
    expect(
      await handlePayPalSubscriptionEvent(deps, body("PAYMENT.CAPTURE.COMPLETED", {}), HEADERS()),
    ).toBeNull();
    expect(await handlePayPalSubscriptionEvent(deps, "garbage", HEADERS())).toBeNull();
    expect(recordSale).not.toHaveBeenCalled();
  });

  it("logs a verified renewal with its PayPal sale id, amount and currency", async () => {
    const { deps, recordSale } = setup();
    const r = await handlePayPalSubscriptionEvent(
      deps,
      body("PAYMENT.SALE.COMPLETED", sale()),
      HEADERS(),
    );
    expect(r).toEqual({ status: 200, body: "ok" });
    expect(recordSale).toHaveBeenCalledWith({
      event: "COMPLETED",
      subscriptionId: "I-ABC12345",
      paymentId: "SALE-1",
      saleId: "",
      amountCents: 2500,
      currency: "USD",
    });
  });

  it("logs a refund against the original sale", async () => {
    const { deps, recordSale } = setup();
    await handlePayPalSubscriptionEvent(
      deps,
      body("PAYMENT.SALE.REFUNDED", {
        id: "REFUND-1",
        sale_id: "SALE-1",
        amount: { total: "25.00", currency: "USD" },
      }),
      HEADERS(),
    );
    expect(recordSale).toHaveBeenCalledWith(
      expect.objectContaining({ event: "REFUNDED", paymentId: "REFUND-1", saleId: "SALE-1" }),
    );
  });

  it("passes cancelled, suspended, expired and failed-payment events to the subscription handler", async () => {
    const { deps, subscriptionEvent } = setup();
    for (const [type, event] of [
      ["BILLING.SUBSCRIPTION.CANCELLED", "CANCELLED"],
      ["BILLING.SUBSCRIPTION.SUSPENDED", "SUSPENDED"],
      ["BILLING.SUBSCRIPTION.EXPIRED", "EXPIRED"],
      ["BILLING.SUBSCRIPTION.PAYMENT.FAILED", "PAYMENT_FAILED"],
    ] as const) {
      await handlePayPalSubscriptionEvent(deps, body(type, { id: "I-ABC12345" }), HEADERS());
      expect(subscriptionEvent).toHaveBeenLastCalledWith({
        subscriptionId: "I-ABC12345",
        event,
        eventId: "WH-EVT-1",
      });
    }
  });

  it("refuses a body PayPal does not vouch for, and nothing is logged", async () => {
    const bad = setup({ fetchFn: fetchWith("FAILURE") });
    expect(
      (
        await handlePayPalSubscriptionEvent(
          bad.deps,
          body("PAYMENT.SALE.COMPLETED", sale()),
          HEADERS(),
        )
      )?.status,
    ).toBe(401);
    const noHeaders = setup();
    expect(
      (
        await handlePayPalSubscriptionEvent(
          noHeaders.deps,
          body("PAYMENT.SALE.COMPLETED", sale()),
          new Headers(),
        )
      )?.status,
    ).toBe(400);
    const wrongHost = HEADERS();
    wrongHost.set("paypal-cert-url", "https://evil.example.com/cert");
    expect(
      (
        await handlePayPalSubscriptionEvent(
          noHeaders.deps,
          body("PAYMENT.SALE.COMPLETED", sale()),
          wrongHost,
        )
      )?.status,
    ).toBe(401);
    for (const s of [bad, noHeaders]) {
      expect(s.recordSale).not.toHaveBeenCalled();
      expect(s.subscriptionEvent).not.toHaveBeenCalled();
    }
  });

  it("asks PayPal to retry when it can't verify or isn't configured; a database failure surfaces for redelivery", async () => {
    const off = setup({ cfg: null });
    expect(
      (
        await handlePayPalSubscriptionEvent(
          off.deps,
          body("PAYMENT.SALE.COMPLETED", sale()),
          HEADERS(),
        )
      )?.status,
    ).toBe(503);
    const down = setup({
      fetchFn: async (url) =>
        url.endsWith("/v1/oauth2/token")
          ? { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "t" }) }
          : { ok: false, status: 503, text: async () => "" },
    });
    expect(
      (
        await handlePayPalSubscriptionEvent(
          down.deps,
          body("PAYMENT.SALE.COMPLETED", sale()),
          HEADERS(),
        )
      )?.status,
    ).toBe(503);
    const broken = setup({
      recordSale: async () => {
        throw new Error("db down");
      },
    });
    await expect(
      handlePayPalSubscriptionEvent(broken.deps, body("PAYMENT.SALE.COMPLETED", sale()), HEADERS()),
    ).rejects.toThrow("db down");
  });

  it("refuses a sale with no subscription or currency", async () => {
    const { deps, recordSale } = setup();
    const r = await handlePayPalSubscriptionEvent(
      deps,
      body("PAYMENT.SALE.COMPLETED", sale({ billing_agreement_id: undefined })),
      HEADERS(),
    );
    expect(r?.status).toBe(400);
    expect(recordSale).not.toHaveBeenCalled();
  });
});
