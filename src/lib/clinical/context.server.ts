import { getRequest } from "@/lib/clinical/request.server";

/** Where verification links point. Set PUBLIC_APP_URL in production; the request origin is a fallback. */
export function appBaseUrl(): string {
  const configured = process.env["PUBLIC_APP_URL"]?.replace(/\/+$/, "");
  if (configured) return configured;
  const req = getRequest();
  return req ? new URL(req.url).origin : "http://localhost:3000";
}

export const verificationUrl = (token: string) => `${appBaseUrl()}/verify/${token}`;

export type RequestContext = { ip: string | null; userAgent: string | null };

/** Client address and agent for the audit trail (best effort; both are optional and length-capped by the database). */
export function requestContext(): RequestContext {
  const req = getRequest();
  if (!req) return { ip: null, userAgent: null };
  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;
  return {
    ip: ip ? ip.slice(0, 64) : null,
    userAgent: req.headers.get("user-agent")?.slice(0, 256) ?? null,
  };
}
