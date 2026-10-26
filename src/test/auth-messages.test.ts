import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  it("never asks customers to confirm their email (confirmation is off)", () => {
    expect(authProblem("Email not confirmed").message).not.toMatch(/confirm|inbox|link/i);
    const page = readFileSync(resolve(__dirname, "../routes/account.tsx"), "utf8");
    expect(page).not.toMatch(/confirm your email|confirmation link|check your inbox/i);
  });
});
