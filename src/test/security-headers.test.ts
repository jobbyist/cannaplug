import { describe, expect, it } from "vitest";
import { applySecurityHeaders, buildCsp } from "@/lib/clinical/security-headers";

describe("security headers", () => {
  it("every response gets nosniff, a referrer policy, a permissions policy and a CSP", () => {
    const h = new Headers();
    applySecurityHeaders("/shop", h, { https: true, supabaseOrigin: "https://abc.supabase.co" });
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("Strict-Transport-Security")).toContain("max-age=31536000");
    expect(h.get("Permissions-Policy")).toContain("camera=()");
    const csp = h.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' https://abc.supabase.co wss://abc.supabase.co");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(csp).not.toMatch(/script-src[^;]*https:/); // no remote scripts
  });
  it("HSTS only over https; clinical pages are never framed and keep the rest of the policy", () => {
    const plain = new Headers();
    applySecurityHeaders("/shop", plain, { https: false });
    expect(plain.has("Strict-Transport-Security")).toBe(false);
    const clinical = new Headers();
    applySecurityHeaders("/doctor", clinical, { https: true });
    const csp = clinical.get("Content-Security-Policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(clinical.get("X-Frame-Options")).toBe("DENY");
    expect(clinical.get("Cache-Control")).toBe("no-store");
  });
  it("allows the Lovable preview to frame ordinary pages only", () => {
    expect(buildCsp()).toContain("frame-ancestors 'self' https://*.lovable.app");
  });
});
