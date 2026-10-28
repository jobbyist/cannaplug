// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/id-credits.functions", () => ({
  getIdCreditsFn: vi.fn(),
  setIdCreditReserveFn: vi.fn(),
  topUpIdCreditsFn: vi.fn(),
  idCreditsOpenFn: vi.fn(),
}));

import { IdCreditsCard, type IdCreditsApi } from "@/components/admin/IdCreditsCard";
import { creditHealth } from "@/components/admin/credit-health";
import type { IdCreditSummary } from "@/lib/id-credits.server";
import { renderTemplate } from "@/lib/notifications/templates";

const summary = (o: Partial<IdCreditSummary> = {}): IdCreditSummary => ({
  total: 940,
  reserved: 558,
  available: 382,
  cost_per_check: 3,
  low_balance_threshold: 100,
  checks_left: 127,
  reserved_checks_left: 186,
  used_last_30_days: 18,
  charged_members: 6,
  low_alert_sent_at: null,
  alert_emails: ["admin@cannaplug012.co.za", "info@cannaplug012.co.za"],
  recent: [
    {
      id: 3,
      kind: "charge",
      credits: -3,
      reserved_delta: 0,
      note: "ID check",
      created_at: "2026-10-27T08:00:00Z",
    },
    {
      id: 2,
      kind: "reserve",
      credits: 558,
      reserved_delta: 558,
      note: "Reserved",
      created_at: "2026-10-27T07:00:00Z",
    },
  ],
  ...o,
});
const fakeApi = (s: IdCreditSummary) => {
  const api = {
    summary: vi.fn(async () => s),
    topUp: vi.fn(async (_i: Parameters<IdCreditsApi["topUp"]>[0]) => ({})),
    setReserve: vi.fn(async (_i: Parameters<IdCreditsApi["setReserve"]>[0]) => ({})),
  };
  return api;
};

afterEach(cleanup);

describe("ID-check credits card", () => {
  it("rates the balance", () => {
    expect(creditHealth(summary())).toBe("ok");
    expect(creditHealth(summary({ available: 100 }))).toBe("low");
    expect(creditHealth(summary({ available: 2 }))).toBe("depleted");
  });

  it("shows available and reserved credits and recent use", async () => {
    render(<IdCreditsCard canSetReserve={false} api={fakeApi(summary())} />);
    expect((await screen.findByTestId("credits-available")).textContent).toBe("382");
    expect(screen.getByText("558")).toBeTruthy();
    expect(screen.getByText("186 imported members")).toBeTruthy();
    expect(screen.getByText("New member ID check")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Reserve/ })).toBeNull();
  });

  it("warns when credits are used up", async () => {
    render(
      <IdCreditsCard
        canSetReserve
        api={fakeApi(
          summary({ available: 0, checks_left: 0, low_alert_sent_at: "2026-10-27T08:00:00Z" }),
        )}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /paused until credits are topped up/,
    );
  });

  it("any staff member records a top-up in a modal", async () => {
    const user = userEvent.setup();
    const api = fakeApi(summary());
    render(<IdCreditsCard canSetReserve={false} api={api} />);
    await user.click(await screen.findByRole("button", { name: /Record top-up/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "+200" }));
    await user.type(within(dialog).getByLabelText(/Reference/), "INV-9");
    expect(within(dialog).getByTestId("topup-preview").textContent).toMatch(/382 → 582/);
    await user.click(within(dialog).getByRole("button", { name: "Add 200 credits" }));
    await waitFor(() => expect(api.topUp).toHaveBeenCalled());
    expect(api.topUp.mock.calls[0]![0]).toMatchObject({ credits: 200, note: "INV-9" });
  });
});

describe("low-credit email", () => {
  it("asks for a top-up and carries balances only", () => {
    const r = renderTemplate(
      "id_credits_low",
      {
        available: 100,
        reserved: 558,
        threshold: 100,
        cost_per_check: 3,
      },
      { siteUrl: "https://cannaplug012.co.za" } as never,
    );
    expect(r!.subject).toBe("Top up your ID-check credits");
    expect(r!.text).toMatch(/avoid service disruption/);
    expect(r!.text).toMatch(/33/); // new-member checks left
    const out = renderTemplate("id_credits_low", { available: 0, cost_per_check: 3 }, {
      siteUrl: "https://cannaplug012.co.za",
    } as never);
    expect(out!.subject).toMatch(/used up/);
  });
});
