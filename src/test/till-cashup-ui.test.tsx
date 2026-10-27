// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  addPosExpenseFn: vi.fn(),
  voidPosExpenseFn: vi.fn(),
  closePosSessionFn: vi.fn(),
}));
vi.mock("@/lib/pos.functions", () => server);

import { CloseTill, TillExpenses } from "@/components/admin/pos/TillCashup";
import { cashupLines, reconciles, type CloseResult } from "@/components/admin/pos/cashup-logic";

const SESSION = "11111111-1111-4111-8111-111111111111";
const closed: CloseResult = {
  opening_float: 500,
  cash_sales: 3080,
  cash_refunds: 0,
  expenses_total: 1200,
  discounts_total: 220,
  expected_cash: 2380,
  actual_cash: 2380,
  variance: 0,
  cash_deposited: 2000,
  float_carried: 380,
  approval_status: "not_required",
  sales_count: 18,
};

describe("till cash-up maths (display)", () => {
  it("lists every line and checks they add up", () => {
    const labels = cashupLines(closed).map((l) => l.label);
    expect(labels).toEqual([
      "Opening float",
      "Cash taken from sales (after discounts)",
      "Discounts given (already off the sales)",
      "Cash refunds paid out",
      "Till expenses paid in cash",
      "Expected cash in drawer",
      "Counted cash",
      "Variance (counted - expected)",
      "Taken out for the bank deposit",
      "Float left for the next session",
    ]);
    expect(reconciles(closed)).toBe(true);
    expect(reconciles({ ...closed, float_carried: 400 })).toBe(false);
    expect(reconciles({ ...closed, expected_cash: 2400 })).toBe(false);
  });
});

describe("till expenses and close", () => {
  beforeEach(() => Object.values(server).forEach((m) => m.mockReset()));
  afterEach(() => cleanup());

  it("records an expense with ids, amount, category and description only", async () => {
    const user = userEvent.setup();
    const changed = vi.fn(async () => {});
    server.addPosExpenseFn.mockResolvedValue({ expense_id: "e1" });
    render(
      <TillExpenses sessionId={SESSION} cashup={null} isManager={false} onChanged={changed} />,
    );
    await user.type(screen.getByLabelText(/Amount/), "45.5");
    await user.selectOptions(screen.getByLabelText("Category"), "cleaning");
    await user.type(screen.getByLabelText("What for"), "Mop and bucket");
    await user.click(screen.getByRole("button", { name: /Add/ }));
    await waitFor(() => expect(server.addPosExpenseFn).toHaveBeenCalled());
    const sent = server.addPosExpenseFn.mock.calls[0]![0].data;
    expect(sent).toMatchObject({
      sessionId: SESSION,
      amount: "45.50",
      category: "cleaning",
      description: "Mop and bucket",
    });
    expect(Object.keys(sent).sort()).toEqual([
      "amount",
      "category",
      "description",
      "key",
      "sessionId",
    ]);
    expect(changed).toHaveBeenCalled();
  });

  it("refuses an empty description or amount before calling the server", async () => {
    const user = userEvent.setup();
    render(
      <TillExpenses sessionId={SESSION} cashup={null} isManager={false} onChanged={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /Add/ }));
    expect(await screen.findByText(/Enter the amount paid out/)).toBeTruthy();
    expect(server.addPosExpenseFn).not.toHaveBeenCalled();
  });

  it("lists recorded expenses with the total; only the recorder or a manager can remove one", () => {
    render(
      <TillExpenses
        sessionId={SESSION}
        isManager={false}
        onChanged={vi.fn()}
        cashup={{
          expenses: [
            {
              id: "a",
              amount: 50,
              category: "food",
              description: "Staff lunch",
              created_at: "",
              mine: true,
            },
            {
              id: "b",
              amount: 20,
              category: "transport",
              description: "Taxi",
              created_at: "",
              mine: false,
            },
          ],
          expensesTotal: 70,
          discountsTotal: 0,
        }}
      />,
    );
    const list = screen.getByTestId("till-expenses");
    expect(within(list).getByText(/R70/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Remove expense Staff lunch/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remove expense Taxi/ })).toBeNull();
  });

  it("closes with the counted cash and the bank deposit, shows tomorrow's float, then the full reconciliation", async () => {
    const user = userEvent.setup();
    server.closePosSessionFn.mockResolvedValue(closed);
    render(
      <CloseTill
        session={{ id: SESSION, opening_float: 500 }}
        cashup={{ expenses: [], expensesTotal: 1200, discountsTotal: 220 }}
        onChanged={vi.fn()}
      />,
    );
    // Expected cash is not shown before the count (blind count).
    expect(screen.queryByText("Expected cash in drawer")).toBeNull();
    expect(screen.getByText("Till expenses recorded").nextSibling?.textContent).toMatch(/R1.?200/);
    await user.type(screen.getByLabelText(/Counted cash/), "2380");
    await user.type(screen.getByLabelText(/bank deposit/), "2000");
    expect(screen.getByText(/Float left in the drawer for the next session: R380/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close till" }));
    await waitFor(() => expect(server.closePosSessionFn).toHaveBeenCalled());
    expect(server.closePosSessionFn.mock.calls[0]![0].data).toMatchObject({
      sessionId: SESSION,
      actualCash: "2380.00",
      cashDeposited: "2000.00",
    });
    const done = await screen.findByTestId("till-closed");
    expect(within(done).getByText("Expected cash in drawer")).toBeTruthy();
    expect(within(done).getByText(/Till expenses paid in cash/)).toBeTruthy();
    expect(within(done).getByText(/Discounts given/)).toBeTruthy();
    expect(within(done).queryByText(/do not add up/)).toBeNull();
  });

  it("blocks a deposit larger than the count", async () => {
    const user = userEvent.setup();
    render(
      <CloseTill session={{ id: SESSION, opening_float: 500 }} cashup={null} onChanged={vi.fn()} />,
    );
    await user.type(screen.getByLabelText(/Counted cash/), "100");
    await user.type(screen.getByLabelText(/bank deposit/), "150");
    expect(screen.getAllByText(/deposit cannot be more/).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Close till" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(server.closePosSessionFn).not.toHaveBeenCalled();
  });
});
