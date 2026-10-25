import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GENERIC_STAFF_ERROR, friendlyStaffError } from "@/lib/staff-errors";

const RAW_TOKENS =
  /violates|relation|column|constraint|syntax|duplicate key|permission denied|row-level|JWT|PGRST|SQLSTATE|supabase|postgres|null value|foreign key|TypeError|undefined|ECONN|fetch failed|stack|\.ts:\d|"code"|public\.|_[a-z]+_[a-z]+/i;

/** What a database, PostgREST, the network, zod or a bug can throw. */
const RAW: unknown[] = [
  { message: 'duplicate key value violates unique constraint "products_sku_key"', code: "23505" },
  {
    message: 'new row for relation "products" violates check constraint "products_sale_price_chk"',
    code: "23514",
  },
  { message: "permission denied for function bulk_upsert_products", code: "42501" },
  { message: 'column "cost_rand" does not exist', code: "42703" },
  { message: "JWT expired", code: "PGRST301" },
  { message: 'invalid input syntax for type uuid: "abc"', code: "22P02" },
  {
    message: 'null value in column "name" of relation "products" violates not-null constraint',
    code: "23502",
  },
  new Error("fetch failed"),
  new TypeError("Cannot read properties of undefined (reading 'id')"),
  new Error(
    '[\n  {\n    "code": "invalid_type",\n    "expected": "string",\n    "path": ["drawerId"]\n  }\n]',
  ),
  new Error("Unauthorized: No authorization header provided"),
  new Error("Forbidden: insufficient staff permissions"),
  new Error("some_unknown_code: SELECT * FROM public.pos_sales"),
  new Error(
    "insufficient_stock: product 3c2e… needs 5, has 2 (SQLSTATE P0001 at public._allocate)",
  ),
  new Error("Missing Supabase environment variable(s): SUPABASE_URL."),
  "a string was thrown",
  { weird: true },
  null,
];

describe("staff errors: nothing raw reaches a staff screen", () => {
  for (const e of RAW) {
    it(`maps ${JSON.stringify(e instanceof Error ? e.message : e)?.slice(0, 70)}`, () => {
      const out = friendlyStaffError(e).message;
      expect(out.length).toBeGreaterThan(5);
      expect(out).not.toMatch(RAW_TOKENS);
    });
  }

  it("our database codes become sentences, with useful numbers kept", () => {
    expect(
      friendlyStaffError(new Error("tender_mismatch: R240.00 due, R200.00 tendered")).message,
    ).toBe("Tenders must add up exactly to the sale total (R240.00 due, R200.00 tendered)");
    expect(friendlyStaffError({ message: "drawer_already_open" }).message).toBe(
      "That drawer already has an open session",
    );
    expect(friendlyStaffError(new Error("forbidden: manager access required")).message).toMatch(
      /Ask a manager/,
    );
    expect(friendlyStaffError(new Error("brand_new_code: x")).message).toBe(GENERIC_STAFF_ERROR);
  });

  it("messages the app wrote for people pass through unchanged", () => {
    for (const m of [
      "That SKU is already used by another product.",
      "Fix the 3 problem rows before saving.",
      "That file is over 2 MB.",
    ])
      expect(friendlyStaffError(new Error(m)).message).toBe(m);
  });
});

describe("every staff server function has the error boundary first", () => {
  const MEMBER = new Set([
    "getMyVerificationFn",
    "createIdUploadFn",
    "submitVerificationFn",
    "startPaymentFn",
    "confirmPayPalReturnFn",
    "paymentStatusFn",
    "submitEftFn",
    "listMemberOrdersFn",
  ]);
  const files = [
    "src/lib/admin.functions.ts",
    "src/lib/pos.functions.ts",
    "src/lib/payments.functions.ts",
    "src/lib/receipts.functions.ts",
    "src/lib/catalogue.functions.ts",
    "src/lib/product-csv.functions.ts",
    "src/lib/verification.functions.ts",
  ];
  for (const f of files) {
    it(f, () => {
      const src = readFileSync(f, "utf8");
      const fns = src.split(/(?=^export const \w+ = createServerFn)/m).slice(1);
      for (const block of fns) {
        const name = /export const (\w+)/.exec(block)![1]!;
        if (MEMBER.has(name) || !block.includes("requireSupabaseAuth")) continue;
        expect(block, name).toContain(".middleware([friendlyStaffErrors, requireSupabaseAuth])");
      }
    });
  }
  it("src/lib/clinical/clinical.functions.ts", () => {
    const src = readFileSync("src/lib/clinical/clinical.functions.ts", "utf8");
    expect(src).toContain("const auth = [friendlyStaffErrors, requireSupabaseAuth] as const;");
    expect(src).not.toMatch(/\.middleware\(\[requireSupabaseAuth\]\)/);
  });
});
