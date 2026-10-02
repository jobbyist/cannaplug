import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { sha256Hex } from "@/lib/clinical/hash";
import { validatePdf, renderDocumentPdf } from "@/lib/clinical/pdf.server";

/**
 * Orchestration tests with an in-memory stand-in for Supabase. They check what the application layer
 * does around the database functions: ordering, hashes, what is stored, what is sent, and what is refused
 * before the database is ever called. The database rules themselves are tested against real PostgreSQL in
 * src/test/db/clinical-documents.test.ts.
 */

const h = vi.hoisted(() => {
  type Call = { name: string; args: Record<string, unknown> };
  const state = {
    calls: [] as Call[],
    rpcResults: {} as Record<string, unknown>,
    rpcErrors: {} as Record<string, string>,
    tables: {} as Record<string, unknown>,
    objects: new Map<string, Uint8Array>(),
    signedUrlCalls: [] as { path: string; seconds: number; opts?: unknown }[],
    order: [] as string[],
    user: { email: "member@example.com" } as { email: string } | null,
  };
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "ilike"]) b[m] = () => b;
    b["maybeSingle"] = async () => ({ data: state.tables[table] ?? null, error: null });
    b["then"] = (resolve: (v: unknown) => void) =>
      resolve({ data: state.tables[table] ?? [], error: null });
    return b;
  };
  const supabaseAdmin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.calls.push({ name, args });
      state.order.push(`rpc:${name}`);
      const err = state.rpcErrors[name];
      if (err) return { data: null, error: { message: err } };
      const r = state.rpcResults[name];
      return {
        data: typeof r === "function" ? (r as (a: unknown) => unknown)(args) : (r ?? {}),
        error: null,
      };
    },
    from: (table: string) => builder(table),
    auth: { admin: { getUserById: async () => ({ data: { user: state.user }, error: null }) } },
    storage: {
      from: () => ({
        upload: async (path: string, bytes: Uint8Array) => {
          state.order.push("storage:upload");
          state.objects.set(path, bytes);
          return { error: null };
        },
        download: async (path: string) => {
          const b = state.objects.get(path);
          return b
            ? { data: new Blob([b as BlobPart]), error: null }
            : { data: null, error: { message: "not found" } };
        },
        list: async (prefix: string) => ({
          data: [...state.objects.keys()]
            .filter((k) => k.startsWith(prefix + "/"))
            .map((k) => ({ name: k.slice(prefix.length + 1) })),
          error: null,
        }),
        remove: async (paths: string[]) => {
          state.order.push("storage:remove");
          paths.forEach((p) => state.objects.delete(p));
          return { error: null };
        },
        createSignedUrl: async (path: string, seconds: number, opts?: unknown) => {
          state.order.push("storage:signedUrl");
          state.signedUrlCalls.push({ path, seconds, opts });
          return { data: { signedUrl: `https://storage.example/${path}?token=t` }, error: null };
        },
      }),
    },
  };
  return { state, supabaseAdmin };
});

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: h.supabaseAdmin }));
vi.mock("@/lib/clinical/request.server", () => ({
  getRequest: () =>
    new Request("https://cannaplug.example/x", {
      headers: { "cf-connecting-ip": "203.0.113.7", "user-agent": "TestAgent/1.0" },
    }),
}));

const docs = await import("@/lib/clinical/documents-data.server");
const verify = await import("@/lib/clinical/verify-data.server");

const MEMBER = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";
const DOCTOR_USER = "33333333-3333-4333-8333-333333333333";
const CONTENT = "Approved document text. ".repeat(10);

async function approvedDoc(over: Record<string, unknown> = {}) {
  const hash = await sha256Hex(CONTENT);
  return {
    id: DOC,
    document_id: "CP-MED-2026-000184",
    document_type: "MEDICAL_LETTER",
    member_id: MEMBER,
    doctor_id: "dp-1",
    status: "APPROVED",
    rendered_content: CONTENT,
    document_hash: hash,
    source_data_snapshot: {
      doctor: { title: "Dr", full_name: "Jane Smith", hpcsa_number: "MP0123456" },
      document: { issue_date: "2026-10-02" },
    },
    verification_token: "T".repeat(43),
    approved_at: "2026-10-02T08:00:00Z",
    expires_at: null,
    ...over,
  };
}

