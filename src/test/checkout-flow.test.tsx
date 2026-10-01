// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The real checkout page + the real cart, with the server boundary mocked. Proves what the browser
 * sends (ids, quantities, an owned address id, the displayed total, one idempotency key) and what it
 * never decides (prices, fees, totals, order numbers).
 */
const mocks = vi.hoisted(() => ({
  listDeliveryOptionsFn: vi.fn(),
  listCheckoutAddressesFn: vi.fn(),
  quoteCheckoutFn: vi.fn(),
  placeOrderFn: vi.fn(),
  saveAddressFn: vi.fn(),
}));

vi.mock("@/lib/checkout.functions", () => ({
  listDeliveryOptionsFn: mocks.listDeliveryOptionsFn,
  listCheckoutAddressesFn: mocks.listCheckoutAddressesFn,
  quoteCheckoutFn: mocks.quoteCheckoutFn,
  placeOrderFn: mocks.placeOrderFn,
}));
vi.mock("@/lib/member.functions", () => ({ saveAddressFn: mocks.saveAddressFn }));
vi.mock("@/components/CannaPlugHome", () => ({ Header: () => <header /> }));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "member@example.com", user_metadata: { full_name: "Mia Member" } },
  }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

import { CartProvider, useCart } from "@/lib/cart";
import { Route } from "@/routes/checkout";

const PRODUCT = "11111111-1111-4111-8111-111111111111";
const ADDRESS = "22222222-2222-4222-8222-222222222222";

const quote = (over: Record<string, unknown> = {}) => ({
  lines: [
    {
      product_id: PRODUCT,
      name: "Blue Gelato",
      quantity: 2,
      unit_price: 100,
      line_total: 200,
      available: 10,
      status: "ok",
    },
  ],
  orderable: true,
  subtotal: 200,
  delivery_method: "standard",
  delivery_label: "Standard delivery",
  delivery_fee: 80,
  total: 280,
  ...over,
});

function Seed() {
  const { add, lines } = useCart();
  return (
    <button
      onClick={() => add({ productId: PRODUCT, name: "Blue Gelato", price: 1, unit: "g" }, 2)}
      data-lines={lines.length}
    >
      seed
    </button>
  );
}

const Page = Route.options.component as () => ReactNode;
function renderPage() {
  return render(
    <CartProvider>
      <Seed />
      <Page />
    </CartProvider>,
  );
}

async function toPayment(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText("seed"));
  await user.click(await screen.findByRole("button", { name: /continue/i }));
  await user.clear(await screen.findByLabelText("Full name"));
  await user.type(screen.getByLabelText("Full name"), "Mia Member");
  await user.type(screen.getByLabelText("Phone"), "+27 82 000 0000");
  await screen.findByText(/12 Long Street/);
  await user.click(screen.getByRole("button", { name: /continue/i }));
  await user.click(await screen.findByLabelText(/Discreet delivery/));
  await user.click(screen.getByRole("button", { name: /continue/i }));
}

