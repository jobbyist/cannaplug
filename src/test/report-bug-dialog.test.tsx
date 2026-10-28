// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({ submitBugReportFn: vi.fn() }));
vi.mock("@/lib/forms.functions", () => ({ submitBugReportFn: api.submitBugReportFn }));

import { ReportBugDialog } from "@/components/ReportBugDialog";

beforeEach(() => {
  api.submitBugReportFn.mockReset();
  api.submitBugReportFn.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

const open = () => render(<ReportBugDialog open onOpenChange={() => {}} />);

describe("Report a bug popup", () => {
  it("needs a real message before it can be sent, and says what not to include", async () => {
    const user = userEvent.setup();
    open();
    const send = screen.getByRole("button", { name: "Send report" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(screen.getByText(/don.t include ID numbers, health details or passwords/i)).toBeTruthy();
    await user.type(screen.getByLabelText("What happened?"), "short");
    expect(send.disabled).toBe(true);
    await user.type(screen.getByLabelText("What happened?"), " but now it is long enough");
    expect(send.disabled).toBe(false);
  });

  it("sends the type, message, optional details, the page and a request key, then thanks the visitor", async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("button", { name: "Feedback" }));
    await user.type(
      screen.getByLabelText("What happened?"),
      "The catalog filter is great but slow.",
    );
    await user.type(screen.getByLabelText("Your name (optional)"), "Thandi");
    await user.type(screen.getByLabelText(/Email, so we can reply/), "thandi@example.com");
    await user.click(screen.getByRole("button", { name: "Send report" }));
    await waitFor(() => expect(api.submitBugReportFn).toHaveBeenCalled());
    const sent = api.submitBugReportFn.mock.calls[0]![0].data;
    expect(sent).toMatchObject({
      kind: "feedback",
      message: "The catalog filter is great but slow.",
      name: "Thandi",
      email: "thandi@example.com",
      website: "",
    });
    expect(typeof sent.page).toBe("string");
    expect(String(sent.key).length).toBeGreaterThanOrEqual(8);
    expect(await screen.findByTestId("bug-sent")).toBeTruthy();
  });

  it("rejects a badly formed email before sending, and shows a failure without pretending it was sent", async () => {
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText("What happened?"), "Something is broken on checkout.");
    await user.type(screen.getByLabelText(/Email, so we can reply/), "nope");
    expect(
      (screen.getByRole("button", { name: "Send report" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.clear(screen.getByLabelText(/Email, so we can reply/));
    api.submitBugReportFn.mockRejectedValueOnce(new Error("You have sent a few messages already."));
    await user.click(screen.getByRole("button", { name: "Send report" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/few messages already/);
    expect(screen.queryByTestId("bug-sent")).toBeNull();
  });
});