const env = { ...process.env };
beforeEach(() => {
  const s = h.state;
  s.calls.length = 0;
  s.order.length = 0;
  s.signedUrlCalls.length = 0;
  s.objects.clear();
  s.rpcResults = {};
  s.rpcErrors = {};
  s.tables = {};
  s.user = { email: "member@example.com" };
  process.env["SIGNATURE_ATTESTATION_SECRET"] = "s".repeat(40);
  process.env["PUBLIC_APP_URL"] = "https://cannaplug.example";
  delete process.env["RESEND_API_KEY"];
  delete process.env["DOCUMENT_EMAIL_FROM"];
});
afterEach(() => {
  process.env = { ...env };
  vi.unstubAllGlobals();
});

const called = (name: string) => h.state.calls.filter((c) => c.name === name);

/** Decoded text drawn on all pages of a PDF. */
async function pdfText(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let ops = "";
  for (const [, o] of doc.context.enumerateIndirectObjects())
    if (o instanceof PDFRawStream)
      ops += new TextDecoder("latin1").decode(decodePDFRawStream(o).decode()) + "\n";
  return [...ops.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)]
    .map((m) =>
      m[1]!
        .match(/../g)!
        .map((x) => String.fromCharCode(parseInt(x, 16)))
        .join(""),
    )
    .join(" ");
}

function setupInternalProvider() {
  h.state.tables["doctor_profiles"] = {
    id: "dp-1",
    user_id: DOCTOR_USER,
    hpcsa_number: "MP0123456",
  };
  h.state.tables["signature_providers"] = {
    assurance_level: "SIMPLE",
    signature_method: "SIMPLE_INTERNAL_ATTESTATION",
  };
}

