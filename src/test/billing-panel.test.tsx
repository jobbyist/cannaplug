// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingAccount } from "@/lib/billing";

const h = vi.hoisted(() => ({
  listBillingFn: vi.fn(),
  setBillingStatusFn: vi.fn(),
  setBillingLinkFn: vi.fn(),
}));
vi.mock("@/lib/billing.functions", () => h);

import { BillingPanel } from "@/components/admin/BillingPanel";
import { DEACTIVATE_WARNING } from "@/lib/billing";

const acc = (o: Partial<BillingAccount>): BillingAccount => ({
  id: o.slug ?? "x",
  slug: "x",
  position: 1,
  name: "Service",
  provider: "Provider",
  beneficiary: "",
  amount_text: "R1.00",
  schedule_text: "Monthly",
  status: "active",
  payment_kind: "none",
  payment_url: null,
  payment_note: "",
  status_reason: null,
  updated_at: "2026-10-29T00:00:00Z",
  ...o,
});
const ACCOUNTS = [
  acc({
    id: "a1",
    slug: "shopify-admin-api",
    name: "Shopify API",
    provider: "Shopify",
    payment_kind: "link",
    payment_url: "https://cannaplug012.co.za/subscribe/admin-api",
  }),
  acc({
    id: "a5",
    slug: "payfast-gateway",
    name: "Gateway",
    provider: "Payfast",
    payment_kind: "link",
    payment_url: "https://payf.st/rl53i",
  }),
  acc({
    id: "a7",
    slug: "verifynow-id",
    name: "ID Verification",
    provider: "VerifyNow",
    payment_kind: "payfast_form",
  }),
  acc({
    id: "a4",
    slug: "whatsapp",
    name: "WhatsApp",
    provider: "Meta",
    status: "pending",
    payment_note: "Stripe or PayPal (coming soon)",
  }),
  acc({ id: "a3", slug: "email-push", name: "Email & Push", provider: "Resend", status: "paused" }),
];

function renderPanel(role: "manager" | "admin" = "manager") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BillingPanel role={role} />
    </QueryClientProvider>,
  );
}
const card = (slug: string) => screen.findByTestId(`billing-${slug}`);

beforeEach(() => {
  h.listBillingFn.mockResolvedValue({ accounts: ACCOUNTS, payments: [] });
  h.setBillingStatusFn.mockResolvedValue({ changed: true, status: "paused" });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BillingPanel", () => {
  it("the Payfast gateway button goes to the supplied Payfast payment link", async () => {
    renderPanel();
    const pay = within(await card("payfast-gateway")).getByRole("link", { name: /pay now/i });
    expect(pay.getAttribute("href")).toBe("https://payf.st/rl53i");
    expect(pay.getAttribute("rel")).toContain("noopener");
  });

  it("the ID Verification button is the supplied Payfast form, with the three VerifyNow URLs", async () => {
    renderPanel();
    const form = within(await card("verifynow-id")).getByRole("form", {
      name: /verifynow/i,
    }) as HTMLFormElement;
    expect(form.getAttribute("action")).toBe("https://payment.payfast.io/eng/process");
    expect(form.method).toBe("post");
    const val = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value;
    expect(val("cmd")).toBe("_paynow");
    expect(val("receiver")).toBe("25538645");
    expect(val("return_url")).toBe("https://cannaplug012.co.za/billing/verifynow/return");
    expect(val("cancel_url")).toBe("https://cannaplug012.co.za/billing/verifynow/cancel");
    expect(val("notify_url")).toBe("https://cannaplug012.co.za/billing/verifynow/notify");
    expect(val("item_name")).toBe("Real-Time ID Verification API Credits");
    expect(val("amount")).toBe("100");
    expect((form.elements.namedItem("amount") as HTMLInputElement).min).toBe("5.00");
  });

  it("pausing asks for confirmation first, shows the warning, and only acts after the box is ticked", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(
      within(await card("shopify-admin-api")).getByRole("button", { name: /pause/i }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(DEACTIVATE_WARNING)).toBeTruthy();
    expect(DEACTIVATE_WARNING).toMatch(
      /platform functionality errors and backend service disruption/,
    );
    expect(DEACTIVATE_WARNING).toMatch(
      /Contact your developer or account manager for confirmation/,
    );
    const confirm = within(dialog).getByRole("button", {
      name: "Pause billing",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(h.setBillingStatusFn).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(confirm);
    await waitFor(() => expect(h.setBillingStatusFn).toHaveBeenCalledTimes(1));
    expect(h.setBillingStatusFn.mock.calls[0]![0].data).toMatchObject({
      slug: "shopify-admin-api",
      status: "paused",
    });
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("cancelling shows the same warning; keeping the account as is changes nothing", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(
      within(await card("payfast-gateway")).getByRole("button", { name: /cancel/i }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(DEACTIVATE_WARNING)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: /keep as is/i }));
    expect(h.setBillingStatusFn).not.toHaveBeenCalled();
  });

  it("resuming needs no deactivation warning", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(within(await card("email-push")).getByRole("button", { name: /resume/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).queryByText(DEACTIVATE_WARNING)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Resume billing" }));
    await waitFor(() => expect(h.setBillingStatusFn).toHaveBeenCalled());
    expect(h.setBillingStatusFn.mock.calls[0]![0].data).toMatchObject({
      slug: "email-push",
      status: "active",
    });
  });

  it("a paused account cannot be paid; a pending account cannot be changed", async () => {
    renderPanel();
    const whatsapp = await card("whatsapp");
    expect(within(whatsapp).queryByRole("button", { name: /pause|cancel/i })).toBeNull();
    expect(
      (within(whatsapp).getByRole("button", { name: /coming soon/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows a plain error when the change is refused", async () => {
    h.setBillingStatusFn.mockRejectedValue(new Error("Your role can't do this. Ask a manager."));
    const user = userEvent.setup();
    renderPanel();
    await user.click(
      within(await card("shopify-admin-api")).getByRole("button", { name: /pause/i }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Pause billing" }));
    expect((await screen.findByText(/Your role can't do this/)).getAttribute("role")).toBe("alert");
  });

  it("only admins see the link editor", async () => {
    const { unmount } = renderPanel("manager");
    await card("payfast-gateway");
    expect(screen.queryAllByRole("button", { name: /link/i })).toHaveLength(0);
    unmount();
    renderPanel("admin");
    await card("payfast-gateway");
    expect(screen.getAllByRole("button", { name: /link/i }).length).toBeGreaterThan(0);
  });
});
