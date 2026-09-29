import { describe, expect, it } from "vitest";
import {
  addToCart,
  cartTotalCents,
  cashChangeCents,
  clampQuantity,
  createKeyStore,
  defaultPayouts,
  parseCents,
  parseQuickQuantity,
  removeLine,
  searchCatalog,
  setLineQuantity,
  tenderStatus,
  type CatalogItem,
  type TenderRow,
} from "@/components/admin/pos/pos-logic";

const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  id: "p1",
  slug: "blue-gelato",
  name: "Blue Gelato",
  category: "Flower",
  subcategory: "Greenhouse",
  strain_type: "Hybrid",
  unit: "per gram",
  price_rand: 50,
  available: 10,
  ...over,
});
const row = (over: Partial<TenderRow> = {}): TenderRow => ({
  rowId: "r",
  method: "cash",
  amount: "",
  reference: "",
  ...over,
});

describe("money parsing (cent-exact, no float drift)", () => {
  it.each([
    ["50", 5000],
    ["50.5", 5050],
    ["50.05", 5005],
    ["0.1", 10],
    ["R 12.30", 1230],
    [" 7 ", 700],
  ])("parses %s", (s, c) => {
    expect(parseCents(s)).toBe(c);
  });
  it.each(["", "abc", "-5", "5.001", "1e3", "5,00", "12345678901"])("rejects %j", (s) => {
    expect(parseCents(s)).toBeNull();
  });
  it("sums cart totals in integer cents", () => {
    const lines = [
      { product: item({ price_rand: 0.1 }), quantity: 3 },
      { product: item({ id: "p2", price_rand: 33.33 }), quantity: 3 },
    ];
    expect(cartTotalCents(lines)).toBe(30 + 9999); // 0.1*3 + 33.33*3 with no floating-point error
  });
});

describe("speed-first search", () => {
  const catalog = [
    item({ id: "a", name: "Blue Gelato", available: 0 }),
    item({
      id: "b",
      name: "Blueberry Kush",
      category: "Flower",
      strain_type: "Indica",
      slug: "blueberry-kush",
    }),
    item({ id: "c", name: "Sour OG", slug: "sour-og", strain_type: "Sativa" }),
    item({ id: "d", name: "Gelato Pre-roll", category: "Pre-rolls", slug: "gelato-preroll" }),
  ];
  it("requires every token to match across fields and ranks in-stock first", () => {
    expect(searchCatalog(catalog, "gelato").map((p) => p.id)).toEqual(["d", "a"]); // in-stock before out-of-stock
    expect(searchCatalog(catalog, "flower indica").map((p) => p.id)).toEqual(["b"]);
    expect(searchCatalog(catalog, "zzz")).toEqual([]);
  });
  it("shows the catalogue when the query is empty and respects the limit", () => {
    expect(searchCatalog(catalog, "", 2)).toHaveLength(2);
  });
  it("parses quick quantities: 3*blue, 3x blue, 3 × blue", () => {
    expect(parseQuickQuantity("3*blue")).toEqual({ quantity: 3, term: "blue" });
    expect(parseQuickQuantity("12x og")).toEqual({ quantity: 12, term: "og" });
    expect(parseQuickQuantity("blue")).toEqual({ quantity: 1, term: "blue" });
    expect(searchCatalog(catalog, "2*sour").map((p) => p.id)).toEqual(["c"]);
  });
});

describe("cart quantity controls", () => {
  it("clamps to 1..available (display hint only — the server re-checks stock)", () => {
    expect(clampQuantity(0, 5)).toBe(1);
    expect(clampQuantity(99, 5)).toBe(5);
    expect(clampQuantity(2.9, 5)).toBe(2);
    expect(clampQuantity(NaN, 5)).toBe(1);
    expect(clampQuantity(3, 0)).toBe(1);
  });
  it("adds, increments, sets and removes lines", () => {
    let lines = addToCart([], item({ available: 3 }));
    lines = addToCart(lines, item({ available: 3 }), 5);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe(3); // capped at what the till believes is available
    lines = setLineQuantity(lines, "p1", 2);
    expect(lines[0]!.quantity).toBe(2);
    expect(removeLine(lines, "p1")).toEqual([]);
  });
});

describe("tender reconciliation (client mirror of the server rule sum(tenders) == total)", () => {
  it("is ok only when tenders equal the total to the cent", () => {
    expect(tenderStatus(10000, [row({ amount: "100" })]).ok).toBe(true);
    expect(tenderStatus(10000, [row({ amount: "99.99" })])).toMatchObject({
      ok: false,
      remainingCents: 1,
    });
    expect(tenderStatus(10000, [row({ amount: "100.01" })])).toMatchObject({
      ok: false,
      overCents: 1,
    });
  });
  it("supports multi-tender and requires references on non-cash tenders", () => {
    const split = [
      row({ amount: "40" }),
      row({ method: "card", amount: "60", reference: "SLIP-1234" }),
    ];
    expect(tenderStatus(10000, split).ok).toBe(true);
    expect(
      tenderStatus(10000, [
        row({ amount: "40" }),
        row({ method: "card", amount: "60", reference: "12" }),
      ]).ok,
    ).toBe(false);
  });
  it("rejects empty, zero and malformed rows", () => {
    expect(tenderStatus(10000, []).ok).toBe(false);
    expect(tenderStatus(10000, [row({ amount: "0" })]).ok).toBe(false);
    expect(tenderStatus(10000, [row({ amount: "abc" })]).ok).toBe(false);
    expect(tenderStatus(0, [row({ amount: "0" })]).ok).toBe(false);
  });
  it("computes cash change for the till", () => {
    expect(cashChangeCents(20000, 15050)).toBe(4950);
    expect(cashChangeCents(100, 5000)).toBe(0);
  });
});

describe("idempotency keys", () => {
  it("re-uses the key for the same request and rotates it when the request changes", () => {
    let n = 0;
    const store = createKeyStore(() => `key-${++n}`);
    const a = store.keyFor("basket-1");
    expect(store.keyFor("basket-1")).toBe(a); // network retry -> same key -> server replays
    expect(store.keyFor("basket-2")).not.toBe(a); // changed payload -> new key
    store.reset();
    expect(store.keyFor("basket-2")).not.toBe(a);
  });
});

describe("refund payout defaults", () => {
  it("splits across tender methods by remaining capacity without exceeding it", () => {
    expect(defaultPayouts(4000, { cash: 2000, card: 6000 })).toEqual([
      { method: "card", cents: 4000 },
    ]);
    expect(defaultPayouts(7000, { cash: 2000, card: 6000 })).toEqual([
      { method: "card", cents: 6000 },
      { method: "cash", cents: 1000 },
    ]);
    expect(defaultPayouts(500, {})).toEqual([]);
  });
});
