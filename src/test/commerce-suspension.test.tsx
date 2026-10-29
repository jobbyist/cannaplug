// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const db = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: db.rpc } }));
vi.mock("@/lib/admin-data.server", () => ({ assertRole: vi.fn() }));
const fns = vi.hoisted(() => ({ status: vi.fn(), resume: vi.fn() }));
vi.mock("@/lib/commerce.functions", () => ({
  getCommerceStatusFn: fns.status,
  resumeCommerceFn: fns.resume,
}));

import {
  assertCheckoutOpen,
  assertPosOpen,
  commerceSuspended,
  CHECKOUT_SUSPENDED_MESSAGE,
  POS_SUSPENDED_MESSAGE,
} from "@/lib/commerce-suspension.server";
import { CommerceSuspendedBanner } from "@/components/CommerceSuspendedBanner";
import { useCommerceSuspended } from "@/hooks/use-commerce-suspended";

const open = { data: { suspended: false }, error: null };
const paused = { data: { suspended: true, since: "2026-10-31T00:00:00Z" }, error: null };

describe("commerce suspension (server gate)", () => {
  beforeEach(() => db.rpc.mockReset());

  it("refuses checkout and POS sales while suspended, with a plain message", async () => {
    db.rpc.mockResolvedValue(paused);
    await expect(assertCheckoutOpen()).rejects.toThrow(CHECKOUT_SUSPENDED_MESSAGE);
    await expect(assertPosOpen()).rejects.toThrow(POS_SUSPENDED_MESSAGE);
  });

  it("lets both through once the suspension is lifted (a payment resumes them with no redeploy)", async () => {
    db.rpc.mockResolvedValue(paused);
    await expect(assertPosOpen()).rejects.toBeTruthy();
    db.rpc.mockResolvedValue(open);
    await expect(assertPosOpen()).resolves.toBeUndefined();
    await expect(assertCheckoutOpen()).resolves.toBeUndefined();
  });

  it("treats a database without the migration yet as open, but surfaces other errors", async () => {
    db.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "missing" } });
    expect(await commerceSuspended()).toBe(false);
    db.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(commerceSuspended()).rejects.toBeTruthy();
  });
});

function Probe() {
  const { suspended } = useCommerceSuspended();
  return suspended ? <CommerceSuspendedBanner kind="checkout" /> : <p>open</p>;
}

describe("commerce suspension (screens)", () => {
  afterEach(cleanup);
  beforeEach(() => {
    fns.status.mockReset();
    fns.resume.mockReset();
  });

  it("shows the banner while suspended and nothing when open", async () => {
    fns.status.mockResolvedValue({ suspended: true });
    const { unmount } = render(<Probe />);
    expect(await screen.findByTestId("commerce-suspended")).toBeTruthy();
    expect(screen.getByText(/visit us in store/i)).toBeTruthy();
    unmount();
    fns.status.mockResolvedValue({ suspended: false });
    render(<Probe />);
    await waitFor(() => expect(screen.getByText("open")).toBeTruthy());
  });

  it("stays open when the status cannot be read (the server still enforces it)", async () => {
    fns.status.mockRejectedValue(new Error("offline"));
    render(<Probe />);
    await waitFor(() => expect(fns.status).toHaveBeenCalled());
    expect(screen.getByText("open")).toBeTruthy();
  });

  it("offers the admin resume button only on request", () => {
    const { rerender } = render(<CommerceSuspendedBanner kind="pos" />);
    expect(screen.queryByRole("button", { name: /resume now/i })).toBeNull();
    rerender(<CommerceSuspendedBanner kind="pos" canResume />);
    expect(screen.getByRole("button", { name: /resume now/i })).toBeTruthy();
  });
});
