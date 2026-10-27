// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const path = vi.hoisted(() => ({ current: "/" }));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: path.current } }),
}));

import { AGE_GATE_KEY, AgeGate, ageGateNeeded } from "@/components/AgeGate";

const DAY = 24 * 60 * 60 * 1000;
const CHROME = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36";

describe("ageGateNeeded", () => {
  const now = Date.UTC(2026, 9, 25);
  it("asks a first-time visitor, and again after 30 days", () => {
    expect(ageGateNeeded("/", CHROME, null, now)).toBe(true);
    expect(ageGateNeeded("/shop", CHROME, now - 29 * DAY, now)).toBe(false);
    expect(ageGateNeeded("/shop", CHROME, now - 30 * DAY, now)).toBe(true);
    expect(ageGateNeeded("/shop", CHROME, now + DAY, now)).toBe(true); // a future timestamp is not trusted
  });
  it("never asks on /verify, staff areas or offline, nor search engines and link previews", () => {
    for (const p of [
      "/verify/abc",
      "/verify",
      "/admin",
      "/admin/pos/receipt/1",
      "/doctor",
      "/offline",
    ])
      expect(ageGateNeeded(p, CHROME, null, now), p).toBe(false);
    for (const ua of [
      "Googlebot/2.1",
      "bingbot/2.0",
      "facebookexternalhit/1.1",
      "WhatsApp/2.23",
      "Chrome-Lighthouse",
    ])
      expect(ageGateNeeded("/", ua, null, now), ua).toBe(false);
    expect(ageGateNeeded("/verifyx", CHROME, null, now)).toBe(true);
  });
});

describe("<AgeGate />", () => {
  beforeEach(() => {
    window.localStorage.clear();
    path.current = "/";
  });
  afterEach(cleanup);

  it("blocks until confirmed, remembers the answer, and 'No' keeps it closed", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AgeGate />);
    const dialog = await screen.findByRole("dialog", { name: "Are you 18 or older?" });
    await user.click(screen.getByRole("button", { name: "No" }));
    expect(dialog.textContent).toMatch(/adults aged 18 and over only/);
    await user.click(screen.getByRole("button", { name: "Yes, I'm 18 or older" }));
    expect(screen.queryByRole("dialog", { name: "Are you 18 or older?" })).toBeNull();
    expect(Number(window.localStorage.getItem(AGE_GATE_KEY))).toBeGreaterThan(0);
    unmount();
    render(<AgeGate />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("dialog", { name: "Are you 18 or older?" })).toBeNull();
  });

  it("does not show a responsible-consumption link on the gate", async () => {
    render(<AgeGate />);
    await screen.findByRole("dialog", { name: "Are you 18 or older?" });
    expect(screen.queryByRole("button", { name: "Responsible consumption" })).toBeNull();
  });
});
