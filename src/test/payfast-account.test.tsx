// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchTransactionHistory,
  parseCsv,
  parseHistory,
  payfastApiSignature,
  payfastTimestamp,
} from "@/lib/payments/payfast-api";
import { PAYOUT_SCHEDULE, summariseAccount } from "@/lib/payments/payfast-account";
import {
  getPayfastAccount,
  loadPayfastAccount,
  type PayfastAccountView,
} from "@/lib/payments/payfast-account.server";
import type { FetchLike } from "@/lib/payments/provider";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
const roles = vi.hoisted(() => ({ assertRole: vi.fn() }));
vi.mock("@/lib/admin-data.server", () => roles);
vi.mock("@/lib/payfast-account.functions", () => ({ getPayfastAccountFn: vi.fn() }));

import { PayfastAccountCard } from "@/components/admin/PayfastAccountCard";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const CFG = {
  merchantId: "10000100",
  merchantKey: "46f0cd694581a",
  passphrase: "jt7NOE43FZPn",
  sandbox: false,
};

// The sample from PayFast's Transaction History docs, plus a payout line.
const HEADER =
  'Date,Type,Sign,Party,Name,Description,Currency,"Funding Type",Gross,Fee,Net,Balance,"M Payment ID","PF Payment ID","custom str1","custom int1","custom str2","custom int2","custom str3","custom str4","custom str5","custom int3","custom int4","custom int5"';
const line = (
  date: string,
  type: string,
  sign: string,
  gross: string,
  fee: string,
  net: string,
  balance: string,
  funding = "CC",
  m = "",
  pf = "994209",
  name = "Test User 01",
) =>
  `"${date}",${type},${sign},"${name}","Cannaplug order CP-1","Buyer note ${name}",ZAR,${funding},${gross},${fee},${net},"${balance}",${m},${pf},,,,,,,,,,`;
const CSV = [
  HEADER,
  line("2026-10-26 13:29:55", "FUNDS_RECEIVED", "CREDIT", "500.00", "-24.73", "475.27", "1,475.27"),
  line(
    "2026-10-27 09:00:00",
    "PAYOUT",
    "DEBIT",
    "-1475.27",
    "-10.01",
    "-1485.28",
    "-10.01",
    "",
    "",
    "",
    "",
  ),
  line(
    "2026-10-27 11:15:20",
    "FUNDS_RECEIVED",
    "CREDIT",
    "121.00",
    "-7.73",
    "113.27",
    "103.26",
    "EFT",
    "11111111-1111-4111-8111-111111111111",
  ),
].join("\n");

describe("PayFast API signing (as PayFast's SDK does it)", () => {
  it("md5 over headers + query + passphrase, sorted by key, PHP-urlencoded", () => {
    const fields = {
      "merchant-id": "10000100",
      version: "v1",
      timestamp: "2026-10-27T21:00:00+0200",
      from: "2026-10-01",
      to: "2026-10-27",
    };
    const expected = md5(
      "from=2026-10-01&merchant-id=10000100&passphrase=jt7NOE43FZPn&timestamp=2026-10-27T21%3A00%3A00%2B0200&to=2026-10-27&version=v1",
    );
    expect(payfastApiSignature(fields, "jt7NOE43FZPn")).toBe(expected);
    expect(payfastApiSignature(fields, null)).not.toBe(expected);
    expect(payfastTimestamp(new Date("2026-10-27T19:00:00Z"))).toBe("2026-10-27T21:00:00+0200");
  });

  it("calls the history endpoint with signed headers; sandbox adds testing=true outside the signature", async () => {
    const calls: { url: string; headers?: Record<string, string> }[] = [];
    const f: FetchLike = async (url, init) => {
      calls.push({ url, ...(init?.headers ? { headers: init.headers } : {}) });
      return { ok: true, status: 200, text: async () => CSV };
    };
    const now = new Date("2026-10-27T19:00:00Z");
    await fetchTransactionHistory(CFG, f, { from: "2026-09-27", to: "2026-10-27" }, now);
    await fetchTransactionHistory(
      { ...CFG, sandbox: true },
      f,
      { from: "2026-09-27", to: "2026-10-27" },
      now,
    );
    expect(calls[0]!.url).toBe(
      "https://api.payfast.co.za/transactions/history?from=2026-09-27&to=2026-10-27",
    );
    expect(calls[1]!.url).toContain("testing=true");
    expect(calls[0]!.headers).toMatchObject({ "merchant-id": "10000100", version: "v1" });
    expect(calls[1]!.headers!["signature"]).toBe(calls[0]!.headers!["signature"]);
    expect(JSON.stringify(calls)).not.toContain("jt7NOE43FZPn");
    const fail: FetchLike = async () => ({ ok: false, status: 401, text: async () => "secret" });
    await expect(
      fetchTransactionHistory(CFG, fail, { from: "2026-09-27", to: "2026-10-27" }),
    ).rejects.toThrow("401");
    await expect(fetchTransactionHistory(CFG, fail, { from: "x", to: "y" })).rejects.toThrow(
      "dates",
    );
  });
});

