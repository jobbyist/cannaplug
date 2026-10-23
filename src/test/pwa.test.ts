import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { buildCsp } from "@/lib/clinical/security-headers";
import {
  INSTALL_SEEN_KEY,
  WEEK_MS,
  installMode,
  isIosSafari,
  markSeen,
  readSeenAt,
} from "@/lib/pwa/install";

const root = join(__dirname, "..", "..");
type Sw = {
  strategyFor(method: string, url: string, origin: string, accept: string | null): string;
  storable(r: unknown): boolean;
  assetUrlsIn(html: string): string[];
  VERSION: string;
};
/** Loads the real public/sw.js the browser gets, outside a worker (it only exports its pure helpers). */
function loadSw(): Sw {
  const mod = { exports: {} as Sw };
  runInNewContext(readFileSync(join(root, "public/sw.js"), "utf8"), { module: mod, URL });
  return mod.exports;
}
const sw = loadSw();
const O = "https://cannaplug012.co.za";
const page = (path: string) => sw.strategyFor("GET", `${O}${path}`, O, "text/html,*/*");

describe("service worker cache policy", () => {
  it("never caches private, live or authenticated routes", () => {
    for (const p of [
      "/admin",
      "/admin?tab=pos",
      "/admin/pos/receipt/abc",
      "/account",
      "/account/orders",
      "/doctor",
      "/doctor/patients/1",
      "/member/documents",
      "/checkout",
      "/payment/return?order=x",
      "/verify/abc",
      "/unsubscribe?t=1",
      "/subscribe/admin-api",
      "/api/public/payments/payfast-itn",
      "/_serverFn/abc",
    ])
      expect(page(p), p).toBe("network");
  });

  it("never caches Supabase, PayFast, PayPal or any other third party; never a non-GET", () => {
    for (const u of [
      "https://khltynzzcjhlujxbgyod.supabase.co/rest/v1/products",
      "https://khltynzzcjhlujxbgyod.supabase.co/storage/v1/object/public/product-images/a.png",
      "https://www.payfast.co.za/eng/process",
      "https://www.paypal.com/checkoutnow",
    ])
      expect(sw.strategyFor("GET", u, O, "*/*"), u).toBe("network");
    expect(sw.strategyFor("POST", `${O}/shop`, O, "text/html")).toBe("network");
    expect(sw.strategyFor("GET", `${O}/?code=abc`, O, "text/html")).toBe("network"); // auth callback
    expect(sw.strategyFor("GET", "not a url", O, null)).toBe("network");
  });

  it("cache-first for hashed assets, icons and Google Fonts; network-first for public pages", () => {
    expect(sw.strategyFor("GET", `${O}/assets/index-abc123.js`, O, "*/*")).toBe("static");
    expect(sw.strategyFor("GET", `${O}/icons/icon-192.png`, O, "image/*")).toBe("static");
    expect(sw.strategyFor("GET", "https://fonts.gstatic.com/s/inter/v1.woff2", O, "*/*")).toBe(
      "static",
    );
    expect(
      sw.strategyFor("GET", "https://fonts.googleapis.com/css2?family=Inter", O, "text/css"),
    ).toBe("static");
    for (const p of ["/", "/shop", "/journal", "/journal/some-article", "/about", "/offline"])
      expect(page(p), p).toBe("page");
    expect(sw.strategyFor("GET", `${O}/sw.js`, O, "*/*")).toBe("network");
    expect(sw.strategyFor("GET", `${O}/shop`, O, "application/json")).toBe("network");
  });

  it("stores only complete 200 answers that are not no-store or private", () => {
    const r = (status: number, cc = "") => ({
      ok: status < 300,
      status,
      type: "basic",
      headers: new Headers(cc ? { "cache-control": cc } : {}),
    });
    expect(sw.storable(r(200))).toBe(true);
    expect(sw.storable(r(200, "public, max-age=60"))).toBe(true);
    expect(sw.storable(r(200, "no-store"))).toBe(false); // the clinical routes send this
    expect(sw.storable(r(200, "private, max-age=0"))).toBe(false);
    expect(sw.storable(r(206))).toBe(false);
    expect(sw.storable(r(404))).toBe(false);
    expect(sw.storable(null)).toBe(false);
  });

  it("finds the hashed assets a page needs, so /offline renders styled", () => {
    expect(
      sw.assetUrlsIn(
        '<link rel="stylesheet" href="/assets/styles-x1.css"><script src="/assets/main-y2.js"></script><img src="https://x/y.png">',
      ),
    ).toEqual(["/assets/styles-x1.css", "/assets/main-y2.js"]);
  });
});

