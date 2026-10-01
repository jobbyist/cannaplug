import { describe, expect, it } from "vitest";
import {
  ID_MAX_BYTES,
  checkIdFile,
  dobProblem,
  latestAdultBirthDate,
  rejectionMessage,
  sniffMime,
  verificationView,
} from "@/lib/verification-logic";
import { friendlyMemberError } from "@/lib/member-logic";

const bytes = (...b: number[]) => Uint8Array.from([...b, ...new Array(16).fill(0)]);

describe("sniffMime — trusts the bytes, not the declared type", () => {
  it("recognises JPEG, PNG, WebP and PDF", () => {
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffMime(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31))).toBe("application/pdf");
    const webp = new Uint8Array(16);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffMime(webp)).toBe("image/webp");
  });
  it("rejects scripts, executables, SVG and empty input", () => {
    expect(sniffMime(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(sniffMime(new TextEncoder().encode("MZ\x90\x00"))).toBeNull();
    expect(sniffMime(new Uint8Array(0))).toBeNull();
    // RIFF but not WebP (e.g. a WAV)
    const wav = new Uint8Array(16);
    wav.set([0x52, 0x49, 0x46, 0x46], 0);
    wav.set([0x57, 0x41, 0x56, 0x45], 8);
    expect(sniffMime(wav)).toBeNull();
  });
});

describe("checkIdFile", () => {
  it("accepts allowed types up to 5 MB and refuses the rest", () => {
    expect(checkIdFile({ type: "image/jpeg", size: 1000 })).toBeNull();
    expect(checkIdFile({ type: "image/jpeg", size: ID_MAX_BYTES })).toBeNull();
    expect(checkIdFile({ type: "image/jpeg", size: ID_MAX_BYTES + 1 })).toMatch(/5 MB/);
    expect(checkIdFile({ type: "image/svg+xml", size: 10 })).toMatch(/JPG, PNG/);
    expect(checkIdFile({ type: "application/pdf", size: 0 })).toMatch(/empty/);
  });
});

describe("age rule", () => {
  const today = new Date(2026, 9, 1); // 1 Oct 2026
  it("allows exactly 18 today and blocks the day before the birthday", () => {
    expect(latestAdultBirthDate(today)).toBe("2008-10-01");
    expect(dobProblem("2008-10-01", today)).toBeNull();
    expect(dobProblem("2008-10-02", today)).toMatch(/18 or older/);
    expect(dobProblem("1990-05-17", today)).toBeNull();
  });
  it("handles 29 February conservatively", () => {
    expect(latestAdultBirthDate(new Date(2028, 1, 29))).toBe("2010-02-28");
  });
  it("rejects malformed and implausible dates", () => {
    expect(dobProblem("", today)).toMatch(/date of birth/);
    expect(dobProblem("not-a-date", today)).toMatch(/date of birth/);
    expect(dobProblem("1800-01-01", today)).toMatch(/date of birth/);
  });
});

describe("verificationView", () => {
  it("only a verified member can order", () => {
    for (const status of ["unverified", "pending", "rejected", "expired"])
      expect(verificationView({ status }).canOrder).toBe(false);
    expect(verificationView({ status: "verified" }).canOrder).toBe(true);
    expect(verificationView(null).canOrder).toBe(false);
  });
  it("treats an unknown status as unverified rather than trusting it", () => {
    const v = verificationView({ status: "approved-ish" });
    expect(v.status).toBe("unverified");
    expect(v.canOrder).toBe(false);
  });
  it("can submit when unverified/rejected/expired, not while pending or verified", () => {
    expect(verificationView(null).canSubmit).toBe(true);
    expect(verificationView({ status: "rejected", attempt_count: 1 }).canSubmit).toBe(true);
    expect(verificationView({ status: "pending" }).canSubmit).toBe(false);
    expect(verificationView({ status: "verified" }).canSubmit).toBe(false);
  });
  it("stops offering uploads once the attempt cap is reached", () => {
    const v = verificationView({ status: "rejected", attempt_count: 5 });
    expect(v.canSubmit).toBe(false);
    expect(v.attemptsLeft).toBe(0);
  });
  it("tells a rejected member why, and never leaks internal fields", () => {
    expect(rejectionMessage("dob_mismatch")).toMatch(/date of birth/);
    expect(rejectionMessage("other", "Photo is blurry")).toContain("Photo is blurry");
    expect(rejectionMessage("nonsense")).toBe("Your ID could not be approved.");
  });
});

describe("error wording", () => {
  it("maps the database's verification codes to member-facing text", () => {
    expect(friendlyMemberError(new Error("verification_required: x")).message).toMatch(
      /Verify your ID/,
    );
    expect(friendlyMemberError(new Error("verification_pending: x")).message).toMatch(
      /being reviewed/,
    );
    expect(friendlyMemberError(new Error("underage: x")).message).toMatch(/18/);
    expect(friendlyMemberError(new Error("forbidden: manager access required")).message).toMatch(
      /permission/,
    );
  });
});
