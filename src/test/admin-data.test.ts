import { describe, expect, it } from "vitest";
import { ORDER_TRANSITIONS } from "@/lib/admin-data.server";

describe("order fulfilment state machine", () => {
  it("allows only the defined forward fulfilment transitions", () => {
    expect(ORDER_TRANSITIONS.awaiting_payment).toEqual(["confirmed", "cancelled"]);
    expect(ORDER_TRANSITIONS.confirmed).toEqual(["packing", "cancelled"]);
    expect(ORDER_TRANSITIONS.packing).toEqual(["ready"]);
    expect(ORDER_TRANSITIONS.ready).toEqual(["out_for_delivery"]);
    expect(ORDER_TRANSITIONS.out_for_delivery).toEqual(["completed"]);
  });

  it("does not permit terminal orders to transition", () => {
    expect(ORDER_TRANSITIONS.completed).toEqual([]);
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
  });

  it("does not expose backward or skip-ahead fulfilment transitions", () => {
    expect(ORDER_TRANSITIONS.awaiting_payment).not.toContain("packing");
    expect(ORDER_TRANSITIONS.confirmed).not.toContain("ready");
    expect(ORDER_TRANSITIONS.packing).not.toContain("completed");
    expect(ORDER_TRANSITIONS.ready).not.toContain("completed");
    expect(ORDER_TRANSITIONS.out_for_delivery).not.toContain("cancelled");
    expect(ORDER_TRANSITIONS.completed).not.toContain("cancelled");
  });

  it("keeps database-level security cases in the SQL regression harness", () => {
    // RLS/grant/trigger behaviour cannot be faithfully tested with a mocked
    // client. The companion supabase/tests/milestone2_live_admin.sql covers:
    // historical order-line immutability, cross-user order visibility,
    // manager-vs-admin product deletion, and append-only audit tables.
    expect(ORDER_TRANSITIONS).toBeDefined();
  });
});
