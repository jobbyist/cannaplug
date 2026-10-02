/** SHA-256 helpers on Web Crypto, so they run unchanged in Node, Workers and the browser. */

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** Constant-time comparison of two hex digests. */
export function hashesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const isSha256Hex = (s: unknown): s is string =>
  typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

/** Cryptographically secure verification token: 256 bits, URL-safe base64 (43 characters). */
export function generateVerificationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const isValidVerificationToken = (t: unknown): t is string =>
  typeof t === "string" && /^[A-Za-z0-9_-]{43}$/.test(t);
