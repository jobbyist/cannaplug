import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  ExternalHttpProvider,
  InternalAttestationProvider,
  getSignatureProvider,
  verifyWebhookSignature,
} from "@/lib/clinical/signature-providers.server";
import {
  SignatureProviderError,
  type SigningRequestInput,
} from "@/lib/clinical/signature-provider";
import { DOCUMENT_READY_SUBJECT, buildDocumentReadyEmail } from "@/lib/clinical/email";
import { applySecurityHeaders, isSensitivePath } from "@/lib/clinical/security-headers";

const input = (over: Partial<SigningRequestInput> = {}): SigningRequestInput => ({
  documentId: "CP-MED-2026-000184",
  documentUuid: "00000000-0000-4000-8000-000000000001",
  contentHash: "a".repeat(64),
  unsignedPdf: new Uint8Array([37, 80, 68, 70]),
  unsignedPdfHash: "b".repeat(64),
  signer: {
    userId: "user-1",
    fullName: "Dr Jane Smith",
    hpcsaNumber: "MP0123456",
    providerRef: null,
    email: "doc@example.com",
  },
  ...over,
});

const env = { ...process.env };
beforeEach(() => {
  process.env["SIGNATURE_ATTESTATION_SECRET"] = "s".repeat(40);
});
afterEach(() => {
  process.env = { ...env };
  vi.unstubAllGlobals();
});

describe("internal attestation provider (simple electronic signature only)", () => {
  it("completes immediately, bound to this document, practitioner and time", async () => {
    const res = await new InternalAttestationProvider().createSigningRequest(input());
    expect(res.status).toBe("COMPLETED");
    if (res.status !== "COMPLETED") return;
    expect(res.completion.signatureReference).toMatch(/^ATT-[0-9a-f]{32}$/);
    expect(res.completion.metadata["equivalent_to_advanced_or_qualified"]).toBe(false);
    expect(res.completion.metadata["method"]).toBe("SIMPLE_INTERNAL_ATTESTATION");
    expect(res.completion.signedPdf).toBeUndefined();
    expect(res.completion.certificateSubject).toBeUndefined();
  });

  it("verifies its own attestation and rejects any change to the document, signer or time", async () => {
    const p = new InternalAttestationProvider();
    const res = await p.createSigningRequest(input());
    if (res.status !== "COMPLETED") throw new Error("expected completion");
    const meta = res.completion.metadata;
    const base = {
      signedPdf: new Uint8Array(),
      signatureReference: res.completion.signatureReference,
      metadata: meta,
      unsignedPdfHash: "b".repeat(64),
      contentHash: "a".repeat(64),
      userId: "user-1",
    };
    expect((await p.verifySignature(base)).valid).toBe(true);
    expect((await p.verifySignature(base)).assurance).toBe("SIMPLE");
    expect((await p.verifySignature({ ...base, unsignedPdfHash: "c".repeat(64) })).valid).toBe(
      false,
    );
    expect((await p.verifySignature({ ...base, contentHash: "d".repeat(64) })).valid).toBe(false);
    expect((await p.verifySignature({ ...base, userId: "someone-else" })).valid).toBe(false);
    expect(
      (
        await p.verifySignature({
          ...base,
          metadata: { ...meta, signed_at: "2020-01-01T00:00:00.000Z" },
        })
      ).valid,
    ).toBe(false);
    expect((await p.verifySignature({ ...base, metadata: {} })).valid).toBe(false);
  });

  it("refuses to run without a strong server-side secret (never a default key)", async () => {
    delete process.env["SIGNATURE_ATTESTATION_SECRET"];
    await expect(
      new InternalAttestationProvider().createSigningRequest(input()),
    ).rejects.toMatchObject({ code: "provider_not_configured" });
    process.env["SIGNATURE_ATTESTATION_SECRET"] = "short";
    await expect(
      new InternalAttestationProvider().createSigningRequest(input()),
    ).rejects.toBeInstanceOf(SignatureProviderError);
  });

  it("has no signed file to download and nothing to cancel", async () => {
    const p = new InternalAttestationProvider();
    await expect(p.downloadSignedDocument()).rejects.toMatchObject({ code: "unsupported" });
    await expect(p.cancelSigningRequest()).resolves.toBeUndefined();
  });
});

