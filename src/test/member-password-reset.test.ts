import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  assertRole: vi.fn(),
  getUserById: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  insert: vi.fn(),
}));
vi.mock("@/lib/admin-data.server", () => ({ assertRole: m.assertRole }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    auth: {
      admin: { getUserById: m.getUserById },
      resetPasswordForEmail: m.resetPasswordForEmail,
    },
    from: () => ({ insert: m.insert }),
  },
}));

import { sendMemberPasswordReset } from "@/lib/member-password-reset.server";

const MEMBER = "11111111-1111-4111-8111-111111111111";

describe("staff send a locked-out member a reset link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.assertRole.mockResolvedValue("manager");
    m.getUserById.mockResolvedValue({ data: { user: { email: "m@example.com" } }, error: null });
    m.resetPasswordForEmail.mockResolvedValue({ error: null });
    m.insert.mockResolvedValue({ error: null });
  });

  it("checks the manager role first, emails the reset page link and audits without the email", async () => {
    await expect(sendMemberPasswordReset("staff-1", MEMBER)).resolves.toEqual({ sent: true });
    expect(m.assertRole).toHaveBeenCalledWith("staff-1", "manager");
    expect(m.resetPasswordForEmail).toHaveBeenCalledWith("m@example.com", {
      redirectTo: "https://cannaplug012.co.za/reset-password",
    });
    const row = m.insert.mock.calls[0]![0];
    expect(row).toMatchObject({
      actor_user_id: "staff-1",
      action: "member_password_reset_sent",
      target_user_id: MEMBER,
    });
    expect(JSON.stringify(row)).not.toContain("m@example.com");
  });

  it("a budtender (or anyone below manager) cannot send one", async () => {
    m.assertRole.mockRejectedValue(new Error("Forbidden: insufficient staff permissions"));
    await expect(sendMemberPasswordReset("bud-1", MEMBER)).rejects.toThrow(/Forbidden/);
    expect(m.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(m.insert).not.toHaveBeenCalled();
  });

  it("explains a sending limit and records nothing when the email did not go", async () => {
    m.resetPasswordForEmail.mockResolvedValue({ error: new Error("email rate limit exceeded") });
    await expect(sendMemberPasswordReset("staff-1", MEMBER)).rejects.toThrow(/too many/);
    expect(m.insert).not.toHaveBeenCalled();
  });
});