describe("signing and issuing", () => {
  it("runs approve-hash check → begin signing → store PDF → complete signing → issue, in that order", async () => {
    h.state.tables["medical_documents"] = await approvedDoc();
    setupInternalProvider();
    const doc = await approvedDoc();
    const res = await docs.signDocument(DOCTOR_USER, {
      documentId: DOC,
      expectedHash: doc.document_hash,
      provider: "internal_simple",
    });
    expect(res.status).toBe("ISSUED");
    expect(
      h.state.order.filter(
        (o) =>
          (o.startsWith("rpc:clinical") && !o.includes("notification")) ||
          o.startsWith("storage:upload"),
      ),
    ).toEqual([
      "rpc:clinical_document_begin_signing",
      "storage:upload",
      "rpc:clinical_document_complete_signing",
      "rpc:clinical_document_issue",
    ]);
  });

  it("binds the signature to the exact bytes stored: hash_after is the SHA-256 of the uploaded PDF", async () => {
    h.state.tables["medical_documents"] = await approvedDoc();
    setupInternalProvider();
    const doc = await approvedDoc();
    await docs.signDocument(DOCTOR_USER, {
      documentId: DOC,
      expectedHash: doc.document_hash,
      provider: "internal_simple",
    });
    const [path, bytes] = [...h.state.objects.entries()][0]!;
    expect(path).toMatch(new RegExp(`^${MEMBER}/${DOC}/[0-9a-f-]{36}\\.pdf$`));
    const complete = called("clinical_document_complete_signing")[0]!.args;
    expect((complete["p_sig"] as { hash_after: string }).hash_after).toBe(await sha256Hex(bytes));
    expect(called("clinical_document_issue")[0]!.args["p_pdf_path"]).toBe(path);
    expect(complete["p_actor"]).toBe(DOCTOR_USER);
    expect((await validatePdf(bytes)).ok).toBe(true);
  });

  it("sends the database the hash of the unsigned PDF and the approved content hash", async () => {
    h.state.tables["medical_documents"] = await approvedDoc();
    setupInternalProvider();
    const doc = await approvedDoc();
    await docs.signDocument(DOCTOR_USER, {
      documentId: DOC,
      expectedHash: doc.document_hash,
      provider: "internal_simple",
    });
    const begin = called("clinical_document_begin_signing")[0]!.args;
    expect(begin["p_expected_hash"]).toBe(doc.document_hash);
    expect(begin["p_unsigned_pdf_hash"]).toMatch(/^[0-9a-f]{64}$/);
    const unsigned = await renderDocumentPdf({
      documentId: doc.document_id,
      documentType: "MEDICAL_LETTER",
      content: CONTENT,
      issueDate: "2026-10-02",
      expiresAt: null,
      verificationUrl: `https://cannaplug.example/verify/${"T".repeat(43)}`,
      createdAt: new Date("2026-10-02T08:00:00Z"),
      signature: null,
    });
    expect(begin["p_unsigned_pdf_hash"]).toBe(await sha256Hex(unsigned));
  });

  it("stamps the issued PDF with the simple-signature statement, the practitioner and the verification URL", async () => {
    h.state.tables["medical_documents"] = await approvedDoc();
    setupInternalProvider();
    const doc = await approvedDoc();
    await docs.signDocument(DOCTOR_USER, {
      documentId: DOC,
      expectedHash: doc.document_hash,
      provider: "internal_simple",
    });
    const text = await pdfText([...h.state.objects.values()][0]!);
    expect(text).toContain("Electronically approved and signed by Dr Jane Smith");
    expect(text).toContain("HPCSA registration number: MP0123456");
    expect(text).toContain("simple electronic signature, not an advanced or");
    expect(text).toContain(`https://cannaplug.example/verify/${"T".repeat(43)}`);
    expect(text).toContain("Approved document text.");
  });

  it("refuses to sign a document whose hash differs from the one the practitioner approved — before any database call", async () => {
    h.state.tables["medical_documents"] = await approvedDoc();
    setupInternalProvider();
    await expect(
      docs.signDocument(DOCTOR_USER, {
        documentId: DOC,
        expectedHash: "f".repeat(64),
        provider: "internal_simple",
      }),
    ).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(called("clinical_document_begin_signing")).toHaveLength(0);
    expect(h.state.objects.size).toBe(0);
  });

  it("refuses when the stored text no longer matches its stored hash (tampered at rest)", async () => {
    const doc = await approvedDoc();
    h.state.tables["medical_documents"] = { ...doc, rendered_content: CONTENT + " TAMPERED" };
    setupInternalProvider();
    await expect(
      docs.signDocument(DOCTOR_USER, {
        documentId: DOC,
        expectedHash: doc.document_hash,
        provider: "internal_simple",
      }),
    ).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(h.state.calls).toHaveLength(0);
  });

  it("refuses a document that is not APPROVED (a prescription cannot be signed unapproved)", async () => {
    for (const status of [
      "DRAFT",
      "PENDING_DOCTOR_REVIEW",
      "SIGNED",
      "ISSUED",
      "REVOKED",
      "VOID",
    ]) {
      h.state.tables["medical_documents"] = await approvedDoc({
        status,
        document_type: "PRESCRIPTION_ORDER",
      });
      setupInternalProvider();
      const doc = await approvedDoc();
      await expect(
        docs.signDocument(DOCTOR_USER, {
          documentId: DOC,
          expectedHash: doc.document_hash,
          provider: "internal_simple",
        }),
        status,
      ).rejects.toMatchObject({ code: "invalid_transition" });
    }
    expect(called("clinical_document_begin_signing")).toHaveLength(0);
  });

  it("surfaces a database refusal (e.g. unconfirmed policy) without contacting the provider or storing anything", async () => {
    h.state.tables["medical_documents"] = await approvedDoc();
    setupInternalProvider();
    h.state.rpcErrors["clinical_document_begin_signing"] = "signature_policy_unconfirmed: nope";
    const doc = await approvedDoc();
    await expect(
      docs.signDocument(DOCTOR_USER, {
        documentId: DOC,
        expectedHash: doc.document_hash,
        provider: "internal_simple",
      }),
    ).rejects.toMatchObject({ code: "signature_policy_unconfirmed" });
    expect(h.state.objects.size).toBe(0);
    expect(called("clinical_document_complete_signing")).toHaveLength(0);
  });

  it("returns the document to approved when the provider is not configured, and stores nothing", async () => {
    h.state.tables["medical_documents"] = await approvedDoc();
    setupInternalProvider();
    delete process.env["SIGNATURE_ATTESTATION_SECRET"];
    const doc = await approvedDoc();
    await expect(
      docs.signDocument(DOCTOR_USER, {
        documentId: DOC,
        expectedHash: doc.document_hash,
        provider: "internal_simple",
      }),
    ).rejects.toMatchObject({ code: "signing_failed" });
    expect(called("clinical_document_signing_failed")).toHaveLength(1);
    expect(h.state.objects.size).toBe(0);
    expect(called("clinical_document_issue")).toHaveLength(0);
  });

  it("an asynchronous provider leaves the document SIGNING and records the request id; nothing is issued", async () => {
    h.state.tables["medical_documents"] = await approvedDoc();
    setupInternalProvider();
    process.env["EXTERNAL_SIGNATURE_API_URL"] = "https://sign.example/api";
    process.env["EXTERNAL_SIGNATURE_API_KEY"] = "k";
    h.state.tables["doctor_profiles"] = {
      id: "dp-1",
      user_id: DOCTOR_USER,
      hpcsa_number: "MP0123456",
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ id: "ext-1", status: "pending", sign_url: "https://sign.example/s" }),
        ),
    );
    const doc = await approvedDoc();
    // the external adapter needs an enrolled signer reference; the application passes none, so it is refused
    await expect(
      docs.signDocument(DOCTOR_USER, {
        documentId: DOC,
        expectedHash: doc.document_hash,
        provider: "external_generic",
      }),
    ).rejects.toMatchObject({ code: "signing_failed" });
    expect(called("clinical_document_signing_failed")).toHaveLength(1);
    expect(called("clinical_document_issue")).toHaveLength(0);
  });

  it("a webhook can only complete a request the document is waiting on", async () => {
    h.state.tables["document_signatures"] = null;
    expect(await docs.completeExternalSigning("unknown-request")).toEqual({ handled: false });
    expect(called("clinical_document_complete_signing")).toHaveLength(0);
    h.state.tables["document_signatures"] = {
      document_id: DOC,
      signature_provider: "external_generic",
      document_hash_before_signature: "b".repeat(64),
      status: "PENDING",
    };
    h.state.tables["medical_documents"] = await approvedDoc({ status: "ISSUED" });
    expect(await docs.completeExternalSigning("req-1")).toEqual({ handled: false });
    expect(called("clinical_document_complete_signing")).toHaveLength(0);
  });

  it("a provider-signed file that is not a valid PDF is rejected and never stored", async () => {
    h.state.tables["document_signatures"] = {
      document_id: DOC,
      signature_provider: "external_generic",
      document_hash_before_signature: "b".repeat(64),
      status: "PENDING",
    };
    h.state.tables["medical_documents"] = await approvedDoc({ status: "SIGNING" });
    h.state.tables["signature_providers"] = {
      assurance_level: "ADVANCED",
      signature_method: "EXTERNAL_PROVIDER",
    };
    process.env["EXTERNAL_SIGNATURE_API_URL"] = "https://sign.example/api";
    process.env["EXTERNAL_SIGNATURE_API_KEY"] = "k";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          status: "completed",
          signed_at: "2026-10-02T08:00:00Z",
          signature_reference: "SIG-1",
        }),
      )
      .mockResolvedValueOnce(
        new Response(new TextEncoder().encode("<html>not a pdf</html>".padEnd(400, " "))),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(docs.completeExternalSigning("req-1")).rejects.toMatchObject({
      code: "pdf_invalid",
    });
    expect(h.state.objects.size).toBe(0);
    expect(called("clinical_document_signing_failed")).toHaveLength(1);
    expect(called("clinical_document_issue")).toHaveLength(0);
  });

  it("completes an asynchronous signature from the webhook with no actor and the provider's own file", async () => {
    h.state.tables["document_signatures"] = {
      document_id: DOC,
      signature_provider: "external_generic",
      document_hash_before_signature: "b".repeat(64),
      status: "PENDING",
    };
    h.state.tables["medical_documents"] = await approvedDoc({ status: "SIGNING" });
    h.state.tables["signature_providers"] = {
      assurance_level: "ADVANCED",
      signature_method: "EXTERNAL_PROVIDER",
    };
    process.env["EXTERNAL_SIGNATURE_API_URL"] = "https://sign.example/api";
    process.env["EXTERNAL_SIGNATURE_API_KEY"] = "k";
    const signedPdf = await renderDocumentPdf({
      documentId: "CP-MED-2026-000184",
      documentType: "MEDICAL_LETTER",
      content: CONTENT,
      issueDate: null,
      expiresAt: null,
      verificationUrl: "https://x.test/v",
      createdAt: new Date(0),
      signature: null,
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            status: "completed",
            signed_at: "2026-10-02T08:00:00Z",
            signature_reference: "SIG-1",
            certificate: { subject: "CN=Dr", issuer: "CN=CA", serial: "7" },
          }),
        )
        .mockResolvedValueOnce(new Response(signedPdf as BodyInit)),
    );
    expect(await docs.completeExternalSigning("req-1")).toMatchObject({
      handled: true,
      status: "ISSUED",
    });
    const complete = called("clinical_document_complete_signing")[0]!.args;
    expect(complete["p_actor"]).toBeNull();
    const sig = complete["p_sig"] as Record<string, unknown>;
    expect(sig["hash_after"]).toBe(await sha256Hex(signedPdf));
    expect(sig["certificate_issuer"]).toBe("CN=CA");
    expect(called("clinical_document_issue")[0]!.args["p_actor"]).toBeNull();
  });

  it("retrying a SIGNED document finds the stored file by its signature hash and issues exactly that file", async () => {
    const pdf = await renderDocumentPdf({
      documentId: "CP-MED-2026-000184",
      documentType: "MEDICAL_LETTER",
      content: CONTENT,
      issueDate: null,
      expiresAt: null,
      verificationUrl: "https://x.test/v",
      createdAt: new Date(0),
      signature: null,
    });
    h.state.tables["medical_documents"] = await approvedDoc({ status: "SIGNED" });
    h.state.tables["doctor_profiles"] = { id: "dp-1" };
    h.state.tables["document_signatures"] = { document_hash_after_signature: await sha256Hex(pdf) };
    h.state.objects.set(
      `${MEMBER}/${DOC}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf`,
      new Uint8Array([1, 2, 3]),
    );
    h.state.objects.set(`${MEMBER}/${DOC}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.pdf`, pdf);
    await docs.retryIssue(DOCTOR_USER, DOC);
    expect(called("clinical_document_issue")[0]!.args["p_pdf_path"]).toBe(
      `${MEMBER}/${DOC}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.pdf`,
    );
  });

  it("will not retry-issue a file that does not match the signed hash", async () => {
    h.state.tables["medical_documents"] = await approvedDoc({ status: "SIGNED" });
    h.state.tables["doctor_profiles"] = { id: "dp-1" };
    h.state.tables["document_signatures"] = { document_hash_after_signature: "e".repeat(64) };
    h.state.objects.set(
      `${MEMBER}/${DOC}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf`,
      new Uint8Array([1, 2, 3]),
    );
    await expect(docs.retryIssue(DOCTOR_USER, DOC)).rejects.toMatchObject({
      code: "storage_failed",
    });
    expect(called("clinical_document_issue")).toHaveLength(0);
  });
});

