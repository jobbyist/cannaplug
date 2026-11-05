import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  assertRole: vi.fn(),
  getUserById: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));
vi.mock("@/lib/admin-data.server", () => ({ assertRole: m.assertRole }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { auth: { admin: { getUserById: m.getUserById } } },
}));
vi.mock("@/lib/password-reset.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/password-reset.server")>()),
  sendPasswordResetEmail: m.sendPasswordResetEmail,
  liveResetDeps: async () => ({}),
}));

import { sendMemberPasswordReset } from "@/lib/member-password-reset.server";

const MEMBER = "11111111-1111-4111-8111-111111111111";

describe("staff send a locked-out member a reset link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.assertRole.mockResolvedValue("manager");
    m.getUserById.mockResolvedValue({ data: { user: { email: "m@example.com" } }, error: null });
    m.sendPasswordResetEmail.mockResolvedValue({ ok: true });
  });

  it("checks the manager role first, then sends the branded email as that staff member", async () => {
    await expect(sendMemberPasswordReset("staff-1", MEMBER, "key-12345")).resolves.toEqual({
      sent: true,
    });
    expect(m.assertRole).toHaveBeenCalledWith("staff-1", "manager");
    expect(m.sendPasswordResetEmail).toHaveBeenCalledWith(
      { email: "m@example.com", ipHash: null, actor: "staff-1", key: "key-12345" },
      expect.anything(),
    );
  });

  it("a budtender (or anyone below manager) cannot send one", async () => {
    m.assertRole.mockRejectedValue(new Error("Forbidden: insufficient staff permissions"));
    await expect(sendMemberPasswordReset("bud-1", MEMBER, "key-12345")).rejects.toThrow(
      /Forbidden/,
    );
    expect(m.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("explains a refusal in plain words", async () => {
    m.sendPasswordResetEmail.mockResolvedValue({ ok: false, reason: "email_limit" });
    await expect(sendMemberPasswordReset("staff-1", MEMBER, "key-12345")).rejects.toThrow(
      /last hour/,
    );
  });
});
