// Local stand-ins for the Yoco and PayPal sandboxes, for the live browser tests ONLY (never used in production).
// They implement just the endpoints the app calls, with the same shapes/semantics as the real APIs:
//   Yoco   POST /api/checkouts                 -> { id, redirectUrl, amount, currency, merchantId, processingMode }
//          hosted page  GET /yoco/pay/:id      -> "Pay" button; POST completes: sends a SIGNED Standard-Webhooks event
//                                                to the app, then redirects the browser to successUrl
//   PayPal POST /v1/oauth2/token, POST /v2/checkout/orders, POST .../capture, GET .../orders/:id,
//          POST /v1/notifications/verify-webhook-signature (SUCCESS only if the body is our own)
//          hosted page  GET /paypal/approve/:id -> "Approve" button; redirects to return_url?token=:id
//   Control  GET /_state, POST /_config {yocoAmountOverride, paypalCaptureValue, replayWebhook}  for fixture scenarios
// Usage: node scripts/live-stack/mock-providers.mjs   (env: MOCK_PORT=4599, APP_URL=http://127.0.0.1:4173, YOCO_WEBHOOK_SECRET)
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 4599);
const APP = process.env.APP_URL ?? "http://127.0.0.1:4173";
const WH_SECRET =
  process.env.YOCO_WEBHOOK_SECRET ??
  `whsec_${Buffer.from("live-mock-yoco-secret-0123456789").toString("base64")}`;
const MERCHANT = process.env.PAYPAL_MERCHANT_ID ?? "MOCK-MERCHANT";
const BASE = `http://127.0.0.1:${PORT}`;

const yoco = new Map();
const paypal = new Map();
const cfg = { yocoAmountOverride: null, paypalCaptureValue: null, replayWebhook: false };
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

async function yocoWebhook(co) {
  const raw = JSON.stringify({
    id: `evt_${randomUUID().slice(0, 12)}`,
    type: "payment.succeeded",
    createdDate: new Date().toISOString(),
    payload: {
      id: `p_${randomUUID().slice(0, 10)}`,
      amount: cfg.yocoAmountOverride ?? co.amount,
      currency: co.currency,
      mode: "test",
      status: "succeeded",
      type: "payment",
      metadata: { checkoutId: co.id, ...co.metadata },
    },
  });
  const id = `msg_${randomUUID().slice(0, 8)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(WH_SECRET.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  const send1 = () =>
    fetch(`${APP}/api/public/payments/yoco-webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": ts,
        "webhook-signature": `v1,${sig}`,
      },
      body: raw,
    });
  const r = await send1();
  log.push({ kind: "yoco-webhook", status: r.status });
  if (cfg.replayWebhook) log.push({ kind: "yoco-webhook-replay", status: (await send1()).status });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, BASE);
    const p = url.pathname;
    try {
      if (p === "/_state")
        return send(res, 200, { yoco: [...yoco.values()], paypal: [...paypal.values()], cfg, log });
      if (p === "/_config" && req.method === "POST") {
        Object.assign(cfg, JSON.parse((await readBody(req)) || "{}"));
        return send(res, 200, cfg);
      }

      // ---- Yoco API
      if (p === "/api/checkouts" && req.method === "POST") {
        const b = JSON.parse(await readBody(req));
        const id = `ch_${randomUUID().slice(0, 10)}`;
        const co = { id, ...b, status: "created", merchantId: "mock-yoco-merchant" };
        yoco.set(id, co);
        return send(res, 200, {
          id,
          status: "created",
          amount: b.amount,
          currency: b.currency,
          redirectUrl: `${BASE}/yoco/pay/${id}`,
          merchantId: co.merchantId,
          processingMode: "test",
          metadata: b.metadata,
        });
      }
      let m = /^\/yoco\/pay\/(ch_[\w-]+)$/.exec(p);
      if (m && req.method === "GET")
        return send(res, 200, page("Mock Yoco checkout", `/yoco/pay/${m[1]}`, "Pay"), "text/html");
      if (m && req.method === "POST") {
        const co = yoco.get(m[1]);
        if (!co) return send(res, 404, {});
        await yocoWebhook(co);
        res.writeHead(303, { location: co.successUrl });
        return res.end();
      }

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
