import { describe, expect, it } from "vitest";
import { ORDER_TRANSITIONS } from "@/lib/admin-data.server";

describe("order fulfilment state machine", () => {
  it("allows only the defined forward fulfilment transitions", () => {
    expect(ORDER_TRANSITIONS.confirmed).toEqual(["packing", "cancelled"]);
    expect(ORDER_TRANSITIONS.packing).toEqual(["ready"]);
    expect(ORDER_TRANSITIONS.ready).toEqual(["out_for_delivery"]);
    expect(ORDER_TRANSITIONS.out_for_delivery).toEqual(["completed"]);
  });

  it("does not permit terminal orders to transition", () => {
    expect(ORDER_TRANSITIONS.completed).toEqual([]);
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
  });
});
