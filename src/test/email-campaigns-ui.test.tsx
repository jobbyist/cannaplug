// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
  listCampaignsFn: vi.fn(),
  emailActivityFn: vi.fn(),
  saveCampaignFn: vi.fn(),
  testCampaignFn: vi.fn(),
  sendCampaignFn: vi.fn(),
  getMyNewsletterFn: vi.fn(),
  setMyNewsletterFn: vi.fn(),
}));
vi.mock("@/lib/email-campaigns.functions", () => fns);

import { EmailCampaignsPanel, campaignProblem } from "@/components/admin/EmailCampaignsPanel";
import { EmailPreferences } from "@/components/account/EmailPreferences";

const ACTIVITY = {
  totals: { sent: 12, waiting: 1, failed: 0 },
  rows: [
    {
      id: "n1",
      label: "Order ready",
      category: "transactional",
      status: "sent",
      to: "t***@example.com",
      attempts: 1,
      created_at: "2026-10-25T10:00:00Z",
      sent_at: "2026-10-25T10:01:00Z",
      error: null,
    },
  ],
};

beforeEach(() => {
  Object.values(fns).forEach((f) => f.mockReset());
  fns.listCampaignsFn.mockResolvedValue({ campaigns: [], subscribers: 3 });
  fns.emailActivityFn.mockResolvedValue(ACTIVITY);
});
afterEach(() => cleanup());

describe("campaign editor", () => {
  it("checks the fields before saving", () => {
    const ok = {
      subject: "Spring",
      preheader: "",
      headline: "New in",
      body: "Ten characters at least",
      ctaLabel: "",
      ctaUrl: "",
    };
    expect(campaignProblem(ok)).toBeNull();
    expect(campaignProblem({ ...ok, subject: "x" })).toMatch(/subject/);
    expect(campaignProblem({ ...ok, ctaLabel: "Shop" })).toMatch(/both a label and a link/);
    expect(campaignProblem({ ...ok, ctaLabel: "Shop", ctaUrl: "http://x" })).toMatch(/https/);
  });

  it("writes a campaign, sends a test, then sends what is on screen after confirming", async () => {
    fns.saveCampaignFn.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      status: "draft",
    });
    fns.testCampaignFn.mockResolvedValue({ id: "c", sent_to: "info@cannaplug012.co.za" });
    fns.sendCampaignFn.mockResolvedValue({ id: "c", status: "sent", recipients: 3 });
    const user = userEvent.setup();
    render(<EmailCampaignsPanel />);
    expect(await screen.findByText("Order ready")).toBeTruthy();
    expect(screen.getByText(/Last 7 days/).textContent).toMatch(/12 sent/);
    await user.click(screen.getByRole("button", { name: /New campaign/ }));
    await user.type(screen.getByLabelText("Subject line"), "Spring specials");
    await user.type(screen.getByLabelText("Headline"), "New in store");
    await user.type(screen.getByLabelText("Message"), "Come and see what just arrived.");
    await user.click(screen.getByRole("button", { name: "Send a test to me" }));
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Test sent to info@cannaplug012.co.za/,
    );
    expect(fns.saveCampaignFn.mock.calls[0]![0].data.input).toMatchObject({
      subject: "Spring specials",
      ctaUrl: "https://cannaplug012.co.za/shop",
    });
    await user.click(screen.getByRole("button", { name: /Send to 3 subscribers/ }));
    await user.click(await screen.findByRole("button", { name: "Send now" }));
    await waitFor(() => expect(fns.sendCampaignFn).toHaveBeenCalledTimes(1));
    expect(fns.sendCampaignFn.mock.calls[0]![0].data.id).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect((await screen.findByRole("status")).textContent).toMatch(/going out to 3 subscribers/);
  });
});

describe("member email preferences", () => {
  it("shows the current choice and saves a change", async () => {
    fns.getMyNewsletterFn.mockResolvedValue({ subscribed: false });
    fns.setMyNewsletterFn.mockResolvedValue({ subscribed: true });
    const user = userEvent.setup();
    render(<EmailPreferences />);
    const sw = await screen.findByRole("switch");
    await waitFor(() => expect((sw as HTMLButtonElement).disabled).toBe(false));
    await user.click(sw);
    await waitFor(() => expect(fns.setMyNewsletterFn).toHaveBeenCalled());
    expect(fns.setMyNewsletterFn.mock.calls[0]![0].data.subscribe).toBe(true);
    expect((await screen.findByRole("status")).textContent).toMatch(/subscribed/);
  });
});
