// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPayFastProvider, type PayFastConfig } from "@/lib/payments/payfast";
import type { FetchLike, PaymentProvider } from "@/lib/payments/provider";
import {
  startPayment,
  type PaymentsDb,
  type PaymentsDeps,
  type TxView,
} from "@/lib/payments/service";

/**
 * PayFast onsite: the server prepares PayFast's payment window for the amount stored on the transaction, the
 * browser runs only PayFast's official engine, and nothing the window reports is treated as proof of payment.
 */
const mocks = vi.hoisted(() => ({
  startPaymentFn: vi.fn(),
  paymentStatusFn: vi.fn(),
  goToCheckout: vi.fn(),
}));
vi.mock("@/lib/payments.functions", () => ({
  startPaymentFn: mocks.startPaymentFn,
  paymentStatusFn: mocks.paymentStatusFn,
}));
vi.mock("@/lib/payments/redirect", () => ({ goToCheckout: mocks.goToCheckout }));

import {
  isPayFastEngineUrl,
  loadPayFastEngine,
  openPayFastOnsite,
  presentPayment,
} from "@/lib/payments/onsite";
import { PaymentPanel } from "@/components/checkout/PaymentPanel";
import {
  clearPendingCheckout,
  loadPendingCheckout,
  savePendingCheckout,
} from "@/lib/payments/pending-checkout";

const TX = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";
const UUID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const PF: PayFastConfig = {
  merchantId: "10000100",
  merchantKey: "46f0cd694581a",
  passphrase: "jt7NOE43FZPn",
  sandbox: true,
  onsite: true,
};
const SANDBOX_ENGINE = "https://sandbox.payfast.co.za/onsite/engine.js";

function memDb(tx: Partial<TxView> = {}) {
  const row: TxView = {
    id: TX,
    order_id: ORDER,
    provider: "payfast",
    status: "initiated",
    expected_amount: 275,
    expected_currency: "ZAR",
    fx_rate: null,
    provider_ref: null,
    redirect_url: null,
    ...tx,
  };
  const db: PaymentsDb & { failed: string[] } = {
    failed: [],
    initiate: async () => ({ transaction_id: TX, order_number: "CP-1001", reused: false }),
    getTx: async () => ({ ...row }),
    findPayPalTx: async () => null,
    attach: async (_id, ref, url) => {
      Object.assign(row, { provider_ref: ref, redirect_url: url, status: "pending" });
    },
    markFailed: async (_id, reason) => {
      db.failed.push(reason);
    },
    apply: async () => ({ status: "x", outcome: "x", replayed: false }),
    reject: async () => undefined,
  };
  return db;
}

const onsiteFetch = (uuid: string | null = UUID): FetchLike & { bodies: string[] } => {
  const bodies: string[] = [];
  const f = (async (url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? "");
    if (!url.endsWith("/onsite/process") || uuid === null)
      return { ok: false, status: 503, text: async () => "down" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ uuid }) };
  }) as FetchLike & { bodies: string[] };
  f.bodies = bodies;
  return f;
};

const deps = (db: PaymentsDb, providers: PaymentsDeps["providers"]): PaymentsDeps => ({
  db,
  providers,
  ensureFx: async () => ({}),
  siteUrl: "https://shop.example/",
});

