import { describe, expect, it } from "vitest";
import { AUTH_REDIRECT, authProblem } from "@/lib/auth-messages";

describe("auth messages", () => {
  it("sends people back to the live site", () => {
    expect(AUTH_REDIRECT).toBe("https://cannaplug012.co.za/account");
  });
  it("explains Supabase errors in plain words", () => {
    expect(authProblem("email rate limit exceeded").kind).toBe("rate_limited");
    expect(
      authProblem("For security purposes, you can only request this after 37 seconds.").message,
    ).toMatch(/37 seconds/);
    expect(authProblem("Email not confirmed").kind).toBe("unconfirmed");
    expect(authProblem("Invalid login credentials").message).toMatch(/don't match/);
    expect(authProblem("User already registered").message).toMatch(/already has an account/);
  });
});