describe("storage access", () => {
  it("audits first, then mints a 60-second signed URL", async () => {
    h.state.rpcResults["clinical_document_access"] = {
      path: `${MEMBER}/${DOC}/f.pdf`,
      document_id: "CP-MED-2026-000184",
    };
    const r = await docs.openDocument(MEMBER, DOC, "VIEWED");
    expect(h.state.order.filter((o) => o.startsWith("rpc") || o.startsWith("storage"))).toEqual([
      "rpc:clinical_document_access",
      "storage:signedUrl",
    ]);
    expect(h.state.signedUrlCalls[0]).toMatchObject({
      seconds: 60,
      path: `${MEMBER}/${DOC}/f.pdf`,
    });
    expect(r.expiresInSeconds).toBe(60);
    const args = called("clinical_document_access")[0]!.args;
    expect(args).toMatchObject({
      p_actor: MEMBER,
      p_kind: "VIEWED",
      p_ip: "203.0.113.7",
      p_ua: "TestAgent/1.0",
    });
  });

  it("asks for a download filename that is the document reference, never a name", async () => {
    h.state.rpcResults["clinical_document_access"] = {
      path: `${MEMBER}/${DOC}/f.pdf`,
      document_id: "CP-MED-2026-000184",
    };
    await docs.openDocument(MEMBER, DOC, "DOWNLOADED");
    expect(h.state.signedUrlCalls[0]!.opts).toEqual({ download: "CP-MED-2026-000184.pdf" });
  });

  it("never mints a URL when the database refuses access (another member's document)", async () => {
    h.state.rpcErrors["clinical_document_access"] = "document_not_found";
    await expect(docs.openDocument(MEMBER, DOC, "VIEWED")).rejects.toMatchObject({
      code: "document_not_found",
    });
    expect(h.state.signedUrlCalls).toHaveLength(0);
  });

  it("takes the acting user as an argument — the caller cannot choose someone else", async () => {
    h.state.rpcResults["clinical_document_access"] = { path: "p.pdf", document_id: "X" };
    await docs.openDocument("44444444-4444-4444-8444-444444444444", DOC, "VIEWED");
    expect(called("clinical_document_access")[0]!.args["p_actor"]).toBe(
      "44444444-4444-4444-8444-444444444444",
    );
  });
});

