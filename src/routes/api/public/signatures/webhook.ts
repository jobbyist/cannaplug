import { createFileRoute } from "@tanstack/react-router";

/**
 * Completion callback for an asynchronous signature provider. The body is authenticated with an HMAC
 * (EXTERNAL_SIGNATURE_WEBHOOK_SECRET); nothing in it is trusted — it only names a request id, and the
 * server then asks the provider for the real status. It can only complete a document that is already
 * waiting on that exact request after the practitioner's explicit approval. Responses never include detail.
 */
export const Route = createFileRoute("/api/public/signatures/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const [{ verifyWebhookSignature }, docs] = await Promise.all([
          import("@/lib/clinical/signature-providers.server"),
          import("@/lib/clinical/documents-data.server"),
        ]);
        const raw = await request.text();
        if (raw.length > 20_000) return new Response("Payload too large", { status: 413 });
        if (!verifyWebhookSignature(raw, request.headers.get("x-signature"))) {
          return new Response("Unauthorized", { status: 401 });
        }
        let requestId: string | undefined;
        try {
          const body = JSON.parse(raw) as { request_id?: unknown };
          requestId =
            typeof body.request_id === "string" && body.request_id.length <= 200
              ? body.request_id
              : undefined;
        } catch {
          return new Response("Bad request", { status: 400 });
        }
        if (!requestId) return new Response("Bad request", { status: 400 });
        try {
          await docs.completeExternalSigning(requestId);
        } catch (err) {
          console.error("signature webhook failed", err instanceof Error ? err.name : "error");
          return Response.json({ ok: false }, { status: 500 });
        }
        return Response.json({ ok: true });
      },
    },
  },
});
