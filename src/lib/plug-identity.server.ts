/**
 * Who is calling Ask The Plug. It is open to everyone, so there is no auth middleware: a valid bearer token makes the
 * caller a member (their id comes from the verified token, never from the browser's body); anything else is a visitor,
 * known only by a salted hash of the IP address (hashIp). An invalid or expired token is treated as a visitor.
 */
import { getRequest } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import { hashIp } from "@/lib/payments/service.server";

export type PlugCaller = { userId: string | null; ipHash: string | null };

export async function plugCaller(): Promise<PlugCaller> {
  const request = getRequest();
  const ipHash = hashIp(request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null);
  const header = request?.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!token || token.split(".").length !== 3 || !url || !key) return { userId: null, ipHash };
  try {
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.getClaims(token);
    const sub = error ? null : data?.claims?.sub;
    return { userId: typeof sub === "string" && sub ? sub : null, ipHash };
  } catch {
    return { userId: null, ipHash };
  }
}
