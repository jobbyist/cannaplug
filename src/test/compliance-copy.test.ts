import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unregisteredFiles, validate, type Claim } from "../../scripts/check-compliance-copy";

const root = join(__dirname, "../..");
const register = JSON.parse(readFileSync(join(root, "compliance/copy-register.json"), "utf8")) as {
  claims: Claim[];
  ignoreFiles?: Record<string, string>;
};
const claims = register.claims;
const read = (f: string) =>
  existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : null;
const good = {
  issuer: "SAHPRA",
  documentId: "S21-123",
  documentDate: "2026-01-05",
  sha256: "a".repeat(64),
};
const base: Claim = { id: "T-1", claim: "x", needs: "y", locations: [], status: "pending" };

describe("compliance copy register", () => {
  it("every registered snippet still appears in the source (a wording change forces re-approval)", () => {
    expect(validate(claims, read)).toEqual([]);
  });
  it("no file carries regulated wording that the register does not know about", () => {
    const files = [
      "src/routes/about.tsx",
      "src/routes/faq.tsx",
      "src/routes/terms-of-service.tsx",
      "src/components/CannaPlugHome.tsx",
      "src/components/LegalLayout.tsx",
      "src/routes/account.tsx",
      "src/routes/privacy-policy.tsx",
      "src/routes/refund-policy.tsx",
      "src/routes/delivery-policy.tsx",
      "src/lib/banking.ts",
      "src/lib/ai/chat-prompt.ts",
    ];
    expect(unregisteredFiles(claims, files, read, Object.keys(register.ignoreFiles ?? {}))).toEqual(
      [],
    );
  });
  it("the suspicious placeholder phone number is flagged as such, not silently trusted", () => {
    expect(claims.find((c) => c.id === "C-05")?.status).toBe("placeholder");
  });
  it("a claim can only be approved with named client approval AND complete documentary evidence", () => {
    const ok: Claim = {
      ...base,
      status: "approved",
      evidence: good,
      approvedBy: "Client Director",
      approvedOn: "2026-02-01",
    };
    expect(validate([ok], () => "")).toEqual([]);
    expect(validate([{ ...ok, evidence: undefined }], () => "")[0]).toMatch(/documentary evidence/);
    expect(validate([{ ...ok, evidence: { ...good, sha256: "nothex" } }], () => "")[0]).toMatch(
      /documentary evidence/,
    );
    expect(validate([{ ...ok, approvedBy: undefined }], () => "")[0]).toMatch(/approver/);
    expect(validate([{ ...ok, approvedOn: "2999-01-01" }], () => "", "2026-10-02")[0]).toMatch(
      /approver/,
    );
    expect(validate([{ ...ok, approvedOn: "2025-01-01" }], () => "")[0]).toMatch(/dated after/);
  });
  it("evidence on a non-approved claim is rejected (no half-approvals)", () => {
    expect(validate([{ ...base, evidence: good }], () => "")[0]).toMatch(/status is "pending"/);
  });
  it("a snippet that disappears from the source is reported", () => {
    const c: Claim = { ...base, locations: [{ file: "f.tsx", snippet: "SAHPRA Section 21" }] };
    expect(validate([c], () => "changed copy")[0]).toMatch(/no longer appears/);
    expect(validate([c], () => null)[0]).toMatch(/does not exist/);
  });
});
