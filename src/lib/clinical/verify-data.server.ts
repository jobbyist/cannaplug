import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { BUCKET } from "@/lib/clinical/documents-data.server";
import { isValidVerificationToken, sha256Hex } from "@/lib/clinical/hash";
import {
  evaluateVerification,
  needsPdfCheck,
  toPublicVerification,
  type PublicVerification,
  type VerifyLookup,
} from "@/lib/clinical/verification-logic";

/**
 * Public verification (no sign-in). Rate limited per hashed requester, indistinguishable for unknown and
 * malformed tokens, and it answers with the minimum in `toPublicVerification` — never health information.
 */

const GENERAL_LIMIT = { limit: 30, windowSeconds: 60 };
const FAILURE_LIMIT = { limit: 10, windowSeconds: 900 };

async function requesterHash(ip: string | null): Promise<string> {
  // The salt keeps the stored value from being reversed to an address by brute force of the IPv4 space.
  const salt = process.env["VERIFICATION_IP_SALT"] ?? "cannaplug-verification";
  return (await sha256Hex(`${salt}|${ip ?? "unknown"}`)).slice(0, 32);
}

async function rateCheck(
  bucket: string,
  { limit, windowSeconds }: { limit: number; windowSeconds: number },
): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("document_verify_rate_check", {
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  // Fail closed: if the limiter is unavailable, do not serve verifications.
  return !error && data === true;
}

/** Gives a reserved failure slot back (the token turned out to be a real document). */
async function refund(bucket: string, { windowSeconds }: { windowSeconds: number }): Promise<void> {
  await supabaseAdmin.rpc("document_verify_refund", {
    p_bucket: bucket,
    p_window_seconds: windowSeconds,
  });
}

async function observedPdfHash(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  try {
    const dl = await supabaseAdmin.storage.from(BUCKET).download(path);
    if (dl.error || !dl.data) return null;
    return await sha256Hex(new Uint8Array(await dl.data.arrayBuffer()));
  } catch {
    return null;
  }
}

export async function verifyToken(token: string, ip: string | null): Promise<PublicVerification> {
  const who = await requesterHash(ip);
  const failureBucket = `f:${who}`;
  // Both limits are atomic increments, so parallel requests cannot all slip through before one is counted.
  // The failure slot is RESERVED up front and refunded only if the token proves to be a real document.
  if (!(await rateCheck(`v:${who}`, GENERAL_LIMIT))) return { status: "RATE_LIMITED" };
  if (!(await rateCheck(failureBucket, FAILURE_LIMIT))) return { status: "RATE_LIMITED" };

  if (!isValidVerificationToken(token)) return { status: "NOT_FOUND" };
  const { data, error } = await supabaseAdmin.rpc("document_verify_lookup", { p_token: token });
  if (error) return { status: "NOT_FOUND" };
  const lookup = data as unknown as VerifyLookup;
  if (!lookup.found || !lookup.id) return { status: "NOT_FOUND" };
  await refund(failureBucket, FAILURE_LIMIT);

  const observed = needsPdfCheck(lookup) ? await observedPdfHash(lookup.pdf_path) : null;
  const status = evaluateVerification(lookup, observed);
  await supabaseAdmin.rpc("document_verify_record", {
    p_doc: lookup.id,
    p_token: token,
    p_status: status,
    p_observed_hash: observed,
    p_requester_hash: who,
  });
  return toPublicVerification(lookup, status);
}
