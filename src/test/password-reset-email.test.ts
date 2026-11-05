import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendPasswordResetEmail, type ResetDeps } from "@/lib/password-reset.server";
import { renderTemplate } from "@/lib/notifications/templates";

const LINK =
  "https://khltynzzcjhlujxbgyod.supabase.co/auth/v1/verify?token=secret-token&type=recovery&redirect_to=https://cannaplug012.co.za/reset-password";

function fakeDeps(over: { env?: Record<string, string | undefined> } = {}) {
  const rpc = vi.fn(
    async (
      fn: string,
      _args: Record<string, unknown>,
    ): Promise<{
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    }> =>
      fn === "password_reset_begin"
        ? { data: { allowed: true, request_id: "req-1" }, error: null }
        : { data: null, error: null },
  );
  const generateLink = vi.fn(async () => ({
    data: {
      properties: { action_link: LINK },
      user: { user_metadata: { first_name: "Thandi" } },
    },
    error: null as { message: string; status?: number } | null,
  }));
  const resetPasswordForEmail = vi.fn(async () => ({ error: null }));
  const fetchFn = vi.fn(
    async (_url: string, _init: { body: string; headers: Record<string, string> }) => ({
      ok: true,
      status: 200,
      text: async () => '{"id":"email-1"}',
    }),
  );
  const deps: ResetDeps = {
    admin: { rpc, auth: { resetPasswordForEmail, admin: { generateLink } } },
    fetchFn,
    env: over.env ?? { RESEND_API_KEY: "re_test" },
  };
  return { deps, rpc, generateLink, resetPasswordForEmail, fetchFn };
}

const finishStatus = (rpc: ReturnType<typeof fakeDeps>["rpc"]) =>
  rpc.mock.calls.find(([fn]) => fn === "password_reset_finish")?.[1]?.["p_status"];

describe("branded password-reset emails (sent by the app through Resend)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks Supabase for the one-time link and emails it from the CannaPlug sender", async () => {
    const f = fakeDeps();
    const out = await sendPasswordResetEmail(
      { email: " Thandi@Example.com ", ipHash: "iphash01", actor: null, key: "key-12345" },
      f.deps,
    );
    expect(out).toEqual({ ok: true });
    expect(f.rpc).toHaveBeenCalledWith("password_reset_begin", {
      p_email: "thandi@example.com",
      p_ip_hash: "iphash01",
      p_actor: null,
      p_idempotency_key: "key-12345",
    });
    expect(f.generateLink).toHaveBeenCalledWith({
      type: "recovery",
      email: "thandi@example.com",
      options: { redirectTo: "https://cannaplug012.co.za/reset-password" },
    });
    const [url, init] = f.fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers["Idempotency-Key"]).toBe("pw-reset:req-1");
    const body = JSON.parse(init.body);
    expect(body.from).toMatch(/cannaplug012\.co\.za>$/);
    expect(body.to).toEqual(["thandi@example.com"]);
    expect(body.subject).toBe("Reset your Cannaplug password");
    expect(body.html).toContain(LINK.replace(/&/g, "&amp;"));
    expect(body.html).toContain("Hi Thandi,");
    expect(finishStatus(f.rpc)).toBe("sent");
  });

  it("gives the same answer when there is no account, and sends nothing", async () => {
    const f = fakeDeps();
    f.generateLink.mockResolvedValueOnce({
      data: null as never,
      error: { message: "User with this email not found", status: 404 },
    });
    const out = await sendPasswordResetEmail(
      { email: "nobody@example.com", ipHash: null, actor: null, key: "key-12345" },
      f.deps,
    );
    expect(out).toEqual({ ok: true });
    expect(f.fetchFn).not.toHaveBeenCalled();
    expect(finishStatus(f.rpc)).toBe("no_account");
  });

  it("respects the database's limits and makes no link when refused", async () => {
    const f = fakeDeps();
    f.rpc.mockResolvedValueOnce({ data: { allowed: false, reason: "email_limit" }, error: null });
    const out = await sendPasswordResetEmail(
      { email: "a@b.co", ipHash: null, actor: null, key: "key-12345" },
      f.deps,
    );
    expect(out).toEqual({ ok: false, reason: "email_limit" });
    expect(f.generateLink).not.toHaveBeenCalled();
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it("a retry with the same key sends nothing twice", async () => {
    const f = fakeDeps();
    f.rpc.mockResolvedValueOnce({
      data: { allowed: true, request_id: "req-1", replayed: true },
      error: null,
    });
    await sendPasswordResetEmail(
      { email: "a@b.co", ipHash: null, actor: null, key: "key-12345" },
      f.deps,
    );
    expect(f.generateLink).not.toHaveBeenCalled();
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it("reports a Resend failure and records it, without leaking the link", async () => {
    const f = fakeDeps();
    f.fetchFn.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" });
    const out = await sendPasswordResetEmail(
      { email: "a@b.co", ipHash: null, actor: null, key: "key-12345" },
      f.deps,
    );
    expect(out).toEqual({ ok: false, reason: "send_failed" });
    expect(JSON.stringify(out)).not.toContain("secret-token");
    expect(finishStatus(f.rpc)).toBe("failed");
  });

  it("without a Resend key it falls back to Supabase's own mailer, so resets never stop", async () => {
    const f = fakeDeps({ env: {} });
    const out = await sendPasswordResetEmail(
      { email: "a@b.co", ipHash: null, actor: null, key: "key-12345" },
      f.deps,
    );
    expect(out).toEqual({ ok: true });
    expect(f.resetPasswordForEmail).toHaveBeenCalledWith("a@b.co", {
      redirectTo: "https://cannaplug012.co.za/reset-password",
    });
    expect(f.generateLink).not.toHaveBeenCalled();
    expect(finishStatus(f.rpc)).toBe("sent");
  });

  it("the fallback reports a Supabase mailer failure instead of claiming success", async () => {
    const f = fakeDeps({ env: {} });
    f.resetPasswordForEmail.mockResolvedValueOnce({
      error: { message: "email rate limit exceeded" },
    } as never);
    const out = await sendPasswordResetEmail(
      { email: "a@b.co", ipHash: null, actor: null, key: "key-12345" },
      f.deps,
    );
    expect(out).toEqual({ ok: false, reason: "send_failed" });
    expect(finishStatus(f.rpc)).toBe("failed");
  });

  it("the email uses the CannaPlug design, escapes the name and says when staff sent it", () => {
    const r = renderTemplate(
      "password_reset",
      { reset_url: LINK, first_name: "<b>x</b>", by_staff: true },
      { siteUrl: "https://cannaplug012.co.za" },
    )!;
    expect(r.html).toContain("#0B3D20"); // Forest
    expect(r.html).toContain("#D4AF37"); // Gold
    expect(r.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(r.html).toMatch(/member of the Cannaplug team sent you this link/);
    expect(r.text).toMatch(/works once, for one hour/);
  });
});
