// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDoctorViewFn: vi.fn(),
  decideDocumentFn: vi.fn(),
  signDocumentFn: vi.fn(),
  signingOptionsFn: vi.fn(),
  openDocumentFn: vi.fn(),
  retryIssueFn: vi.fn(),
  revokeDocumentFn: vi.fn(),
  voidDocumentFn: vi.fn(),
  createDocumentFn: vi.fn(),
  updateDraftFn: vi.fn(),
  submitForReviewFn: vi.fn(),
  listMemberDocumentsFn: vi.fn(),
  listMyRequestsFn: vi.fn(),
  createMyRequestFn: vi.fn(),
  cancelMyRequestFn: vi.fn(),
  linkRequestDocumentFn: vi.fn(),
  auth: {
    user: { id: "u1", email: "m@example.com" } as { id: string; email: string } | null,
    loading: false,
  },
}));

vi.mock("@/lib/clinical/clinical.functions", () => ({
  getDoctorViewFn: mocks.getDoctorViewFn,
  decideDocumentFn: mocks.decideDocumentFn,
  signDocumentFn: mocks.signDocumentFn,
  signingOptionsFn: mocks.signingOptionsFn,
  openDocumentFn: mocks.openDocumentFn,
  retryIssueFn: mocks.retryIssueFn,
  revokeDocumentFn: mocks.revokeDocumentFn,
  voidDocumentFn: mocks.voidDocumentFn,
  createDocumentFn: mocks.createDocumentFn,
  updateDraftFn: mocks.updateDraftFn,
  submitForReviewFn: mocks.submitForReviewFn,
  listMemberDocumentsFn: mocks.listMemberDocumentsFn,
  listMyRequestsFn: mocks.listMyRequestsFn,
  createMyRequestFn: mocks.createMyRequestFn,
  cancelMyRequestFn: mocks.cancelMyRequestFn,
  linkRequestDocumentFn: mocks.linkRequestDocumentFn,
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

import { ReviewDialog } from "@/components/clinical/ReviewDialog";
import { DocumentEditor } from "@/components/clinical/DocumentEditor";
import { VerificationResult } from "@/components/clinical/VerificationResult";
import { Route as MemberRoute } from "@/routes/member.documents";
import type { DoctorView, PatientRow, TemplateRow } from "@/lib/clinical/documents-data.server";

const HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const TEXT = "CannaPlug — Medical Letter\nThe exact approved text.\n  Indented line kept.";

const view = (over: Partial<DoctorView> = {}): DoctorView => ({
  id: "doc-1",
  document_id: "CP-MED-2026-000184",
  document_type: "MEDICAL_LETTER",
  status: "PENDING_DOCTOR_REVIEW",
  member_id: "m1",
  template_id: "t1",
  template_version: 3,
  document_version: 1,
  document_hash: HASH,
  rendered_content: TEXT,
  snapshot: {
    doctor: { title: "Dr", full_name: "Jane Smith", hpcsa_number: "MP0123456" },
    member: { full_name: "Test Member", member_id: "CP-M-ABCD1234", date_of_birth: "1990-05-17" },
  },
  expires_at: null,
  issued_at: null,
  created_at: "2026-10-02T08:00:00Z",
  review_note: null,
  revocation_reason: null,
  has_pdf: false,
  ...over,
});

const usable = {
  required: "SIMPLE",
  policyConfirmed: true,
  options: [
    {
      provider: "internal_simple",
      displayName: "Internal attestation",
      assurance: "SIMPLE",
      usable: true,
    },
  ],
};

beforeEach(() => {
  mocks.getDoctorViewFn.mockResolvedValue(view());
  mocks.signingOptionsFn.mockResolvedValue(usable);
  mocks.decideDocumentFn.mockResolvedValue({});
  mocks.signDocumentFn.mockResolvedValue({ status: "ISSUED" });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.auth.user = { id: "u1", email: "m@example.com" };
});

const renderReview = () =>
  render(
    <ReviewDialog
      documentId="doc-1"
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onEditDraft={vi.fn()}
      onNewVersion={vi.fn()}
    />,
  );

describe("practitioner review screen", () => {
  it("shows the exact frozen text, the patient, the practitioner, the template version and the hash", async () => {
    renderReview();
    const pre = await screen.findByLabelText("Exact document text");
    expect(pre.textContent).toBe(TEXT);
    expect(screen.getByText("CP-MED-2026-000184")).toBeTruthy();
    expect(screen.getByText("Test Member (CP-M-ABCD1234)")).toBeTruthy();
    expect(screen.getByText("Dr Jane Smith")).toBeTruthy();
    expect(screen.getByText("MP0123456")).toBeTruthy();
    expect(screen.getByText(/v3 · document v1/)).toBeTruthy();
    expect(screen.getByText(`${HASH.slice(0, 16)}…`)).toBeTruthy();
  });

  it("cannot approve until the practitioner explicitly confirms (nothing is pre-ticked)", async () => {
    renderReview();
    const button = await screen.findByRole("button", { name: "Approve & Sign" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const box = screen.getByRole("checkbox", { name: /reviewed this exact document/i });
    expect(box.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(box);
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("approves the hash that was shown, then signs that same hash — in that order", async () => {
    renderReview();
    await userEvent.click(
      await screen.findByRole("checkbox", { name: /reviewed this exact document/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve & Sign" }));
    await waitFor(() => expect(mocks.signDocumentFn).toHaveBeenCalled());
    expect(mocks.decideDocumentFn).toHaveBeenCalledWith({
      data: { documentId: "doc-1", decision: "approve", expectedHash: HASH },
    });
    expect(mocks.signDocumentFn).toHaveBeenCalledWith({
      data: { documentId: "doc-1", expectedHash: HASH, provider: "internal_simple" },
    });
    expect(mocks.decideDocumentFn.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.signDocumentFn.mock.invocationCallOrder[0]!,
    );
  });

  it("shows a refusal (e.g. the document changed) and does not claim success", async () => {
    mocks.decideDocumentFn.mockRejectedValue(
      new Error("The document changed after you reviewed it. Reload and review it again"),
    );
    renderReview();
    await userEvent.click(
      await screen.findByRole("checkbox", { name: /reviewed this exact document/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve & Sign" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/changed after you reviewed/);
    expect(mocks.signDocumentFn).not.toHaveBeenCalled();
    expect(screen.queryByText(/Signed and issued/)).toBeNull();
  });

  it("explains when no signature method is available and offers no way to sign", async () => {
    mocks.signingOptionsFn.mockResolvedValue({
      required: "ADVANCED",
      policyConfirmed: true,
      options: [
        {
          provider: "internal_simple",
          displayName: "Internal attestation",
          assurance: "SIMPLE",
          usable: false,
          reason: "Below the required advanced level",
        },
      ],
    });
    renderReview();
    expect(await screen.findByText(/No signature method is available to you/)).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: /reviewed this exact document/i }));
    expect(
      (screen.getByRole("button", { name: "Approve & Sign" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("warns when compliance has not confirmed the signature level", async () => {
    mocks.signingOptionsFn.mockResolvedValue({
      required: "ADVANCED",
      policyConfirmed: false,
      options: [],
    });
    renderReview();
    expect(await screen.findByText(/has not been confirmed by compliance/)).toBeTruthy();
  });

  it("reject and request-changes both require a reason", async () => {
    renderReview();
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Reason"), "Not appropriate");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(mocks.decideDocumentFn).toHaveBeenCalledWith({
        data: { documentId: "doc-1", decision: "reject", note: "Not appropriate" },
      }),
    );
  });

  it("an approved-but-unsigned document offers Sign, not another approval", async () => {
    mocks.getDoctorViewFn.mockResolvedValue(view({ status: "APPROVED" }));
    renderReview();
    await userEvent.click(
      await screen.findByRole("checkbox", { name: /reviewed this exact document/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign" }));
    await waitFor(() => expect(mocks.signDocumentFn).toHaveBeenCalled());
    expect(mocks.decideDocumentFn).not.toHaveBeenCalled();
  });

  it("an issued document offers viewing and revocation but no edit, approve or sign", async () => {
    mocks.getDoctorViewFn.mockResolvedValue(view({ status: "ISSUED", has_pdf: true }));
    renderReview();
    expect(await screen.findByRole("button", { name: "View PDF" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
    for (const name of [/approve/i, /^sign$/i, /edit draft/i, /request changes/i])
      expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("a signed-but-not-issued document can only be finished, not re-signed", async () => {
    mocks.getDoctorViewFn.mockResolvedValue(view({ status: "SIGNED" }));
    mocks.retryIssueFn.mockResolvedValue({});
    renderReview();
    await userEvent.click(await screen.findByRole("button", { name: "Finish issuing" }));
    expect(mocks.retryIssueFn).toHaveBeenCalledWith({ data: { documentId: "doc-1" } });
    expect(screen.queryByRole("button", { name: /sign/i })).toBeNull();
  });
});

const patients: PatientRow[] = [
  {
    member_id: "m1",
    member_ref: "CP-M-ABCD1234",
    full_name: "Test Member",
    date_of_birth: "1990-05-17",
    identity_verified: true,
    documents: 0,
  },
  {
    member_id: "m2",
    member_ref: "CP-M-ZZZZ0000",
    full_name: "Unverified",
    date_of_birth: null,
    identity_verified: false,
    documents: 0,
  },
];
const templates = [
  {
    id: "t1",
    document_type: "PRESCRIPTION_ORDER",
    name: "Rx",
    version: 1,
    status: "ACTIVE",
    template_content: "x",
  },
  {
    id: "t2",
    document_type: "MEDICAL_LETTER",
    name: "Letter",
    version: 2,
    status: "ACTIVE",
    template_content: "Letter {{clinical.statement}}",
  },
  {
    id: "t4",
    document_type: "MEDICAL_LETTER",
    name: "Fixed",
    version: 1,
    status: "ACTIVE",
    template_content: "Fixed wording only",
  },
  { id: "t3", document_type: "MEDICAL_LETTER", name: "Old", version: 1, status: "ARCHIVED" },
] as TemplateRow[];

describe("document editor: the practitioner enters everything", () => {
  const renderEditor = (type: "MEDICAL_LETTER" | "PRESCRIPTION_ORDER", canPrescribe = true) =>
    render(
      <DocumentEditor
        target={{ mode: "new", type }}
        patients={patients}
        templates={templates}
        canPrescribe={canPrescribe}
        onClose={vi.fn()}
        onReadyForReview={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

  it("starts with every prescription field empty: no defaults, no suggestions", () => {
    renderEditor("PRESCRIPTION_ORDER");
    for (const label of [
      "Medicine name",
      "Generic name",
      "Dosage form",
      "Strength",
      "Route",
      "Frequency",
      "Duration",
      "Indication",
      "Quantity (figures)",
      "Quantity (words)",
      "Repeats",
    ]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value, label).toBe("");
    }
    expect((screen.getByLabelText("Directions for use") as HTMLTextAreaElement).value).toBe("");
    for (const el of screen.getAllByRole("textbox"))
      expect(el.getAttribute("placeholder")).toBeNull();
  });

  it("cannot be prepared for review while anything required is missing", () => {
    renderEditor("PRESCRIPTION_ORDER");
    expect(
      (screen.getByRole("button", { name: "Prepare for review" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("Medicine name must be entered by the practitioner")).toBeTruthy();
    expect(screen.getByText("An expiry date must be entered by the practitioner")).toBeTruthy();
  });

  it("flags a quantity in words that disagrees with the figures, without correcting it", async () => {
    renderEditor("PRESCRIPTION_ORDER");
    await userEvent.type(screen.getByLabelText("Quantity (figures)"), "5");
    await userEvent.type(screen.getByLabelText("Quantity (words)"), "six");
    expect(screen.getByText(/Quantity in words does not match the figures \(5\)/)).toBeTruthy();
    expect((screen.getByLabelText("Quantity (words)") as HTMLInputElement).value).toBe("six");
  });

  it("only offers active templates of the chosen type and only identity-verified patients", () => {
    renderEditor("MEDICAL_LETTER");
    const options = (label: string) =>
      within(screen.getByLabelText(label))
        .getAllByRole("option")
        .map((o) => o.textContent);
    expect(options("Template")).toEqual(["Select…", "Letter v2", "Fixed v1"]);
    expect(options("Patient")).toEqual(["Select…", "Test Member (CP-M-ABCD1234)"]);
  });

  it("does not let a practitioner who is not authorised start a prescription", () => {
    renderEditor("MEDICAL_LETTER", false);
    const option = within(screen.getByLabelText("Document type")).getByRole("option", {
      name: /Prescription/,
    });
    expect((option as HTMLOptionElement).disabled).toBe(true);
  });

  it("letters have no suggested wording either", async () => {
    renderEditor("MEDICAL_LETTER");
    await userEvent.selectOptions(screen.getByLabelText("Patient"), "m1");
    await userEvent.selectOptions(screen.getByLabelText("Template"), "t2");
    expect((screen.getByLabelText("Practitioner statement") as HTMLTextAreaElement).value).toBe("");
    expect(
      (screen.getByRole("button", { name: "Prepare for review" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("a fixed-wording template asks for nothing to be typed and can be prepared once patient and template are chosen", async () => {
    renderEditor("MEDICAL_LETTER");
    await userEvent.selectOptions(screen.getByLabelText("Patient"), "m1");
    await userEvent.selectOptions(screen.getByLabelText("Template"), "t4");
    expect(screen.queryByLabelText("Practitioner statement")).toBeNull();
    expect(screen.getByText(/fixed practitioner-approved wording/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Prepare for review" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("public verification page", () => {
  it("shows the minimum for a valid document and states what it does not reveal", () => {
    render(
      <VerificationResult
        result={{
          status: "VALID",
          documentId: "CP-MED-2026-000184",
          documentType: "Medical letter",
          issued: "02 October 2026",
          practitioner: "Dr Jane Smith",
          registration: "Verified",
          signature: "Simple electronic signature",
        }}
      />,
    );
    expect(screen.getByText("DOCUMENT VERIFIED")).toBeTruthy();
    for (const t of [
      "CP-MED-2026-000184",
      "Medical letter",
      "02 October 2026",
      "Dr Jane Smith",
      "Verified",
      "VALID",
    ])
      expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    expect(screen.getByText(/does not show the contents of the document/)).toBeTruthy();
  });

  it.each([
    ["REVOKED", "DOCUMENT REVOKED"],
    ["EXPIRED", "DOCUMENT EXPIRED"],
    ["INTEGRITY_FAILURE", "COULD NOT BE VERIFIED"],
    ["NOT_FOUND", "NO MATCHING DOCUMENT"],
    ["RATE_LIMITED", "TOO MANY ATTEMPTS"],
  ] as const)("a %s result never says verified", (status, title) => {
    render(
      <VerificationResult
        result={{
          status,
          documentId:
            status === "NOT_FOUND" || status === "RATE_LIMITED" ? undefined : "CP-MED-2026-000184",
        }}
      />,
    );
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.queryByText("DOCUMENT VERIFIED")).toBeNull();
    expect(screen.queryByText("VALID")).toBeNull();
  });
});

describe("member documents page", () => {
  const Page = MemberRoute.options.component as () => React.ReactElement;
  const rows = [
    {
      id: "d1",
      document_id: "CP-MED-2026-000001",
      document_type: "MEDICAL_LETTER",
      status: "ISSUED",
      issued_at: "2026-10-02T08:00:00Z",
      expires_at: null,
      verification_token: "T".repeat(43),
      practitioner: "Dr Jane Smith",
    },
    {
      id: "d2",
      document_id: "CP-RX-2026-000002",
      document_type: "PRESCRIPTION_ORDER",
      status: "REVOKED",
      issued_at: "2026-09-02T08:00:00Z",
      expires_at: null,
      verification_token: "U".repeat(43),
      practitioner: "Dr Jane Smith",
    },
  ];

  it("groups documents by type and offers view, download and verification", async () => {
    mocks.listMemberDocumentsFn.mockResolvedValue(rows);
    render(<Page />);
    expect(await screen.findByText("Medical letters")).toBeTruthy();
    expect(screen.getByText("Prescriptions / orders")).toBeTruthy();
    const first = screen.getByText("CP-MED-2026-000001").closest("li")!;
    expect(
      (within(first).getByRole("button", { name: /view/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (within(first).getByRole("button", { name: /download/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      within(first)
        .getByRole("link", { name: /verification/i })
        .getAttribute("href"),
    ).toBe(`/verify/${"T".repeat(43)}`);
  });

  it("a revoked document cannot be opened or downloaded", async () => {
    mocks.listMemberDocumentsFn.mockResolvedValue(rows);
    render(<Page />);
    const revoked = (await screen.findByText("CP-RX-2026-000002")).closest("li")!;
    expect(
      (within(revoked).getByRole("button", { name: /view/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(revoked).getByRole("button", { name: /download/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(revoked).getByText(/has been revoked/)).toBeTruthy();
  });

  it("offers no way to regenerate, edit, sign or delete a document", async () => {
    mocks.listMemberDocumentsFn.mockResolvedValue(rows);
    render(<Page />);
    await screen.findByText("Medical letters");
    for (const name of [/regenerate/i, /edit/i, /sign/i, /delete/i, /remove/i, /create/i])
      expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("asks anonymous visitors to sign in and loads nothing", () => {
    mocks.auth.user = null;
    render(<Page />);
    expect(screen.getByText(/Sign in to see your documents/)).toBeTruthy();
    expect(mocks.listMemberDocumentsFn).not.toHaveBeenCalled();
  });

  it("opens a document only through the audited, short-lived link", async () => {
    mocks.listMemberDocumentsFn.mockResolvedValue(rows);
    mocks.openDocumentFn.mockResolvedValue({
      url: "https://storage.example/x.pdf?token=t",
      expiresInSeconds: 60,
    });
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign },
      writable: true,
    });
    render(<Page />);
    const first = (await screen.findByText("CP-MED-2026-000001")).closest("li")!;
    await userEvent.click(within(first).getByRole("button", { name: /download/i }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("https://storage.example/x.pdf?token=t"),
    );
    expect(mocks.openDocumentFn).toHaveBeenCalledWith({
      data: { documentId: "d1", kind: "DOWNLOADED" },
    });
  });
});

describe("member requests tab", () => {
  const Page = MemberRoute.options.component as () => React.ReactElement;
  const reqs = [
    {
      id: "r1",
      document_type: "MEDICAL_LETTER",
      status: "REQUESTED",
      source: "member",
      created_at: "2026-10-02T08:00:00Z",
      decision_reason: null,
      member_note: null,
      practitioner: null,
    },
    {
      id: "r2",
      document_type: "PRESCRIPTION_ORDER",
      status: "DECLINED",
      source: "member",
      created_at: "2026-10-01T08:00:00Z",
      decision_reason: "Please book a consultation first",
      member_note: null,
      practitioner: "Dr Jane Smith",
    },
    {
      id: "r3",
      document_type: "MEDICAL_LETTER",
      status: "FULFILLED",
      source: "admin",
      created_at: "2026-09-01T08:00:00Z",
      decision_reason: null,
      member_note: null,
      practitioner: "Dr Jane Smith",
    },
  ];
  beforeEach(() => {
    mocks.listMemberDocumentsFn.mockResolvedValue([]);
    mocks.listMyRequestsFn.mockResolvedValue(reqs);
    mocks.createMyRequestFn.mockResolvedValue({ id: "new" });
    mocks.cancelMyRequestFn.mockResolvedValue({});
  });
  const open = async () => {
    render(<Page />);
    await userEvent.click(await screen.findByRole("tab", { name: "Requests" }));
  };

  it("has a Requests tab beside My documents", async () => {
    render(<Page />);
    expect(await screen.findByRole("tab", { name: "My documents" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Requests" })).toBeTruthy();
  });

  it("lists requests with plain-language status, the decline reason, and cancel only while waiting", async () => {
    await open();
    expect(await screen.findByText("Waiting to be assigned")).toBeTruthy();
    expect(screen.getByText("Not going ahead")).toBeTruthy();
    expect(screen.getByText(/Please book a consultation first/)).toBeTruthy();
    expect(screen.getByText(/opened for you by CannaPlug/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Cancel request" })).toHaveLength(1);
  });

  it("sends a request with a note, and says a request is not a prescription", async () => {
    await open();
    expect(await screen.findByText(/not a prescription and does not guarantee/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("What do you need?"), "PRESCRIPTION_ORDER");
    await userEvent.type(screen.getByLabelText(/Note for your practitioner/), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(mocks.createMyRequestFn).toHaveBeenCalled());
    const arg = mocks.createMyRequestFn.mock.calls[0]![0].data;
    expect(arg).toMatchObject({ type: "PRESCRIPTION_ORDER", note: "hello" });
    expect(arg.key.length).toBeGreaterThanOrEqual(8);
    expect(await screen.findByText(/Request sent/)).toBeTruthy();
  });

  it("promises the note is hidden from administrators and starts with nothing selected or filled in", async () => {
    await open();
    expect(await screen.findByText(/CannaPlug administrators cannot/)).toBeTruthy();
    expect((screen.getByLabelText(/Note for your practitioner/) as HTMLTextAreaElement).value).toBe(
      "",
    );
  });

  it("shows a refusal (for example an unverified ID) without pretending the request was sent", async () => {
    mocks.createMyRequestFn.mockRejectedValue(
      new Error("The member's identity must be verified first"),
    );
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Send request" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/identity must be verified/);
    expect(screen.queryByText(/Request sent/)).toBeNull();
  });

  it("cancels a waiting request", async () => {
    await open();
    await userEvent.click(await screen.findByRole("button", { name: "Cancel request" }));
    expect(mocks.cancelMyRequestFn).toHaveBeenCalledWith({ data: { requestId: "r1" } });
  });
});