describe("starting a PayFast payment with the onsite window", () => {
  it("prepares the window for the stored amount and keeps the hosted page ready as a fallback", async () => {
    const db = memDb();
    const f = onsiteFetch();
    const s = await startPayment(
      deps(db, { payfast: createPayFastProvider(PF, f, async () => []) }),
      { userId: "u1", orderId: ORDER, provider: "payfast", key: "k-123456", buyerEmail: "m@x.co" },
    );
    expect(s.onsite).toEqual({ uuid: UUID, engineUrl: SANDBOX_ENGINE });
    expect(s.redirectUrl).toMatch(/^https:\/\/sandbox\.payfast\.co\.za\/eng\/process\?/);
    const posted = new URLSearchParams(f.bodies[0]);
    expect(posted.get("amount")).toBe("275.00"); // from the database row, not the browser
    expect(posted.get("m_payment_id")).toBe(TX);
    expect(posted.get("email_address")).toBe("m@x.co");
    expect(posted.get("notify_url")).toBe("https://shop.example/api/public/payments/payfast-itn");
    expect(new URL(s.redirectUrl).searchParams.get("email_address")).toBeNull();
  });

  it("an onsite outage does not fail the payment: the hosted page is used and the attempt stays open", async () => {
    const db = memDb();
    const warn = vi.fn();
    const s = await startPayment(
      {
        ...deps(db, { payfast: createPayFastProvider(PF, onsiteFetch(null), async () => []) }),
        warn,
      },
      { userId: "u1", orderId: ORDER, provider: "payfast", key: "k-123456", buyerEmail: "m@x.co" },
    );
    expect(s.onsite).toBeNull();
    expect(s.redirectUrl).toMatch(/^https:\/\/sandbox\.payfast\.co\.za\/eng\/process\?/);
    expect(db.failed).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "onsite payment unavailable, using the hosted page",
      expect.anything(),
    );
  });

  it("without the member's email, or with onsite off, it is the hosted page as before", async () => {
    const f = onsiteFetch();
    const noEmail = await startPayment(
      deps(memDb(), { payfast: createPayFastProvider(PF, f, async () => []) }),
      { userId: "u1", orderId: ORDER, provider: "payfast", key: "k-123456" },
    );
    expect(noEmail.onsite).toBeNull();
    const off = await startPayment(
      deps(memDb(), {
        payfast: createPayFastProvider({ ...PF, onsite: false }, f, async () => []),
      }),
      { userId: "u1", orderId: ORDER, provider: "payfast", key: "k-123456", buyerEmail: "m@x.co" },
    );
    expect(off.onsite).toBeNull();
    expect(f.bodies).toHaveLength(0);
  });

  it("returning to an open attempt prepares a fresh window for the same transaction", async () => {
    const db = memDb({
      status: "pending",
      provider_ref: TX,
      redirect_url: "https://sandbox.payfast.co.za/eng/process?x=1",
    });
    const attach = vi.spyOn(db, "attach");
    const s = await startPayment(
      deps(db, { payfast: createPayFastProvider(PF, onsiteFetch(), async () => []) }),
      { userId: "u1", orderId: ORDER, provider: "payfast", key: "k-123456", buyerEmail: "m@x.co" },
    );
    expect(s.redirectUrl).toBe("https://sandbox.payfast.co.za/eng/process?x=1");
    expect(s.onsite?.uuid).toBe(UUID);
    expect(attach).not.toHaveBeenCalled();
  });

  it("providers without an onsite window are untouched", async () => {
    const plain: PaymentProvider = {
      id: "payfast",
      mode: "test",
      merchantId: "1",
      createCheckout: async () => ({ providerRef: "r", redirectUrl: "https://x.example/pay" }),
      verifyWebhook: async () => ({ ok: false, reason: "not_configured" }),
    };
    const s = await startPayment(deps(memDb(), { payfast: plain }), {
      userId: "u1",
      orderId: ORDER,
      provider: "payfast",
      key: "k-123456",
      buyerEmail: "m@x.co",
    });
    expect(s.onsite).toBeNull();
  });
});

type W = Window & { payfast_do_onsite_payment?: unknown };