describe("external provider adapter", () => {
  const configure = () => {
    process.env["EXTERNAL_SIGNATURE_API_URL"] = "https://sign.example/api/";
    process.env["EXTERNAL_SIGNATURE_API_KEY"] = "key-super-secret";
  };

  it("needs configuration and an enrolled signer, and never reads credentials from code", async () => {
    await expect(
      new ExternalHttpProvider().createSigningRequest(
        input({ signer: { ...input().signer, providerRef: "ref" } }),
      ),
    ).rejects.toMatchObject({ code: "provider_not_configured" });
    configure();
    await expect(new ExternalHttpProvider().createSigningRequest(input())).rejects.toMatchObject({
      code: "not_enrolled",
    });
  });

  it("sends the unsigned PDF and its hash with the bearer credential, and reports PENDING", async () => {
    configure();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ id: "req-1", status: "pending", sign_url: "https://sign.example/s/1" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const res = await new ExternalHttpProvider().createSigningRequest(
      input({ signer: { ...input().signer, providerRef: "signer-9" } }),
    );
    expect(res).toEqual({
      status: "PENDING",
      requestId: "req-1",
      redirectUrl: "https://sign.example/s/1",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://sign.example/api/signing-requests");
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer key-super-secret",
    );
    const body = JSON.parse(init.body as string);
    expect(body.document_sha256).toBe("b".repeat(64));
    expect(body.signer.reference).toBe("signer-9");
    expect(body.reference).toBe("CP-MED-2026-000184");
  });

  it("returns the provider-signed file and certificate details on completion", async () => {
    configure();
    const signedBytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: "req-2", status: "completed" }))
      .mockResolvedValueOnce(
        Response.json({
          status: "completed",
          signed_at: "2026-10-02T08:00:00Z",
          signature_reference: "SIG-1",
          certificate: { subject: "CN=Dr Smith", issuer: "CN=CA", serial: "42" },
        }),
      )
      .mockResolvedValueOnce(new Response(signedBytes));
    vi.stubGlobal("fetch", fetchMock);
    const res = await new ExternalHttpProvider().createSigningRequest(
      input({ signer: { ...input().signer, providerRef: "s" } }),
    );
    expect(res.status).toBe("COMPLETED");
    if (res.status !== "COMPLETED") return;
    expect(res.completion).toMatchObject({
      signatureReference: "SIG-1",
      certificateSubject: "CN=Dr Smith",
      certificateIssuer: "CN=CA",
      certificateSerial: "42",
    });
    expect([...res.completion.signedPdf!]).toEqual([1, 2, 3]);
  });

  it("does not trust a 'completed' report that lacks a signature record", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: "completed" })));
    await expect(new ExternalHttpProvider().getSigningStatus("x")).rejects.toMatchObject({
      code: "provider_error",
    });
  });

  it("maps failure/cancel and surfaces provider errors without leaking the credential", async () => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ status: "failed", failure_code: "declined" })),
    );
    expect(await new ExternalHttpProvider().getSigningStatus("x")).toEqual({
      status: "FAILED",
      code: "declined",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    const err = await new ExternalHttpProvider().getSigningStatus("x").catch((e) => e);
    expect(err).toBeInstanceOf(SignatureProviderError);
    expect(String(err.message)).not.toContain("key-super-secret");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET key-super-secret")));
    const net = await new ExternalHttpProvider().getSigningStatus("x").catch((e) => e);
    expect(net.code).toBe("provider_unreachable");
    expect(String(net.message)).not.toContain("key-super-secret");
  });

  it("is selected by registry name only", () => {
    expect(getSignatureProvider("internal_simple").name).toBe("internal_simple");
    expect(getSignatureProvider("external_generic").name).toBe("external_generic");
    expect(() => getSignatureProvider("made_up")).toThrow(SignatureProviderError);
  });
});

