// Prints HS256 JWTs for the local stack (anon + service_role) as shell exports.
import { createHmac } from "node:crypto";
export const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export const sign = (payload) => {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64(payload);
  const s = createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
};
const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 5;
export const ANON = sign({ role: "anon", iss: "supabase-local", exp });
export const SERVICE = sign({ role: "service_role", iss: "supabase-local", exp });
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(
    `export JWT_SECRET=${JWT_SECRET}\nexport ANON_KEY=${ANON}\nexport SERVICE_ROLE_KEY=${SERVICE}`,
  );
}