describe("loading PayFast's engine in the browser", () => {
  let appended: HTMLScriptElement[];
  beforeEach(() => {
    appended = [];
    delete (window as W).payfast_do_onsite_payment;
    vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
      appended.push(node as HTMLScriptElement);
      return node;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as W).payfast_do_onsite_payment;
  });

  it("runs only PayFast's two official engine files", async () => {
    expect(isPayFastEngineUrl(SANDBOX_ENGINE)).toBe(true);
    expect(isPayFastEngineUrl("https://www.payfast.co.za/onsite/engine.js")).toBe(true);
    for (const bad of [
      "http://www.payfast.co.za/onsite/engine.js",
      "https://www.payfast.co.za/onsite/engine.js?x=1",
      "https://www.payfast.co.za.evil.example/onsite/engine.js",
      "https://evil.example/onsite/engine.js",
      "javascript:alert(1)",
    ]) {
      expect(isPayFastEngineUrl(bad)).toBe(false);
      await expect(loadPayFastEngine(bad)).rejects.toThrow("not PayFast");
    }
    expect(appended).toHaveLength(0);
  });

  it("loads the engine once, then opens PayFast's window and reports how it closed", async () => {
    const open = vi.fn((_o: { uuid: string }, cb: (r: boolean) => void) => cb(true));
    const p1 = loadPayFastEngine(SANDBOX_ENGINE);
    const p2 = loadPayFastEngine(SANDBOX_ENGINE);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.src).toBe(SANDBOX_ENGINE);
    (window as W).payfast_do_onsite_payment = open;
    appended[0]!.onload!(new Event("load"));
    expect(await p1).toBe(open);
    expect(await p2).toBe(open);
    await expect(openPayFastOnsite({ uuid: UUID, engineUrl: SANDBOX_ENGINE })).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith({ uuid: UUID }, expect.any(Function));
    open.mockImplementationOnce((_o, cb) => cb(false));
    await expect(openPayFastOnsite({ uuid: UUID, engineUrl: SANDBOX_ENGINE })).resolves.toBe(false);
    await expect(
      openPayFastOnsite({ uuid: 'x"><img>', engineUrl: SANDBOX_ENGINE }),
    ).rejects.toThrow("identifier");
  });

  it("a blocked or broken engine falls back to PayFast's hosted page for the same transaction", async () => {
    const url = "https://www.payfast.co.za/onsite/engine.js";
    const out = presentPayment({
      redirectUrl: "https://www.payfast.co.za/eng/process?a=1",
      onsite: { uuid: UUID, engineUrl: url },
    });
    await waitFor(() => expect(appended).toHaveLength(1));
    appended[0]!.onerror!(new Event("error"));
    await expect(out).resolves.toBe("redirected");
    expect(mocks.goToCheckout).toHaveBeenCalledWith("https://www.payfast.co.za/eng/process?a=1");
  });

  it("without a window it is a plain hosted-page payment", async () => {
    mocks.goToCheckout.mockReset();
    await expect(
      presentPayment({
        redirectUrl: "https://www.sandbox.paypal.com/checkoutnow?token=X",
        onsite: null,
      }),
    ).resolves.toBe("redirected");
    expect(mocks.goToCheckout).toHaveBeenCalledWith(
      "https://www.sandbox.paypal.com/checkoutnow?token=X",
    );
    expect(appended).toHaveLength(0);
  });
});

describe("remembering an unpaid order across a refresh", () => {
  beforeEach(() => sessionStorage.clear());
  it("keeps ids only and ignores anything malformed", () => {
    savePendingCheckout({ orderId: ORDER, orderNumber: "CP-1001", method: "card" });
    expect(loadPendingCheckout()).toEqual({
      orderId: ORDER,
      orderNumber: "CP-1001",
      method: "card",
    });
    sessionStorage.setItem(
      "cannaplug.checkout.pending",
      JSON.stringify({ orderId: "../../x", orderNumber: "CP", method: "card" }),
    );
    expect(loadPendingCheckout()).toBeNull();
    sessionStorage.setItem("cannaplug.checkout.pending", "{not json");
    expect(loadPendingCheckout()).toBeNull();
    clearPendingCheckout();
    expect(sessionStorage.getItem("cannaplug.checkout.pending")).toBeNull();
  });
});

