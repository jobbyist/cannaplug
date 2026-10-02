import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  generateVerificationToken,
  hashesEqual,
  isSha256Hex,
  isValidVerificationToken,
  sha256Hex,
} from "@/lib/clinical/hash";
import {
  evaluateVerification,
  needsPdfCheck,
  toPublicVerification,
  type VerifyLookup,
} from "@/lib/clinical/verification-logic";

describe("hashing", () => {
  it("matches the SHA-256 reference vectors (strings and bytes)", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const bytes = new Uint8Array([1, 2, 3, 250]);
    expect(await sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
  it("hashes unicode as UTF-8", async () => {
    expect(await sha256Hex("Zoë")).toBe(createHash("sha256").update("Zoë", "utf8").digest("hex"));
  });
  it("compares digests safely", () => {
    const a = "a".repeat(64);
    expect(hashesEqual(a, a)).toBe(true);
    expect(hashesEqual(a, "b".repeat(64))).toBe(false);
    expect(hashesEqual(a, a.slice(1))).toBe(false);
    expect(hashesEqual(null, a)).toBe(false);
    expect(hashesEqual(undefined, undefined)).toBe(false);
  });
  it("recognises a SHA-256 hex digest", () => {
    expect(isSha256Hex("a".repeat(64))).toBe(true);
    expect(isSha256Hex("A".repeat(64))).toBe(false);
    expect(isSha256Hex("a".repeat(63))).toBe(false);
  });
});

describe("verification tokens", () => {
  it("are 43 URL-safe characters (256 bits)", () => {
    for (let i = 0; i < 50; i++) expect(generateVerificationToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("do not repeat", () => {
    const seen = new Set(Array.from({ length: 2000 }, generateVerificationToken));
    expect(seen.size).toBe(2000);
  });
  it("are not derived from a counter or the clock", () => {
    const a = generateVerificationToken();
    const b = generateVerificationToken();
    let same = 0;
    for (let i = 0; i < 43; i++) if (a[i] === b[i]) same++;
    expect(same).toBeLessThan(15);
  });
  it("validates shape, rejecting anything else", () => {
    expect(isValidVerificationToken(generateVerificationToken())).toBe(true);
    for (const bad of [
      "",
      "short",
      "x".repeat(44),
      "x".repeat(42) + "!",
      "' OR 1=1 --",
      null,
      undefined,
      42,
      "../".repeat(15),
    ])
      expect(isValidVerificationToken(bad)).toBe(false);
  });
});

const PDF_HASH = "c".repeat(64);
const issued = (over: Partial<VerifyLookup> = {}): VerifyLookup => ({
  found: true,
  id: "uuid",
  document_id: "CP-MED-2026-000184",
  document_type: "MEDICAL_LETTER",
  status: "ISSUED",
  issued_at: "2026-10-02T08:00:00Z",
  expires_at: "2027-01-31T21:59:59Z",
  practitioner: "Dr Jane Smith",
  registration_verified: true,
  stored_hash: "a".repeat(64),
  content_hash_ok: true,
  signature_completed: true,
  assurance: "SIMPLE",
  pdf_path: "member/doc/file.pdf",
  pdf_hash_expected: PDF_HASH,
  ...over,
});

describe("verification outcome", () => {
  it("is VALID only when everything agrees", () => {
    expect(evaluateVerification(issued(), PDF_HASH)).toBe("VALID");
  });
  it("fails integrity when the stored PDF no longer matches the signed hash (modified PDF)", () => {
    expect(evaluateVerification(issued(), "d".repeat(64))).toBe("INTEGRITY_FAILURE");
  });
  it("fails integrity when the PDF is missing or unreadable", () => {
    expect(evaluateVerification(issued(), null)).toBe("INTEGRITY_FAILURE");
  });
  it("fails integrity when the stored text no longer matches its hash (tampered document)", () => {
    expect(evaluateVerification(issued({ content_hash_ok: false }), PDF_HASH)).toBe(
      "INTEGRITY_FAILURE",
    );
  });
  it("fails integrity when no completed signature exists", () => {
    expect(evaluateVerification(issued({ signature_completed: false }), PDF_HASH)).toBe(
      "INTEGRITY_FAILURE",
    );
  });
  it("fails integrity when no signed-hash was recorded", () => {
    expect(evaluateVerification(issued({ pdf_hash_expected: null }), PDF_HASH)).toBe(
      "INTEGRITY_FAILURE",
    );
  });
  it.each([
    ["REVOKED", "REVOKED"],
    ["EXPIRED", "EXPIRED"],
    ["VOID", "VOID"],
    ["DRAFT", "NOT_ISSUED"],
    ["PENDING_DOCTOR_REVIEW", "NOT_ISSUED"],
    ["APPROVED", "NOT_ISSUED"],
    ["SIGNING", "NOT_ISSUED"],
    ["SIGNED", "NOT_ISSUED"],
  ])("a %s document is %s regardless of hashes", (status, expected) => {
    expect(evaluateVerification(issued({ status }), PDF_HASH)).toBe(expected);
    expect(evaluateVerification(issued({ status }), null)).toBe(expected);
  });
  it("an unknown token is NOT_FOUND", () => {
    expect(evaluateVerification({ found: false }, null)).toBe("NOT_FOUND");
  });
  it("only an issued document needs the stored PDF to be read", () => {
    expect(needsPdfCheck(issued())).toBe(true);
    expect(needsPdfCheck(issued({ status: "REVOKED" }))).toBe(false);
    expect(needsPdfCheck({ found: false })).toBe(false);
  });
});

describe("what the public page may learn", () => {
  const SECRETS = [
    "Test Member",
    "1990-05-17",
    "MP0123456",
    "TEST MEDICINE",
    "TEST STRENGTH",
    "TEST DIRECTIONS",
    "member-uuid-123",
    "12 Secret Street",
    "8001015009087",
  ];
  const leaky = {
    ...issued(),
    full_name: "Test Member",
    date_of_birth: "1990-05-17",
    hpcsa_number: "MP0123456",
    medicine: "TEST MEDICINE",
    strength: "TEST STRENGTH",
    directions: "TEST DIRECTIONS",
    member_id: "member-uuid-123",
    address: "12 Secret Street",
    id_number: "8001015009087",
    rendered_content: "TEST MEDICINE TEST STRENGTH",
  } as VerifyLookup;

  it("is a fixed, minimal shape for a valid document", () => {
    const pub = toPublicVerification(leaky, "VALID");
    expect(Object.keys(pub).sort()).toEqual([
      "documentId",
      "documentType",
      "expires",
      "issued",
      "practitioner",
      "registration",
      "signature",
      "status",
    ]);
    expect(pub).toMatchObject({
      status: "VALID",
      documentId: "CP-MED-2026-000184",
      documentType: "Medical letter",
      issued: "02 October 2026",
      practitioner: "Dr Jane Smith",
      registration: "Verified",
    });
  });
  it.each([
    "VALID",
    "REVOKED",
    "EXPIRED",
    "VOID",
    "NOT_ISSUED",
    "INTEGRITY_FAILURE",
    "NOT_FOUND",
    "RATE_LIMITED",
  ] as const)("never leaks health or identity data (%s)", (status) => {
    const text = JSON.stringify(toPublicVerification(leaky, status));
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(text).not.toContain("file.pdf");
    expect(text).not.toContain("a".repeat(64));
  });
  it("labels prescriptions the same minimal way", () => {
    expect(
      toPublicVerification(issued({ document_type: "PRESCRIPTION_ORDER" }), "VALID").documentType,
    ).toBe("Prescription / order");
  });
  it("shows nothing but the status for unknown tokens and rate limiting", () => {
    expect(toPublicVerification({ found: false }, "NOT_FOUND")).toEqual({ status: "NOT_FOUND" });
    expect(toPublicVerification({ found: false }, "RATE_LIMITED")).toEqual({
      status: "RATE_LIMITED",
    });
  });
  it("reveals only the document id and type when integrity fails", () => {
    const pub = toPublicVerification(leaky, "INTEGRITY_FAILURE");
    expect(Object.keys(pub).sort()).toEqual(["documentId", "documentType", "status"]);
  });
  it("states plainly when the practitioner is not currently verified", () => {
    expect(
      toPublicVerification(issued({ registration_verified: false }), "VALID").registration,
    ).toBe("Not currently verified");
  });
  it("labels the signature level honestly from the recorded assurance", () => {
    expect(toPublicVerification(issued({ assurance: "SIMPLE" }), "VALID").signature).toBe(
      "Simple electronic signature",
    );
    expect(toPublicVerification(issued({ assurance: "ADVANCED" }), "VALID").signature).toBe(
      "Advanced electronic signature",
    );
  });
});
