import { describe, expect, it } from "vitest";
import {
  idNumberProblem,
  normaliseIdNumber,
  phoneProblem,
  referralProblem,
  saIdChecksumOk,
  signupMetadata,
  signupProblem,
  type SignupFields,
} from "@/lib/signup-logic";

const good: SignupFields = {
  firstName: "Rae",
  lastName: "Hearsal",
  email: "rae@example.com",
  phone: "082 123 4567",
  dob: "1990-01-01",
  idNumber: "AB123456",
  referral: "",
};

describe("sign-up rules", () => {
  it("accepts a complete form", () => expect(signupProblem(good, null)).toBeNull());

  it.each([
    ["firstName", ""],
    ["lastName", " "],
    ["email", "nope"],
    ["phone", ""],
    ["idNumber", ""],
  ] as const)("requires %s", (key, value) => {
    expect(signupProblem({ ...good, [key]: value }, null)).not.toBeNull();
  });

  it("passes on a date-of-birth problem", () => {
    expect(signupProblem(good, "You must be 18 or older.")).toBe("You must be 18 or older.");
  });

  it("checks SA ID checksum and birth date", () => {
    expect(saIdChecksumOk("8001015009087")).toBe(true);
    expect(idNumberProblem("8001015009087", "1980-01-01")).toBeNull();
    expect(idNumberProblem("8001015009087", "1981-01-01")).toMatch(/don't match/);
    expect(idNumberProblem("8001015009088", "1980-01-01")).toMatch(/doesn't look right/);
  });

  it("accepts passports and rejects junk", () => {
    expect(idNumberProblem("ab 123-456", "1990-01-01")).toBeNull();
    expect(idNumberProblem("12", "1990-01-01")).not.toBeNull();
    expect(normaliseIdNumber(" ab-12 3456 ")).toBe("AB123456");
  });

  it("validates phone and optional referral", () => {
    expect(phoneProblem("+27 82 123 4567")).toBeNull();
    expect(phoneProblem("abc")).not.toBeNull();
    expect(referralProblem("")).toBeNull();
    expect(referralProblem("friend-1")).toBeNull();
    expect(referralProblem("a!")).not.toBeNull();
  });

  it("builds metadata with a normalised ID and optional referral", () => {
    const m = signupMetadata({ ...good, idNumber: "ab 123456", referral: " friend1 " });
    expect(m).toMatchObject({
      full_name: "Rae Hearsal",
      first_name: "Rae",
      last_name: "Hearsal",
      id_number: "AB123456",
      referral_code: "FRIEND1",
    });
    expect("referral_code" in signupMetadata(good)).toBe(false);
  });
});