describe("checkout end to end (server mocked)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.listDeliveryOptionsFn.mockResolvedValue([
      {
        code: "standard",
        label: "Standard delivery",
        description: "2–3 working days",
        fee_rand: 80,
      },
      {
        code: "discreet",
        label: "Discreet delivery",
        description: "Plain packaging",
        fee_rand: 120,
      },
    ]);
    mocks.listCheckoutAddressesFn.mockResolvedValue([
      {
        id: ADDRESS,
        label: "Home",
        recipient_name: null,
        phone: null,
        line1: "12 Long Street",
        line2: null,
        suburb: null,
        city: "Cape Town",
        province: null,
        postal_code: null,
        delivery_notes: null,
        is_default: true,
      },
    ]);
  });
  afterEach(() => cleanup());

  it("places a real order from server-priced numbers and then clears the cart", async () => {
    const user = userEvent.setup();
    mocks.quoteCheckoutFn.mockResolvedValue(
      quote({ delivery_method: "discreet", delivery_fee: 120, total: 320 }),
    );
    mocks.placeOrderFn.mockResolvedValue({
      order_id: "o1",
      order_number: "CP-2609-0042",
      status: "awaiting_payment",
      subtotal: 200,
      delivery_fee: 120,
      total: 320,
      payment_method: "eft",
      hold_minutes: 120,
    });
    renderPage();
    await toPayment(user);

    // The Payment step shows the SERVER total, not a browser sum (the cart held R1 prices).
    const button = await screen.findByRole("button", { name: /place order · R320/i });
    expect(mocks.quoteCheckoutFn).toHaveBeenLastCalledWith({
      data: { items: [{ productId: PRODUCT, quantity: 2 }], deliveryMethod: "discreet" },
    });
    await user.click(button);

    await screen.findByText("Order placed");
    const call = mocks.placeOrderFn.mock.calls[0]![0].data;
    expect(call).toMatchObject({
      items: [{ productId: PRODUCT, quantity: 2 }],
      contactName: "Mia Member",
      contactPhone: "+27 82 000 0000",
      deliveryMethod: "discreet",
      addressId: ADDRESS,
      paymentMethod: "eft",
      expectedTotal: 320,
      notes: null,
    });
    expect(call.key).toMatch(/^[0-9a-f-]{36}$/);
    // Browser never sends prices or a user id.
    expect(JSON.stringify(call)).not.toMatch(/price|userId|user_id|unit_price/i);

    // Real order number + EFT instructions with the order number as the reference.
    expect(screen.getAllByText("CP-2609-0042").length).toBeGreaterThan(1);
    expect(screen.getByText("Reference")).toBeTruthy();
    expect(screen.getByText("63210843975")).toBeTruthy();
    expect(screen.getByText(/R320/)).toBeTruthy();
    // The cart is emptied only after the server confirmed the order.
    expect(JSON.parse(window.localStorage.getItem("cannaplug.cart.v1") ?? "[]")).toEqual([]);
  });

  it("keeps the cart, shows the fresh total and uses a fresh key when the price moved", async () => {
    const user = userEvent.setup();
    mocks.quoteCheckoutFn
      .mockResolvedValueOnce(quote({ delivery_fee: 120, total: 320 }))
      .mockResolvedValue(quote({ subtotal: 220, delivery_fee: 120, total: 340 }));
    mocks.placeOrderFn.mockRejectedValueOnce(
      new Error(
        "Prices changed while you were reviewing — please check the new total (the current total is R340)",
      ),
    );
    renderPage();
    await toPayment(user);
    await user.click(await screen.findByRole("button", { name: /place order · R320/i }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/Prices changed/);
    await screen.findByRole("button", { name: /place order · R340/i });
    expect(screen.queryByText("Order placed")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("cannaplug.cart.v1") ?? "[]")).toHaveLength(1);

    mocks.placeOrderFn.mockResolvedValueOnce({
      order_id: "o2",
      order_number: "CP-2609-0043",
      status: "awaiting_payment",
      subtotal: 220,
      delivery_fee: 120,
      total: 340,
      payment_method: "eft",
      hold_minutes: 120,
    });
    await user.click(screen.getByRole("button", { name: /place order · R340/i }));
    await screen.findByText("Order placed");
    const [first, second] = mocks.placeOrderFn.mock.calls.map((c) => c[0].data);
    expect(second.expectedTotal).toBe(340);
    expect(second.key).not.toBe(first.key); // a new intent after the total changed
  });

  it("blocks ordering when the server says items are unavailable", async () => {
    const user = userEvent.setup();
    mocks.quoteCheckoutFn.mockResolvedValue(
      quote({
        orderable: false,
        total: null,
        lines: [
          {
            product_id: PRODUCT,
            name: "Blue Gelato",
            quantity: 2,
            unit_price: 100,
            line_total: 200,
            available: 1,
            status: "insufficient_stock",
          },
        ],
      }),
    );
    renderPage();
    await toPayment(user);
    expect(await screen.findByText(/no longer available in the quantity/i)).toBeTruthy();
    const place = screen.getByRole("button", { name: /place order/i }) as HTMLButtonElement;
    expect(place.disabled).toBe(true);
    expect(mocks.placeOrderFn).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /edit cart/i })).toBeTruthy();
  });

  it("only offers EFT and has no client-side promo or fake order number", async () => {
    const user = userEvent.setup();
    mocks.quoteCheckoutFn.mockResolvedValue(quote({ delivery_fee: 120, total: 320 }));
    renderPage();
    await toPayment(user);
    expect(screen.getByText("EFT / Bank transfer")).toBeTruthy();
    expect(screen.queryByText(/SnapScan/i)).toBeNull();
    expect(screen.queryByText(/Credit \/ Debit/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/promo/i)).toBeNull();
    expect(within(document.body).queryByText(/presentation prototype/i)).toBeNull();
  });

  it("requires contact details and a delivery address before continuing", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByText("seed"));
    await user.click(await screen.findByRole("button", { name: /continue/i }));
    await screen.findByText(/12 Long Street/);
    const next = screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement;
    expect(next.disabled).toBe(true); // phone missing
    await user.type(screen.getByLabelText("Phone"), "abc");
    expect(next.disabled).toBe(true); // invalid phone
    await user.clear(screen.getByLabelText("Phone"));
    await user.type(screen.getByLabelText("Phone"), "0820000000");
    await waitFor(() => expect(next.disabled).toBe(false));
  });

  it("saves a new address through the server and selects it", async () => {
    const user = userEvent.setup();
    mocks.listCheckoutAddressesFn.mockResolvedValueOnce([]);
    mocks.saveAddressFn.mockResolvedValue({ id: ADDRESS });
    renderPage();
    await user.click(screen.getByText("seed"));
    await user.click(await screen.findByRole("button", { name: /continue/i }));
    await user.click(await screen.findByText(/\+ Add a new address/));
    await user.type(screen.getByLabelText("Street address"), "5 New Road");
    await user.type(screen.getByLabelText("City"), "Durban");
    mocks.listCheckoutAddressesFn.mockResolvedValue([
      {
        id: ADDRESS,
        label: "Delivery",
        recipient_name: null,
        phone: null,
        line1: "5 New Road",
        line2: null,
        suburb: null,
        city: "Durban",
        province: null,
        postal_code: null,
        delivery_notes: null,
        is_default: true,
      },
    ]);
    await user.click(screen.getByRole("button", { name: /save address/i }));
    await screen.findByText(/5 New Road, Durban/);
    expect(mocks.saveAddressFn.mock.calls[0]![0].data).toMatchObject({
      address: { line1: "5 New Road", city: "Durban" },
      makeDefault: true,
    });
  });
});