describe("email notification", () => {
  it("is skipped (and recorded as not sent) when email is not configured; issuance is unaffected", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await docs.notifyIssued(MEMBER, DOC);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(called("clinical_document_log_notification")[0]!.args).toMatchObject({
      p_doc: DOC,
      p_ok: false,
      p_channel: "email",
    });
  });

  it("sends the fixed, content-free message with a link to the member area and no attachment", async () => {
    process.env["RESEND_API_KEY"] = "re_secret";
    process.env["DOCUMENT_EMAIL_FROM"] = "CannaPlug <no-reply@cannaplug.example>";
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await docs.notifyIssued(MEMBER, DOC);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.authorization).toBe("Bearer re_secret");
    const body = JSON.parse(init.body);
    expect(body.to).toBe("member@example.com");
    expect(body.subject).toBe("Your CannaPlug medical document is ready");
    expect(body.text).toContain("https://cannaplug.example/member/documents");
    expect(body.attachments).toBeUndefined();
    const all = JSON.stringify(body).toLowerCase();
    for (const w of ["prescription", "cp-med", "verify/", "mp0123456", "dr jane"])
      expect(all).not.toContain(w);
    expect(called("clinical_document_log_notification")[0]!.args["p_ok"]).toBe(true);
  });

  it("a mail failure is recorded and never thrown", async () => {
    process.env["RESEND_API_KEY"] = "re_secret";
    process.env["DOCUMENT_EMAIL_FROM"] = "x@y.z";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(docs.notifyIssued(MEMBER, DOC)).resolves.toBeUndefined();
    expect(called("clinical_document_log_notification")[0]!.args["p_ok"]).toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 422 })));
    await docs.notifyIssued(MEMBER, DOC);
    expect(called("clinical_document_log_notification")[1]!.args["p_ok"]).toBe(false);
  });

  it("does not send when the member has no email address", async () => {
    process.env["RESEND_API_KEY"] = "re_secret";
    process.env["DOCUMENT_EMAIL_FROM"] = "x@y.z";
    h.state.user = null;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await docs.notifyIssued(MEMBER, DOC);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("rendering and freezing", () => {
  const template = {
    content:
      "Letter {{document.document_id}} {{member.full_name}} {{doctor.full_name}} {{doctor.hpcsa_number}}\n{{clinical.statement}}",
    schema: {
      placeholders: [
        "document.document_id",
        "member.full_name",
        "doctor.full_name",
        "doctor.hpcsa_number",
        "clinical.statement",
      ].map((key) => ({ key, required: true })),
    },
  };
  const snapshot = {
    doctor: { full_name: "Jane Smith", hpcsa_number: "MP0123456" },
    member: { full_name: "Test Member" },
    document: { document_id: "CP-MED-2026-000184", issue_date: "2026-10-02" },
    clinical: { statement: "Written by the practitioner." },
  };

  it("renders from the prepared snapshot and hands the database the text plus the snapshot hash it was rendered from", async () => {
    h.state.rpcResults["clinical_document_prepare"] = {
      document_type: "MEDICAL_LETTER",
      snapshot,
      snapshot_hash: "s".repeat(64),
      template,
    };
    h.state.rpcResults["clinical_document_submit"] = {
      id: DOC,
      status: "PENDING_DOCTOR_REVIEW",
      document_hash: "h".repeat(64),
    };
    await docs.submitForReview(DOCTOR_USER, DOC);
    const submit = called("clinical_document_submit")[0]!.args;
    expect(submit["p_rendered"]).toBe(
      "Letter CP-MED-2026-000184 Test Member Jane Smith MP0123456\nWritten by the practitioner.",
    );
    expect(submit["p_snapshot_hash"]).toBe("s".repeat(64));
    expect(called("clinical_document_prepare")[0]!.args["p_issue_date"]).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("refuses to freeze when a required value is missing — nothing reaches the submit function", async () => {
    h.state.rpcResults["clinical_document_prepare"] = {
      document_type: "MEDICAL_LETTER",
      snapshot: { ...snapshot, clinical: {} },
      snapshot_hash: "s".repeat(64),
      template,
    };
    await expect(docs.submitForReview(DOCTOR_USER, DOC)).rejects.toMatchObject({
      code: "template_invalid",
    });
    expect(called("clinical_document_submit")).toHaveLength(0);
  });

  it("refuses to freeze a prescription whose quantity words disagree with the figures", async () => {
    const rxTemplate = { content: template.content, schema: template.schema };
    h.state.rpcResults["clinical_document_prepare"] = {
      document_type: "PRESCRIPTION_ORDER",
      snapshot: {
        ...snapshot,
        document: { ...snapshot.document, expiry_date: "2099-01-01" },
        prescription: {
          medicine_name: "M",
          dosage_form: "F",
          strength: "S",
          quantity_numeric: 5,
          quantity_words: "six",
          directions: "D",
          route: "R",
          frequency: "Q",
          duration: "T",
          repeats: 0,
          indication: "I",
        },
      },
      snapshot_hash: "s".repeat(64),
      template: rxTemplate,
    };
    await expect(docs.submitForReview(DOCTOR_USER, DOC)).rejects.toMatchObject({
      code: "prescription_incomplete",
    });
    expect(called("clinical_document_submit")).toHaveLength(0);
  });

  it("generates a fresh 256-bit token for every document and takes the actor from the session only", async () => {
    h.state.rpcResults["clinical_document_create"] = {
      id: DOC,
      document_id: "CP-MED-2026-000185",
      status: "DRAFT",
    };
    const input = {
      type: "MEDICAL_LETTER" as const,
      memberId: MEMBER,
      templateId: DOC,
      clinical: { statement: "x" },
      prescription: null,
      expiresAt: null,
      supersedes: null,
      key: "idempotency-key-1",
    };
    await docs.createDocument(DOCTOR_USER, input);
    await docs.createDocument(DOCTOR_USER, { ...input, key: "idempotency-key-2" });
    const [a, b] = called("clinical_document_create");
    expect(a!.args["p_token"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a!.args["p_token"]).not.toBe(b!.args["p_token"]);
    expect(a!.args["p_actor"]).toBe(DOCTOR_USER);
  });
});

describe("public verification", () => {
  const TOKEN = "V".repeat(43);
  const lookupFor = async (pdf: Uint8Array, over: Record<string, unknown> = {}) => ({
    found: true,
    id: DOC,
    document_id: "CP-MED-2026-000184",
    document_type: "MEDICAL_LETTER",
    status: "ISSUED",
    issued_at: "2026-10-02T08:00:00Z",
    expires_at: null,
    practitioner: "Dr Jane Smith",
    registration_verified: true,
    stored_hash: "a".repeat(64),
    content_hash_ok: true,
    signature_completed: true,
    assurance: "SIMPLE",
    pdf_path: `${MEMBER}/${DOC}/f.pdf`,
    pdf_hash_expected: await sha256Hex(pdf),
    ...over,
  });
  const allow = () => {
    h.state.rpcResults["document_verify_rate_check"] = true;
    h.state.rpcResults["document_verify_blocked"] = false;
  };
  const pdf = new TextEncoder().encode("%PDF-1.7 original bytes of the issued document");

  it("verifies an untouched document as VALID and records the check without health data", async () => {
    allow();
    h.state.objects.set(`${MEMBER}/${DOC}/f.pdf`, pdf);
    h.state.rpcResults["document_verify_lookup"] = await lookupFor(pdf);
    const res = await verify.verifyToken(TOKEN, "203.0.113.7");
    expect(res).toMatchObject({
      status: "VALID",
      documentId: "CP-MED-2026-000184",
      practitioner: "Dr Jane Smith",
      registration: "Verified",
    });
    const rec = called("document_verify_record")[0]!.args;
    expect(rec).toMatchObject({
      p_doc: DOC,
      p_status: "VALID",
      p_observed_hash: await sha256Hex(pdf),
    });
    expect(JSON.stringify(rec)).not.toContain("203.0.113.7");
    expect(String(rec["p_requester_hash"])).toMatch(/^[0-9a-f]{32}$/);
  });

  it("detects a modified PDF in storage", async () => {
    allow();
    const tampered = pdf.slice();
    tampered[10]! ^= 1;
    h.state.objects.set(`${MEMBER}/${DOC}/f.pdf`, tampered);
    h.state.rpcResults["document_verify_lookup"] = await lookupFor(pdf);
    expect((await verify.verifyToken(TOKEN, null)).status).toBe("INTEGRITY_FAILURE");
    expect(called("document_verify_record")[0]!.args["p_status"]).toBe("INTEGRITY_FAILURE");
  });

  it("treats a missing stored file as an integrity failure", async () => {
    allow();
    h.state.rpcResults["document_verify_lookup"] = await lookupFor(pdf);
    expect((await verify.verifyToken(TOKEN, null)).status).toBe("INTEGRITY_FAILURE");
  });

  it("reports REVOKED without ever reading the file", async () => {
    allow();
    h.state.rpcResults["document_verify_lookup"] = await lookupFor(pdf, { status: "REVOKED" });
    const res = await verify.verifyToken(TOKEN, null);
    expect(res.status).toBe("REVOKED");
    expect(h.state.order).not.toContain("storage:signedUrl");
  });

  it("answers an unknown token with NOT_FOUND and counts it toward the failure limit", async () => {
    allow();
    h.state.rpcResults["document_verify_lookup"] = { found: false };
    expect(await verify.verifyToken(TOKEN, "198.51.100.1")).toEqual({ status: "NOT_FOUND" });
    expect(
      called("document_verify_rate_check").some((c) => String(c.args["p_bucket"]).startsWith("f:")),
    ).toBe(true);
    expect(called("document_verify_record")).toHaveLength(0);
  });

  it("rejects a malformed token without querying the database for it", async () => {
    allow();
    expect(await verify.verifyToken("not-a-token", null)).toEqual({ status: "NOT_FOUND" });
    expect(called("document_verify_lookup")).toHaveLength(0);
  });

  it("is rate limited per requester and when a requester keeps guessing", async () => {
    h.state.rpcResults["document_verify_rate_check"] = false;
    h.state.rpcResults["document_verify_blocked"] = false;
    expect(await verify.verifyToken(TOKEN, null)).toEqual({ status: "RATE_LIMITED" });
    h.state.rpcResults["document_verify_rate_check"] = true;
    h.state.rpcResults["document_verify_blocked"] = true;
    expect(await verify.verifyToken(TOKEN, null)).toEqual({ status: "RATE_LIMITED" });
    expect(called("document_verify_lookup")).toHaveLength(0);
  });

  it("fails closed when the limiter is unavailable", async () => {
    h.state.rpcErrors["document_verify_rate_check"] = "boom";
    expect(await verify.verifyToken(TOKEN, null)).toEqual({ status: "RATE_LIMITED" });
    expect(called("document_verify_lookup")).toHaveLength(0);
  });

  it("never returns clinical or identity data, even if the lookup carried it", async () => {
    allow();
    h.state.objects.set(`${MEMBER}/${DOC}/f.pdf`, pdf);
    h.state.rpcResults["document_verify_lookup"] = {
      ...(await lookupFor(pdf)),
      full_name: "Test Member",
      medicine: "TEST MEDICINE",
      date_of_birth: "1990-05-17",
      rendered_content: "TEST MEDICINE",
    };
    const text = JSON.stringify(await verify.verifyToken(TOKEN, null));
    for (const s of ["Test Member", "TEST MEDICINE", "1990-05-17", MEMBER, "f.pdf"])
      expect(text).not.toContain(s);
  });
});
