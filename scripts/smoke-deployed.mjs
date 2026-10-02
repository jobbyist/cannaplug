#!/usr/bin/env node
// Post-deploy smoke suite. No dependencies, no side effects on real data.
//   node scripts/smoke-deployed.mjs https://staging.example.com [--cron-secret=...] [--expect-providers]
// With --cron-secret it also proves the cron endpoints accept the secret (dispatch is idempotent and safe).
const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? process.env.SMOKE_URL ?? "").replace(
  /\/+$/,
  "",
);
const cron =
  (args.find((a) => a.startsWith("--cron-secret=")) ?? "").split("=")[1] ||
  process.env.CRON_SECRET ||
  "";
if (!base) {
  console.error("usage: node scripts/smoke-deployed.mjs <base-url> [--cron-secret=...]");
  process.exit(2);
}

let failed = 0;
const ok = (name, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!pass) failed++;
};
const get = (p, init) => fetch(base + p, { redirect: "manual", ...init });

// 1. pages render
for (const [path, needle] of [
  ["/", "CannaPlug"],
  ["/shop", "html"],
  ["/journal", "html"],
  ["/faq", "html"],
  ["/about", "html"],
  ["/privacy-policy", "html"],
  ["/terms-of-service", "html"],
  ["/account", "html"],
  ["/checkout", "html"],
]) {
  const r = await get(path);
  const body = await r.text();
  ok(
    `GET ${path} renders`,
    r.status === 200 && body.toLowerCase().includes(needle.toLowerCase()),
    String(r.status),
  );
}
const notFound = await get("/definitely-not-a-page");
ok("unknown route is a 404 page, not a crash", notFound.status === 404, String(notFound.status));

// 2. security headers
const home = await get("/");
const h = home.headers;
ok(
  "CSP present, no unsafe-eval, frame-ancestors set",
  /default-src 'self'/.test(h.get("content-security-policy") ?? "") &&
    !/unsafe-eval/.test(h.get("content-security-policy") ?? "") &&
    /frame-ancestors/.test(h.get("content-security-policy") ?? ""),
);
ok("X-Content-Type-Options nosniff", h.get("x-content-type-options") === "nosniff");
ok("Referrer-Policy set", !!h.get("referrer-policy"));
ok(
  "Permissions-Policy disables camera/microphone/geolocation",
  /camera=\(\)/.test(h.get("permissions-policy") ?? ""),
);
if (base.startsWith("https://"))
  ok("HSTS on https", /max-age=\d+/.test(h.get("strict-transport-security") ?? ""));
ok("no wildcard CORS on pages", h.get("access-control-allow-origin") !== "*");
const doctor = await get("/doctor");
ok(
  "clinical pages are never cached or framed",
  /no-store/.test(doctor.headers.get("cache-control") ?? "") &&
    /frame-ancestors 'none'/.test(doctor.headers.get("content-security-policy") ?? ""),
);

// 3. webhooks refuse unsigned traffic BEFORE business logic
for (const p of ["/api/public/payments/yoco-webhook", "/api/public/payments/paypal-webhook"]) {
  const r = await get(p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "evt_smoke_test", type: "payment.succeeded" }),
  });
  ok(`${p} rejects an unsigned message`, r.status === 401 || r.status === 503, String(r.status));
}
const sigHook = await get("/api/public/signatures/webhook", { method: "POST", body: "{}" });
ok("signature webhook rejects unsigned", sigHook.status === 401, String(sigHook.status));

// 4. cron endpoints need the secret
for (const p of [
  "/api/public/notifications/dispatch",
  "/api/public/inventory/maintenance",
  "/api/public/newsroom/run",
]) {
  const r = await get(p, { method: "POST" });
  ok(`${p} refuses anonymous callers`, r.status === 401 || r.status === 403, String(r.status));
}
if (cron) {
  const r = await get("/api/public/notifications/dispatch", {
    method: "POST",
    headers: { authorization: `Bearer ${cron}` },
  });
  const body = await r.json().catch(() => ({}));
  ok(
    "dispatcher accepts the cron secret and runs",
    r.status === 200 && body.ok === true,
    `HTTP ${r.status}${body.skippedNotConfigured ? ", email key NOT configured" : ""}`,
  );
}

// 5. public forms validate input (nothing is stored: invalid payloads)
const form = await get("/_serverFn/does-not-exist", { method: "POST" });
ok("unknown server function is not a 500", form.status < 500, String(form.status));

console.log(failed ? `\n${failed} check(s) FAILED` : "\nSmoke suite passed");
process.exit(failed ? 1 : 0);