describe("the payment panel", () => {
  let engine: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    engine = vi.fn();
    (window as W).payfast_do_onsite_payment = engine; // engine already loaded
    mocks.startPaymentFn.mockResolvedValue({
      transactionId: TX,
      provider: "payfast",
      redirectUrl: "https://sandbox.payfast.co.za/eng/process?a=1",
      amount: 275,
      currency: "ZAR",
      fxRate: null,
      onsite: { uuid: UUID, engineUrl: SANDBOX_ENGINE },
    });
  });
  afterEach(() => {
    cleanup();
    delete (window as W).payfast_do_onsite_payment;
  });
  const panel = (navigate = vi.fn(), autoStart = false) => {
    render(
      <PaymentPanel
        orderId={ORDER}
        orderNumber="CP-1001"
        method="card"
        total={275}
        onsite
        autoStart={autoStart}
        navigate={navigate}
      />,
    );
    return navigate;
  };

  it("shows the server's amount on the button and sends ids only", async () => {
    const user = userEvent.setup();
    engine.mockImplementation(() => undefined); // window stays open
    panel();
    const pay = screen.getByRole("button", { name: /^pay r275[,.]00$/i });
    await user.click(pay);
    await screen.findByText(/Complete your payment in the secure PayFast window/);
    const sent = mocks.startPaymentFn.mock.calls[0]![0].data;
    expect(Object.keys(sent).sort()).toEqual(["key", "orderId", "provider"]);
    expect(sent).toMatchObject({ orderId: ORDER, provider: "payfast" });
    expect((pay as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Masterpass")).toBeTruthy();
    expect(screen.queryByText("Apple Pay")).toBeNull();
  });

  it("double clicks start one payment", async () => {
    engine.mockImplementation(() => undefined);
    panel();
    const pay = screen.getByRole("button", { name: /^pay r275/i });
    pay.click();
    pay.click();
    pay.click();
    await screen.findByText(/secure PayFast window/);
    expect(mocks.startPaymentFn).toHaveBeenCalledTimes(1);
  });

  it("PayFast saying 'done' only takes the member to the page that waits for verification", async () => {
    engine.mockImplementation((_o: unknown, cb: (r: boolean) => void) => cb(true));
    const navigate = panel(vi.fn(), true);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        `/payment/return?order=${ORDER}&provider=payfast&result=success`,
      ),
    );
    expect(screen.queryByText(/payment confirmed|paid/i)).toBeNull();
    expect(mocks.goToCheckout).not.toHaveBeenCalled();
  });

  it("a closed window offers a safe retry that first asks the server whether it was paid", async () => {
    const user = userEvent.setup();
    engine.mockImplementation((_o: unknown, cb: (r: boolean) => void) => cb(false));
    mocks.paymentStatusFn.mockResolvedValue({ paid: false, orderStatus: "awaiting_payment" });
    const navigate = panel(vi.fn(), true);
    await screen.findByText(/payment window was closed/i);
    await user.click(screen.getByRole("button", { name: /check status/i }));
    await screen.findByText(/have not received a confirmed payment/i);
    expect(navigate).not.toHaveBeenCalled();

    mocks.paymentStatusFn.mockResolvedValue({ paid: true, orderStatus: "paid" });
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        `/payment/return?order=${ORDER}&provider=payfast&result=success`,
      ),
    );
    expect(mocks.startPaymentFn).toHaveBeenCalledTimes(1); // no second charge attempt
  });

  it("a server refusal is shown without internals and the member can try again", async () => {
    const user = userEvent.setup();
    mocks.startPaymentFn.mockRejectedValueOnce(
      new Error("We could not start that payment. Please try again or choose another method."),
    );
    panel();
    await user.click(screen.getByRole("button", { name: /^pay r275/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not start that payment/);
    const retry = screen.getByRole("button", { name: /try again/i }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
  });
});
