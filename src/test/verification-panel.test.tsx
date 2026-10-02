// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createIdUploadFn: vi.fn(),
  submitVerificationFn: vi.fn(),
  uploadToSignedUrl: vi.fn(),
}));
vi.mock("@/lib/verification.functions", () => ({
  createIdUploadFn: mocks.createIdUploadFn,
  submitVerificationFn: mocks.submitVerificationFn,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { storage: { from: () => ({ uploadToSignedUrl: mocks.uploadToSignedUrl }) } },
}));

import { VerificationBanner, VerificationPanel } from "@/components/account/VerificationPanel";

const png = () => new File([new Uint8Array([1, 2, 3])], "id.png", { type: "image/png" });

describe("VerificationPanel", () => {
  beforeEach(() => {
    mocks.createIdUploadFn.mockResolvedValue({ path: "u/abc.png", token: "tok" });
    mocks.uploadToSignedUrl.mockResolvedValue({ data: {}, error: null });
    mocks.submitVerificationFn.mockResolvedValue({ status: "pending" });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("uploads to the minted URL, then submits — in that order — and refreshes", async () => {
    const onDone = vi.fn().mockResolvedValue(undefined);
    render(<VerificationPanel verification={null} defaultDob="1990-05-17" onDone={onDone} />);
    await userEvent.upload(screen.getByLabelText(/photo or scan/i), png());
    await userEvent.click(screen.getByRole("button", { name: /submit for review/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mocks.createIdUploadFn).toHaveBeenCalledWith({ data: { mime: "image/png" } });
    expect(mocks.uploadToSignedUrl).toHaveBeenCalledWith("u/abc.png", "tok", expect.any(File), {
      contentType: "image/png",
    });
    expect(mocks.submitVerificationFn).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentType: "sa_id",
        path: "u/abc.png",
        dob: "1990-05-17",
      }),
    });
    expect(mocks.uploadToSignedUrl.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.submitVerificationFn.mock.invocationCallOrder[0]!,
    );
  });

  it("asks for an expiry date only for a passport or licence, and refuses a lapsed one", async () => {
    render(<VerificationPanel verification={null} defaultDob="1990-05-17" onDone={vi.fn()} />);
    // SA ID (default): no expiry field.
    expect(screen.queryByLabelText(/expiry date/i)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText(/document type/i), "passport");
    const expiry = screen.getByLabelText(/expiry date/i);
    await userEvent.upload(screen.getByLabelText(/photo or scan/i), png());
    fireEvent.change(expiry, { target: { value: "2020-01-01" } });
    await userEvent.click(screen.getByRole("button", { name: /submit for review/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/expired/i);
    expect(mocks.createIdUploadFn).not.toHaveBeenCalled();
    // A current date goes through and is sent to the server.
    const fiveYears = new Date();
    fiveYears.setFullYear(fiveYears.getFullYear() + 5);
    const valid = fiveYears.toISOString().slice(0, 10);
    fireEvent.change(expiry, { target: { value: valid } });
    await userEvent.click(screen.getByRole("button", { name: /submit for review/i }));
    await waitFor(() => expect(mocks.submitVerificationFn).toHaveBeenCalled());
    expect(mocks.submitVerificationFn).toHaveBeenCalledWith({
      data: expect.objectContaining({ documentType: "passport", expiresOn: valid }),
    });
  });

  it("an SA ID submission sends no expiry", async () => {
    render(<VerificationPanel verification={null} defaultDob="1990-05-17" onDone={vi.fn()} />);
    await userEvent.upload(screen.getByLabelText(/photo or scan/i), png());
    await userEvent.click(screen.getByRole("button", { name: /submit for review/i }));
    await waitFor(() => expect(mocks.submitVerificationFn).toHaveBeenCalled());
    expect(mocks.submitVerificationFn.mock.calls[0]![0].data.expiresOn).toBeNull();
  });

  it("refuses an under-18 date of birth before anything is uploaded", async () => {
    const young = new Date();
    young.setFullYear(young.getFullYear() - 16);
    render(
      <VerificationPanel
        verification={null}
        defaultDob={young.toISOString().slice(0, 10)}
        onDone={vi.fn()}
      />,
    );
    await userEvent.upload(screen.getByLabelText(/photo or scan/i), png());
    await userEvent.click(screen.getByRole("button", { name: /submit for review/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/18 or older/);
    expect(mocks.createIdUploadFn).not.toHaveBeenCalled();
  });

  it("requires a file, and surfaces a server refusal without leaving the form", async () => {
    mocks.submitVerificationFn.mockRejectedValue(new Error("Your ID is being reviewed"));
    render(<VerificationPanel verification={null} defaultDob="1990-05-17" onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /submit for review/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/choose a photo/i);
    await userEvent.upload(screen.getByLabelText(/photo or scan/i), png());
    await userEvent.click(screen.getByRole("button", { name: /submit for review/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/being reviewed/));
    expect(screen.getByRole("button", { name: /submit for review/i })).toBeTruthy();
  });

  it("shows no form while pending, and the reason after a rejection", () => {
    const { rerender } = render(
      <VerificationPanel verification={{ status: "pending" }} defaultDob="" onDone={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: /submit for review/i })).toBeNull();
    expect(screen.getByTestId("verification-status").textContent).toMatch(/being reviewed/i);
    rerender(
      <VerificationPanel
        verification={{ status: "rejected", rejection_code: "unreadable", attempt_count: 1 }}
        defaultDob=""
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByTestId("verification-status").textContent).toMatch(/couldn't read/i);
    expect(screen.getByRole("button", { name: /submit for review/i })).toBeTruthy();
  });

  it("the dashboard banner disappears once verified", () => {
    const { container, rerender } = render(
      <VerificationBanner verification={null} onOpen={() => {}} />,
    );
    expect(screen.getByTestId("verification-banner")).toBeTruthy();
    rerender(<VerificationBanner verification={{ status: "verified" }} onOpen={() => {}} />);
    expect(container.textContent).toBe("");
  });
});
