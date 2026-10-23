// Local stand-ins for the PayFast and PayPal sandboxes, for the live browser tests ONLY (never used in production).
// They implement just the endpoints the app calls, with the same shapes/semantics as the real APIs:
//   PayFast GET  /eng/process?<signed fields>   -> "Pay" button (the app navigates here because the mock is http)
//           POST /payfast/pay/:m_payment_id     -> sends a SIGNED ITN to notify_url, then redirects to return_url
//           POST /eng/query/validate             -> "VALID" (PayFast's server-side confirmation, check 4)
//   PayPal POST /v1/oauth2/token, POST /v2/checkout/orders, POST .../capture, GET .../orders/:id,
//          POST /v1/notifications/verify-webhook-signature (SUCCESS only if the body is our own)
//          hosted page  GET /paypal/approve/:id -> "Approve" button; redirects to return_url?token=:id
//   Control  GET /_state, POST /_config {payfastAmountOverride, paypalCaptureValue, replayWebhook}  for fixture scenarios
// Usage: node scripts/live-stack/mock-providers.mjs   (env: MOCK_PORT=4599, PAYFAST_MERCHANT_ID, PAYFAST_PASSPHRASE)
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 4599);
const PF_MERCHANT = process.env.PAYFAST_MERCHANT_ID ?? "10000100";
const PF_PASSPHRASE = process.env.PAYFAST_PASSPHRASE ?? "";
const MERCHANT = process.env.PAYPAL_MERCHANT_ID ?? "MOCK-MERCHANT";
const BASE = `http://127.0.0.1:${PORT}`;

const payfast = new Map();
const paypal = new Map();
const cfg = { payfastAmountOverride: null, paypalCaptureValue: null, replayWebhook: false };
const log = [];

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });
const page = (title, action, label) =>
  `<!doctype html><html><body style="font-family:sans-serif;padding:40px"><h1>${title}</h1><form method="POST" action="${action}"><button id="go" type="submit">${label}</button></form></body></html>`;

// PHP urlencode, as PayFast signs.
const pfEncode = (v) =>
  encodeURIComponent(v)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
const pfParams = (pairs) => pairs.map(([k, v]) => `${k}=${pfEncode(v)}`).join("&");

async function payfastItn(co) {
  const gross = cfg.payfastAmountOverride ?? co.amount;
  const pairs = [
    ["m_payment_id", co.m_payment_id],
    ["pf_payment_id", String(Math.floor(1e6 + Math.random() * 8e6))],
    ["payment_status", "COMPLETE"],
    ["item_name", co.item_name ?? ""],
    ["item_description", ""],
    ["amount_gross", gross],
    ["amount_fee", "-2.30"],
    ["amount_net", (Number(gross) - 2.3).toFixed(2)],
    ["custom_str1", co.custom_str1 ?? ""],
    ["merchant_id", PF_MERCHANT],
  ];
  const base = pfParams(pairs);
  const sig = createHash("md5")
    .update(PF_PASSPHRASE ? `${base}&passphrase=${pfEncode(PF_PASSPHRASE)}` : base)
    .digest("hex");
  const send1 = () =>
    fetch(co.notify_url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `${base}&signature=${sig}`,
    });
  const r = await send1();
  log.push({ kind: "payfast-itn", status: r.status });
  if (cfg.replayWebhook) log.push({ kind: "payfast-itn-replay", status: (await send1()).status });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, BASE);
    const p = url.pathname;
    try {
      if (p === "/_state")
        return send(res, 200, {
          payfast: [...payfast.values()],
          paypal: [...paypal.values()],
          cfg,
          log,
        });
      if (p === "/_config" && req.method === "POST") {
        Object.assign(cfg, JSON.parse((await readBody(req)) || "{}"));
        return send(res, 200, cfg);
      }

      // ---- PayFast
      if (p === "/eng/process") {
        const fields = Object.fromEntries(
          req.method === "POST"
            ? new URLSearchParams(await readBody(req)).entries()
            : url.searchParams.entries(),
        );
        if (!fields.m_payment_id || !fields.signature)
          return send(res, 400, "bad request", "text/plain");
        payfast.set(fields.m_payment_id, fields);
        return send(
          res,
          200,
          page("Mock PayFast checkout", `/payfast/pay/${fields.m_payment_id}`, "Pay"),
          "text/html",
        );
      }
      let m = /^\/payfast\/pay\/([\w-]+)$/.exec(p);
      if (m && req.method === "POST") {
        const co = payfast.get(m[1]);
        if (!co) return send(res, 404, {});
        await payfastItn(co);
        res.writeHead(303, { location: co.return_url });
        return res.end();
      }
      if (p === "/eng/query/validate" && req.method === "POST")
        return send(res, 200, "VALID", "text/plain");

      // ---- PayPal API
      if (p === "/v1/oauth2/token")
        return send(res, 200, { access_token: "mock-token", expires_in: 3000 });
      if (p === "/v2/checkout/orders" && req.method === "POST") {
        const b = JSON.parse(await readBody(req));
        const id = `PP${randomUUID().replace(/-/g, "").slice(0, 14).toUpperCase()}`;
        paypal.set(id, { id, body: b, status: "CREATED", approved: false });
        return send(res, 201, {
          id,
          status: "CREATED",
          links: [{ rel: "payer-action", href: `${BASE}/paypal/approve/${id}` }],
        });
      }
      m = /^\/paypal\/approve\/(PP[\w-]+)$/.exec(p);
      if (m && req.method === "GET")
        return send(
          res,
          200,
          page("Mock PayPal", `/paypal/approve/${m[1]}`, "Approve"),
          "text/html",
        );
      if (m && req.method === "POST") {
        const o = paypal.get(m[1]);
        if (!o) return send(res, 404, {});
        o.approved = true;
        const ret = new URL(o.body.payment_source.paypal.experience_context.return_url);
        ret.searchParams.set("token", o.id);
        res.writeHead(303, { location: ret.toString() });
        return res.end();
      }
      m = /^\/v2\/checkout\/orders\/(PP[\w-]+)(\/capture)?$/.exec(p);
      if (m) {
        const o = paypal.get(m[1]);
        if (!o) return send(res, 404, {});
        if (m[2]) {
          if (!o.approved && o.status !== "COMPLETED")
            return send(res, 422, {
              name: "UNPROCESSABLE_ENTITY",
              details: [{ issue: "ORDER_NOT_APPROVED" }],
            });
          o.status = "COMPLETED";
        }
        const pu = o.body.purchase_units[0];
        return send(res, m[2] ? 201 : 200, {
          id: o.id,
          status: o.status,
          purchase_units: [
            {
              custom_id: pu.custom_id,
              payee: { merchant_id: MERCHANT },
              payments:
                o.status === "COMPLETED"
                  ? {
                      captures: [
                        {
                          id: `CAP-${o.id}`,
                          status: "COMPLETED",
                          amount: {
                            currency_code: pu.amount.currency_code,
                            value: cfg.paypalCaptureValue ?? pu.amount.value,
                          },
                        },
                      ],
                    }
                  : {},
            },
          ],
        });
      }
      if (p === "/v1/notifications/verify-webhook-signature")
        return send(res, 200, { verification_status: "SUCCESS" });
      send(res, 404, { error: "mock: not found", path: p });
    } catch (err) {
      send(res, 500, { error: String(err) });
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`mock providers on ${BASE}`));
