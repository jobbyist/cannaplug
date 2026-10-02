import { describe, expect, it } from "vitest";
import {
  ClinicalError,
  PRESCRIPTION_REQUIRED_FIELDS,
  formatInstantDate,
  formatIsoDate,
  friendlyClinicalError,
  meetsAssurance,
  normaliseWords,
  numberToWords,
  quantityWordsMatch,
  validatePrescription,
  type PrescriptionInput,
} from "@/lib/clinical/logic";

const NOW = new Date("2026-10-02T10:00:00Z");
const FUTURE = "2026-12-31T23:59:59+02:00";
// Values are test fixtures, not clinical suggestions.
const complete: PrescriptionInput = {
  medicine_name: "FIXTURE MEDICINE",
  dosage_form: "FIXTURE FORM",
  strength: "FIXTURE STRENGTH",
  quantity_numeric: 5,
  quantity_words: "five",
  directions: "FIXTURE DIRECTIONS",
  route: "FIXTURE ROUTE",
  frequency: "FIXTURE FREQUENCY",
  duration: "FIXTURE DURATION",
  repeats: 0,
  indication: "FIXTURE INDICATION",
};

describe("prescription validation (presence and format only)", () => {
  it("passes a complete prescription", () => {
    expect(validatePrescription(complete, FUTURE, NOW)).toEqual([]);
  });

  it("reports every missing practitioner-entered field and defaults none", () => {
    const problems = validatePrescription({}, null, NOW);
    expect(problems.map((p) => p.field).sort()).toEqual(
      [...PRESCRIPTION_REQUIRED_FIELDS, "expiry_date"].sort(),
    );
  });

  it("treats blank or whitespace text as missing", () => {
    expect(
      validatePrescription({ ...complete, strength: "   " }, FUTURE, NOW).map((p) => p.field),
    ).toEqual(["strength"]);
  });

  it("requires repeats to be entered explicitly: 0 is valid, absent is not", () => {
    expect(validatePrescription({ ...complete, repeats: 0 }, FUTURE, NOW)).toEqual([]);
    const { repeats: _r, ...rest } = complete;
    expect(validatePrescription(rest, FUTURE, NOW).map((p) => p.field)).toEqual(["repeats"]);
  });

  it.each([[0], [-3], [100000], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "rejects quantity %s",
    (q) => {
      expect(
        validatePrescription({ ...complete, quantity_numeric: q }, FUTURE, NOW).some(
          (p) => p.field === "quantity_numeric",
        ),
      ).toBe(true);
    },
  );

  it.each([[-1], [100], [1.5]])("rejects repeats %s", (r) => {
    expect(
      validatePrescription({ ...complete, repeats: r }, FUTURE, NOW).some(
        (p) => p.field === "repeats",
      ),
    ).toBe(true);
  });

  it("requires the quantity in words to agree with the figures", () => {
    expect(
      validatePrescription(
        { ...complete, quantity_numeric: 5, quantity_words: "six" },
        FUTURE,
        NOW,
      ).map((p) => p.field),
    ).toEqual(["quantity_words"]);
    expect(
      validatePrescription(
        { ...complete, quantity_numeric: 28, quantity_words: "Twenty-eight" },
        FUTURE,
        NOW,
      ),
    ).toEqual([]);
  });

  it("requires a future expiry date", () => {
    expect(validatePrescription(complete, "2026-10-01T00:00:00Z", NOW).map((p) => p.field)).toEqual(
      ["expiry_date"],
    );
    expect(validatePrescription(complete, null, NOW).map((p) => p.field)).toEqual(["expiry_date"]);
  });

  it("does not mutate or complete its input", () => {
    const input: PrescriptionInput = { medicine_name: "X" };
    validatePrescription(input, null, NOW);
    expect(input).toEqual({ medicine_name: "X" });
  });
});

describe("quantity words", () => {
  it.each([
    [1, "one"],
    [5, "five"],
    [10, "ten"],
    [13, "thirteen"],
    [21, "twenty one"],
    [28, "twenty eight"],
    [100, "one hundred"],
    [101, "one hundred and one"],
    [250, "two hundred and fifty"],
    [1000, "one thousand"],
    [1001, "one thousand and one"],
    [1250, "one thousand two hundred and fifty"],
    [3.5, "three point five"],
    [0.25, "zero point two five"],
    [99999, "ninety nine thousand nine hundred and ninety nine"],
  ])("%s -> %s", (n, words) => {
    expect(normaliseWords(numberToWords(n)!)).toBe(normaliseWords(words));
  });
  it("is null out of range", () => {
    expect(numberToWords(0)).toBeNull();
    expect(numberToWords(100000)).toBeNull();
    expect(numberToWords(-1)).toBeNull();
  });
  it("matches regardless of case, hyphens and 'and'", () => {
    expect(quantityWordsMatch(125, "One Hundred Twenty-Five")).toBe(true);
    expect(quantityWordsMatch(125, "one hundred and twenty five")).toBe(true);
    expect(quantityWordsMatch(125, "one hundred twenty six")).toBe(false);
  });
});

describe("dates", () => {
  it("formats ISO dates deterministically", () => {
    expect(formatIsoDate("2026-10-02")).toBe("02 October 2026");
    expect(formatIsoDate("garbage")).toBeNull();
    expect(formatIsoDate("2026-13-02")).toBeNull();
  });
  it("formats instants in South African time", () => {
    expect(formatInstantDate("2026-10-02T22:30:00Z")).toBe("03 October 2026");
  });
});

describe("signature assurance", () => {
  it("orders simple < advanced < qualified", () => {
    expect(meetsAssurance("SIMPLE", "ADVANCED")).toBe(false);
    expect(meetsAssurance("ADVANCED", "ADVANCED")).toBe(true);
    expect(meetsAssurance("QUALIFIED", "ADVANCED")).toBe(true);
    expect(meetsAssurance("ADVANCED", "QUALIFIED")).toBe(false);
  });
});

describe("friendlyClinicalError", () => {
  it("maps known codes to safe messages", () => {
    expect(friendlyClinicalError(new Error("hash_mismatch: abc")).message).toMatch(
      /changed after you reviewed/,
    );
    expect(friendlyClinicalError(new Error("forbidden: not your document")).message).toBe(
      "You do not have permission for this action",
    );
  });
  it("shows field names (never values) for incomplete prescriptions", () => {
    expect(
      friendlyClinicalError(
        new Error("prescription_incomplete: the practitioner must enter strength, route"),
      ).message,
    ).toMatch(/strength, route/);
  });
  it("does not echo unknown internals, SQL or stack details", () => {
    const e = friendlyClinicalError(
      new Error('duplicate key value violates unique constraint "x" DETAIL: Key (id)=(1)'),
    );
    expect(e.message).toBe("The action could not be completed. Please retry.");
  });
  it("maps RLS/permission errors", () => {
    expect(
      friendlyClinicalError({ message: "permission denied for table medical_documents" }).message,
    ).toBe("You do not have permission for this action");
  });
  it("passes ClinicalError through", () => {
    const c = new ClinicalError("x", "y");
    expect(friendlyClinicalError(c)).toBe(c);
  });
});
