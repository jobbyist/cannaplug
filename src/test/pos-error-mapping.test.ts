import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { friendlyPosError } from "@/lib/pos-data.server";

const SAME_REFERENCE =
  "That card or EFT reference was already used on another payment. Each payment needs its own slip or bank reference.";

describe("POS errors a cashier can act on", () => {
  it("a reused card or EFT reference says so (this used to read 'please retry')", () => {
    const unique = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "pos_tenders_reference_uidx"',
    };
    expect(friendlyPosError(unique).message).toBe(SAME_REFERENCE);
    expect(
      friendlyPosError({
        code: "23505",
        message:
          'duplicate key value violates unique constraint "pos_refund_payouts_reference_uidx"',
      }).message,
    ).toBe(SAME_REFERENCE);
    expect(friendlyPosError(new Error("payment_reference_in_use: x")).message).toBe(SAME_REFERENCE);
  });

  it("other duplicate-key errors and unknown errors stay generic, and nothing raw reaches the screen", () => {
    const other = friendlyPosError({
      code: "23505",
      message: 'duplicate key value violates unique constraint "pos_sales_receipt_number_key"',
    });
    expect(other.message).toBe("The action could not be completed. Please retry.");
    expect(friendlyPosError(new Error("boom: select * from secrets")).message).not.toMatch(
      /select|secrets/,
    );
  });

  it("keeps the other rule messages", () => {
    expect(
      friendlyPosError(new Error("tender_mismatch: tenders 49.00, total 50.00")).message,
    ).toMatch(/add up exactly/);
    expect(friendlyPosError(new Error("permission denied for table x")).message).toBe(
      "You do not have permission for this action",
    );
  });
});
