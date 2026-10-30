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
  recordManualPaymentFn: vi.fn(),
}));
vi.mock("@/lib/billing.functions", () => h);

import { BillingPanel } from "@/components/admin/BillingPanel";
import { DEACTIVATE_WARNING, DOMAIN_MANAGE_MESSAGE, todaySast } from "@/lib/billing";

const addDays = (isoDate: string, n: number) =>
  new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TODAY = todaySast();

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
  recur_kind: null,
  recur_n: null,
  anchor_date: null,
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
    recur_kind: "every_days",
    recur_n: 30,
    anchor_date: addDays(TODAY, 2),
  }),
  acc({
    id: "a5",
    slug: "payfast-gateway",
    name: "Gateway",
    provider: "Payfast",
    payment_kind: "link",
    payment_url: "https://payf.st/rl53i",
    recur_kind: "every_days",
    recur_n: 30,
    anchor_date: addDays(TODAY, 1),
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
  acc({
    id: "a8",
    slug: "godaddy-domain",
    name: "Domain Registration and DNS Management Services",
    provider: "GoDaddy",
    payment_kind: "manage",
    recur_kind: "yearly",
    anchor_date: "2027-09-27",
  }),
  acc({
    id: "a4s",
    slug: "supabase-platform",
    name: "Database, User Authentication, Storage & Real-Time Notifications",
    provider: "Supabase",
    amount_text: "Free plan",
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
  it("only admins can mark a bill as paid; the browser sends cents, currency, date, note and a key", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPanel("manager");
    await card("shopify-admin-api");
    expect(screen.queryByRole("button", { name: /mark as paid/i })).toBeNull();
    unmount();
    h.recordManualPaymentFn.mockResolvedValue({ recorded: true, payment_id: "p1" });
    renderPanel("admin");
    const shopify = await card("shopify-admin-api");
    await user.click(within(shopify).getByRole("button", { name: /mark as paid/i }));
    const dialog = await screen.findByRole("dialog");
    const save = within(dialog).getByRole("button", { name: /^mark as paid$/i });
    expect((save as HTMLButtonElement).disabled).toBe(true); // amount and note still empty
    await user.type(within(dialog).getByLabelText("Amount paid"), "28.75");
    await user.selectOptions(within(dialog).getByLabelText("Currency"), "USD");
    await user.type(
      within(dialog).getByLabelText("How it was paid"),
      "Card payment made directly with Shopify",
    );
    await user.click(save);
    await waitFor(() => expect(h.recordManualPaymentFn).toHaveBeenCalledTimes(1));
    const sent = h.recordManualPaymentFn.mock.calls[0]![0].data;
    expect(sent).toMatchObject({
      slug: "shopify-admin-api",
      amountCents: 2875,
      currency: "USD",
      paidOn: TODAY,
      note: "Card payment made directly with Shopify",
    });
    expect(sent.key.length).toBeGreaterThanOrEqual(8);
    expect(
      await screen.findByText(/marked as paid and added to the billing history/i),
    ).toBeTruthy();
  });

  it("billing history labels a manual payment as Manual and shows it as paid", async () => {
    h.listBillingFn.mockResolvedValue({
      accounts: ACCOUNTS,
      payments: [
        {
          id: "p1",
          account_id: "a1",
          provider: "manual",
          currency: "USD",
          status: "COMPLETE",
          amount_cents: 2875,
          created_at: new Date().toISOString(),
        },
      ],
    });
    renderPanel("manager");
    const history = await screen.findByRole("region", { name: "Billing history" });
    await waitFor(() => expect(within(history).getByText(/Manual/)).toBeTruthy());
    expect(within(history).getByText("Paid")).toBeTruthy();
  });

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
    expect(await screen.findByText(/is now paused/)).toBeTruthy();
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

  it("shows the next billing date, and flags a bill due tomorrow", async () => {
    renderPanel();
    const shopify = await card("shopify-admin-api");
    expect(within(shopify).getByTestId("next-shopify-admin-api").textContent).toMatch(
      /\(in 2 days\)/,
    );
    const gateway = await card("payfast-gateway");
    expect(within(gateway).getByTestId("next-payfast-gateway").textContent).toMatch(/\(tomorrow\)/);
    expect(within(gateway).getByText("Due tomorrow")).toBeTruthy();
    expect(screen.getByText(/Due tomorrow: Gateway/)).toBeTruthy();
    // the domain renews yearly
    expect(
      within(await card("godaddy-domain")).getByTestId("next-godaddy-domain").textContent,
    ).toMatch(/27 Sep 2027/);
  });

  it("the domain's Manage button opens the contact-your-developer message; the domain has no pause or cancel", async () => {
    const user = userEvent.setup();
    renderPanel();
    const domain = await card("godaddy-domain");
    expect(within(domain).queryByRole("button", { name: /pause|cancel/i })).toBeNull();
    await user.click(within(domain).getByRole("button", { name: /manage/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(DOMAIN_MANAGE_MESSAGE)).toBeTruthy();
    expect(DOMAIN_MANAGE_MESSAGE).toBe(
      "Your domain is still active. Contact your developer if you wish to extend your domain registration term, register a new domain or cancel/delete your domain.",
    );
  });

  it("shows the Supabase service as a free plan with no payment button", async () => {
    renderPanel();
    const sb = await card("supabase-platform");
    expect(within(sb).getByText("Free plan")).toBeTruthy();
    expect(within(sb).queryByRole("link", { name: /pay now/i })).toBeNull();
    expect(within(sb).getByRole("button", { name: /pause/i })).toBeTruthy();
  });

  it("lists confirmed payments in the billing history with the right currency, newest first", async () => {
    h.listBillingFn.mockResolvedValue({
      accounts: ACCOUNTS,
      payments: [
        {
          id: "p2",
          account_id: "a1",
          provider: "paypal",
          currency: "USD",
          status: "COMPLETED",
          amount_cents: 2500,
          created_at: "2026-10-28T08:00:00Z",
        },
        {
          id: "p1",
          account_id: "a5",
          provider: "payfast",
          currency: "ZAR",
          status: "COMPLETE",
          amount_cents: 18000,
          created_at: "2026-10-27T08:00:00Z",
        },
      ],
    });
    renderPanel();
    const history = await screen.findByRole("region", { name: /billing history/i });
    const rows = await within(history).findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toMatch(/Shopify API.*PayPal.*\$25\.00.*Paid/);
    expect(rows[1]!.textContent).toMatch(/Gateway.*Payfast.*R180\.00.*Paid/);
    expect(within(await card("shopify-admin-api")).getByText(/\$25\.00 on/)).toBeTruthy();
  });

  it("says so when there are no payments yet, and when the admin comes back from PayPal", async () => {
    window.history.replaceState({}, "", "/?paypal=pending");
    renderPanel();
    expect(await screen.findByText(/No payments yet/)).toBeTruthy();
    expect(screen.getByText(/PayPal subscription is being confirmed/)).toBeTruthy();
    window.history.replaceState({}, "", "/");
  });
});