describe("webhook authentication", () => {
  const body = JSON.stringify({ request_id: "req-1" });
  const secret = "w".repeat(32);
  const sig = (b: string, s = secret) => createHmac("sha256", s).update(b).digest("hex");
  it("accepts a correct HMAC (with or without the sha256= prefix)", () => {
    expect(verifyWebhookSignature(body, sig(body), secret)).toBe(true);
    expect(verifyWebhookSignature(body, `sha256=${sig(body)}`, secret)).toBe(true);
  });
  it("rejects a wrong, missing or differently-keyed signature and a modified body", () => {
    expect(verifyWebhookSignature(body, sig(body, "other"), secret)).toBe(false);
    expect(verifyWebhookSignature(body + " ", sig(body), secret)).toBe(false);
    expect(verifyWebhookSignature(body, null, secret)).toBe(false);
    expect(verifyWebhookSignature(body, "", secret)).toBe(false);
    expect(verifyWebhookSignature(body, "zz", secret)).toBe(false);
  });
  it("rejects everything when no secret is configured", () => {
    delete process.env["EXTERNAL_SIGNATURE_WEBHOOK_SECRET"];
    expect(verifyWebhookSignature(body, sig(body, ""))).toBe(false);
  });
});

describe("member notification email", () => {
  it("is the fixed, content-free message with a link to the authenticated member area", () => {
    const mail = buildDocumentReadyEmail("https://cannaplug.example/member/documents");
    expect(mail.subject).toBe(DOCUMENT_READY_SUBJECT);
    expect(mail.text).toContain("Your CannaPlug medical document is ready.");
    expect(mail.text).toContain("https://cannaplug.example/member/documents");
    expect(mail.html).toContain('href="https://cannaplug.example/member/documents"');
  });
  it("contains no health information, names, identifiers, document type or verification token", () => {
    const mail = buildDocumentReadyEmail("https://cannaplug.example/member/documents");
    const all = `${mail.subject}\n${mail.text}\n${mail.html}`.toLowerCase();
    for (const w of [
      "prescription",
      "diagnos",
      "medicine",
      "dosage",
      "cp-med",
      "cp-rx",
      "verify/",
      "dr ",
      "hpcsa",
      "attachment",
      "cannabis",
    ])
      expect(all).not.toContain(w);
  });
  it("refuses an insecure or malformed link", () => {
    expect(() => buildDocumentReadyEmail("http://cannaplug.example/member/documents")).toThrow();
    expect(() => buildDocumentReadyEmail("not a url")).toThrow();
    expect(() => buildDocumentReadyEmail("javascript:alert(1)")).toThrow();
  });
});

describe("response hardening", () => {
  it("marks clinical pages private, unframeable, uncacheable and unindexable", () => {
    for (const path of [
      "/verify/abc",
      "/doctor",
      "/member/documents",
      "/api/public/signatures/webhook",
    ]) {
      const h = new Headers();
      applySecurityHeaders(path, h);
      expect(isSensitivePath(path)).toBe(true);
      expect(h.get("Cache-Control")).toBe("no-store");
      expect(h.get("X-Frame-Options")).toBe("DENY");
      expect(h.get("Referrer-Policy")).toBe("no-referrer");
      expect(h.get("X-Robots-Tag")).toContain("noindex");
      expect(h.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    }
  });
  it("only applies the baseline elsewhere (the Lovable preview frames the app)", () => {
    const h = new Headers();
    applySecurityHeaders("/shop", h);
    expect(isSensitivePath("/shop")).toBe(false);
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("X-Frame-Options")).toBeNull();
    expect(isSensitivePath("/doctors-we-love")).toBe(false);
  });
});