describe("web app manifest and head", () => {
  const manifest = JSON.parse(readFileSync(join(root, "public/manifest.webmanifest"), "utf8"));
  it("is installable-shaped with the brand colours, icons and shortcuts", () => {
    expect(manifest).toMatchObject({
      name: "CannaPlug",
      short_name: "CannaPlug",
      start_url: "/?source=pwa",
      display: "standalone",
      theme_color: "#0B3D20",
      background_color: "#F8FAF8",
    });
    const sizes = manifest.icons.map(
      (i: { sizes: string; purpose: string }) => `${i.sizes}:${i.purpose}`,
    );
    expect(sizes).toEqual(
      expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]),
    );
    for (const i of manifest.icons)
      expect(existsSync(join(root, "public", i.src)), i.src).toBe(true);
    expect(manifest.shortcuts.map((s: { url: string }) => s.url.split("?")[0])).toEqual([
      "/shop",
      "/account",
      "/journal",
    ]);
  });
  it("is linked from the root route with theme colour and Apple icon", () => {
    const rootTsx = readFileSync(join(root, "src/routes/__root.tsx"), "utf8");
    expect(rootTsx).toContain('{ rel: "manifest", href: "/manifest.webmanifest" }');
    expect(rootTsx).toContain('{ name: "theme-color", content: "#0B3D20" }');
    expect(rootTsx).toContain("/icons/apple-touch-icon.png");
  });
  it("CSP lets our own worker and manifest load, and nothing else", () => {
    const csp = buildCsp();
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
  });
});

describe("Get the app prompt", () => {
  const SAFARI =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  const CHROME_IOS =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1";
  const ANDROID =
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
  const base = {
    standalone: false,
    hasPromptEvent: false,
    userAgent: ANDROID,
    seenAt: null,
    now: 1e12,
  };

  it("uses the browser prompt where offered, and the steps on iOS Safari only", () => {
    expect(installMode({ ...base, hasPromptEvent: true })).toBe("prompt");
    expect(installMode(base)).toBeNull(); // Android before the browser offers it
    expect(installMode({ ...base, userAgent: SAFARI })).toBe("ios");
    expect(installMode({ ...base, userAgent: CHROME_IOS })).toBeNull();
    expect(isIosSafari(ANDROID)).toBe(false);
  });
  it("never shows when installed, and never twice in a week", () => {
    expect(installMode({ ...base, hasPromptEvent: true, standalone: true })).toBeNull();
    expect(
      installMode({ ...base, hasPromptEvent: true, seenAt: base.now - WEEK_MS + 1000 }),
    ).toBeNull();
    expect(installMode({ ...base, hasPromptEvent: true, seenAt: base.now - WEEK_MS - 1 })).toBe(
      "prompt",
    );
  });
  it("remembers when it was shown, and survives storage that throws", () => {
    const store = new Map<string, string>();
    const s = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    markSeen(s, 1234);
    expect(store.get(INSTALL_SEEN_KEY)).toBe("1234");
    expect(readSeenAt(s)).toBe(1234);
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readSeenAt(broken)).toBeNull();
    expect(() => markSeen(broken)).not.toThrow();
  });
});