describe("PayFast history parsing", () => {
  it("reads quoted thousands and never keeps the buyer's name", () => {
    expect(parseCsv('a,"b,c","d ""e"""\n1,2,3')).toEqual([
      ["a", "b,c", 'd "e"'],
      ["1", "2", "3"],
    ]);
    const rows = parseHistory(CSV);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      type: "FUNDS_RECEIVED",
      gross: 500,
      fee: -24.73,
      balance: 1475.27,
    });
    expect(rows[0]!.description).toBe(""); // buyer item text dropped
    expect(JSON.stringify(rows)).not.toContain("Test User 01");
    // Buyer payments lose PayFast's free text; our own payout line keeps PayFast's description.
    expect(rows[0]!.description).toBe("");
    expect(rows[2]!.description).toBe("");
    expect(rows[1]!.description).toBe("Buyer note");
    expect(() => parseHistory("foo,bar\n1,2")).toThrow("format");
  });

  it("summarises balance, today's payments, fees, payouts and the next payout", () => {
    const s = summariseAccount(parseHistory(CSV), "2026-10-27", "2026-09-27");
    expect(s.balance).toBe(103.26);
    expect(s.today).toMatchObject({ count: 1, gross: 121, fees: 7.73, net: 113.27 });
    expect(s.period).toMatchObject({ count: 2, gross: 621, fees: 32.46, payoutFees: 10.01 });
    expect(s.period.byMethod.map((m) => m.method)).toEqual(["Card", "Instant EFT"]);
    expect(s.payouts).toEqual([
      { date: "2026-10-27 09:00:00", amount: 1475.27, fee: 10.01, status: "completed" },
    ]);
    // R103.26 is over the R100 threshold and today's payout already ran.
    expect(s.next).toMatchObject({ status: "pending", when: "next daily run", amount: 103.26 });
    const low = summariseAccount(parseHistory(CSV).slice(0, 2), "2026-10-28", "2026-09-28");
    expect(low.next).toEqual({
      status: "below_threshold",
      short: 110.01,
      threshold: PAYOUT_SCHEDULE.thresholdRand,
    });
  });
});

describe("loading the account", () => {
  const env = {
    PAYFAST_MERCHANT_ID: "10000100",
    PAYFAST_MERCHANT_KEY: "46f0cd694581a",
    PAYFAST_PASSPHRASE: "jt7NOE43FZPn",
  };
  it("explains what is missing, and an API outage is 'unavailable', not zero", async () => {
    expect(await loadPayfastAccount({})).toEqual({ status: "not_configured" });
    expect(await loadPayfastAccount({ ...env, PAYFAST_PASSPHRASE: "" })).toEqual({
      status: "needs_passphrase",
    });
    const down: FetchLike = async () => ({ ok: false, status: 503, text: async () => "" });
    expect((await loadPayfastAccount(env, down)).status).toBe("unavailable");
    const ok: FetchLike = async () => ({ ok: true, status: 200, text: async () => CSV });
    const v = await loadPayfastAccount(env, ok, new Date("2026-10-27T12:00:00Z"));
    expect(v).toMatchObject({ status: "ok", mode: "live", balance: 103.26 });
  });
});

describe("who can see the PayFast account", () => {
  it("managers and admins only: a budtender is refused before PayFast is asked", async () => {
    roles.assertRole.mockRejectedValueOnce(new Error("forbidden"));
    await expect(getPayfastAccount("budtender-id")).rejects.toThrow("forbidden");
    expect(roles.assertRole).toHaveBeenCalledWith("budtender-id", "manager");
  });
});

describe("the PayFast account card", () => {
  afterEach(() => cleanup());
  const okView = async (): Promise<PayfastAccountView> => ({
    status: "ok",
    mode: "live",
    fetchedAt: "2026-10-27T12:00:00Z",
    schedule: PAYOUT_SCHEDULE,
    orderNumbers: { "11111111-1111-4111-8111-111111111111": "CP-2610-0042" },
    ...summariseAccount(parseHistory(CSV), "2026-10-27", "2026-09-27"),
  });

  it("shows the live balance, the pending and completed payouts, and fees by method", async () => {
    render(<PayfastAccountCard load={okView} />);
    expect((await screen.findByTestId("pf-balance")).textContent).toMatch(/R103[,.]26/);
    expect(screen.getByTestId("pf-next-payout").textContent).toMatch(/Payout pending/);
    const done = screen.getByLabelText("Completed payouts");
    expect(within(done).getByText(/Completed/).textContent).toMatch(/27 Oct/);
    expect(screen.getByText(/CP-2610-0042/)).toBeTruthy();
    expect(screen.getAllByText("Instant EFT").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("Test User 01");
  });

  it("opens a dialog with PayFast's fees for card, Instant EFT, Apple Pay, Google Pay, refunds and payouts", async () => {
    const user = userEvent.setup();
    render(<PayfastAccountCard load={okView} />);
    await user.click(await screen.findByRole("button", { name: /PayFast fees/i }));
    const dialog = await screen.findByRole("dialog");
    for (const t of ["Credit and debit card", "Instant EFT", "Apple Pay", "Google Pay", "Refund"])
      expect(within(dialog).getByText(t)).toBeTruthy();
    expect(within(dialog).getByText(/R8\.70 per payout/)).toBeTruthy();
    expect(within(dialog).getAllByText("3.2% + R2.00")).toHaveLength(3);
  });

  it("says when the balance is unavailable or the passphrase is missing, and refreshes on demand", async () => {
    const user = userEvent.setup();
    const load = vi
      .fn<() => Promise<PayfastAccountView>>()
      .mockResolvedValueOnce({ status: "unavailable", fetchedAt: "2026-10-27T12:00:00Z" })
      .mockResolvedValueOnce({ status: "needs_passphrase" });
    render(<PayfastAccountCard load={load} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/unavailable/);
    await user.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/PAYFAST_PASSPHRASE/),
    );
  });
});
