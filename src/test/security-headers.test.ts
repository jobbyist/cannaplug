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
    expect(csp).toContain(
      "form-action 'self' https://www.payfast.co.za https://sandbox.payfast.co.za",
    );
    expect(csp).not.toMatch(/unsafe-eval/);
  });
  it("the only remote script is PayFast's onsite engine, pinned to the exact file; frames only PayFast's payment page", () => {
    const csp = buildCsp();
    const directive = (name: string) =>
      csp
        .split("; ")
        .find((d) => d.startsWith(`${name} `))!
        .split(" ")
        .slice(1);
    const remoteScripts = directive("script-src").filter((s) => s.startsWith("https:"));
    expect(remoteScripts.sort()).toEqual([
      "https://sandbox.payfast.co.za/onsite/engine.js",
      "https://www.payfast.co.za/onsite/engine.js",
    ]);
    // Mutation guard: a whole-host or wildcard script source would let any PayFast (or other) script run.
    for (const s of directive("script-src"))
      expect(s).not.toMatch(/^https:\/\/[^/]+\/?$|\*|^https:$/);
    expect(directive("frame-src").sort()).toEqual([
      "https://payment.payfast.io",
      "https://sandbox.payfast.co.za",
    ]);
    expect(directive("style-src")).toContain("https://payment.payfast.io/onsite/engine.css");
    expect(buildCsp({ payfastOnsite: false })).toContain("frame-src 'none'");
    expect(buildCsp({ payfastOnsite: false })).not.toMatch(/payfast\.(io|co\.za)\/onsite/);
  });
  it("clinical pages never load PayFast's script or frame", () => {
    const h = new Headers();
    applySecurityHeaders("/doctor/notes", h, { https: true });
    const csp = h.get("Content-Security-Policy")!;
    expect(csp).toContain("frame-src 'none'");
    expect(csp).not.toMatch(/onsite\/engine/);
    expect(csp).not.toMatch(/script-src[^;]*https:/);
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
