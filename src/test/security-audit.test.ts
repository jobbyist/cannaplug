import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Milestone 6 source audit, enforced on every CI run so it cannot regress:
 * server-function authorization & validation, client/server import hygiene, CORS, raw SQL, committed secrets.
 */
const root = join(__dirname, "../..");
const read = (f: string) => readFileSync(f, "utf8");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (
      n === "node_modules" ||
      n === ".git" ||
      n === "dist" ||
      n === ".nitro" ||
      n === "test-results"
    )
      continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const src = walk(join(root, "src")).filter(
  (f) => /\.(ts|tsx)$/.test(f) && !f.includes("/src/test/") && !f.endsWith("routeTree.gen.ts"),
);

// -------------------------------------------------------------------------------------------------
// Server functions
// -------------------------------------------------------------------------------------------------
interface Fn {
  file: string;
  name: string;
  method: string;
  text: string;
}
function serverFns(): Fn[] {
  const out: Fn[] = [];
  for (const f of src.filter((x) => x.endsWith(".ts") && x.includes("/src/lib/"))) {
    const parts = read(f)
      .split(/\n(?=export const \w+ = createServerFn)/)
      .slice(1);
    for (const p of parts) {
      const text = p.split(/\nexport /)[0]!;
      out.push({
        file: relative(root, f),
        name: /export const (\w+)/.exec(p)![1]!,
        method: /method: "(\w+)"/.exec(text)?.[1] ?? "GET",
        text,
      });
    }
  }
  return out;
}

/** Deliberately unauthenticated server functions. Everything else MUST carry auth middleware. */
const PUBLIC_FNS: Record<string, string> = {
  listStoreProductsFn: "public catalogue",
  listDeliveryOptionsFn: "public checkout info",
  getOnlineMethodsFn: "which payment buttons to show (no data)",
  askCannaPlug: "public chatbot; layered rate limits (IP, session, shared Gemini budget)",
  submitContactFn: "public contact form; honeypot + per-IP rate limit",
  subscribeNewsletterFn: "public newsletter; honeypot + per-IP rate limit",
  unsubscribeNewsletterFn: "token in the email link",
  verifyDocumentFn: "public QR verification page; reveals only validity, never content",
};

describe("server functions", () => {
  const fns = serverFns();
  it("finds the server functions (guards against the scanner silently matching nothing)", () => {
    expect(fns.length).toBeGreaterThan(90);
  });
  it("every server function is authenticated unless it is on the reviewed public list", () => {
    const open = fns
      .filter((f) => !/\.middleware\(/.test(f.text) && !(f.name in PUBLIC_FNS))
      .map((f) => `${f.file}: ${f.name}`);
    expect(open).toEqual([]);
  });
  it("the public list only contains functions that really exist (no stale exemptions)", () => {
    const names = new Set(fns.map((f) => f.name));
    expect(Object.keys(PUBLIC_FNS).filter((n) => !names.has(n))).toEqual([]);
  });
  it("every POST validates its input with a schema", () => {
    const bad = fns
      .filter((f) => f.method === "POST" && !/\.(validator|inputValidator)\(/.test(f.text))
      .map((f) => f.name);
    expect(bad).toEqual([]);
  });
  it("no server function takes an acting user id, a role, a status or a price from the browser", () => {
    const risky = /\b(actorId|actor_id|userId|user_id|role|total_rand|amount_paid)\s*:\s*z\./;
    const offenders = fns
      .filter(
        (f) =>
          risky.test(f.text) &&
          !/targetUserId|adminSearchMembers|saveAdminProduct/.test(f.text) &&
          !["viewVerificationDocumentFn"].includes(f.name),
      )
      .map((f) => f.name);
    // `userId` appears legitimately as the TARGET member of staff actions; those are re-authorised by role in the data layer (checked below)
    expect(
      offenders.filter(
        (n) =>
          !/^(adminAssignPatientFn|adminSaveDoctorFn|adminSetDoctorStatusFn|reviewVerificationFn|viewVerificationDocumentFn|createDocumentFn|createMyRequestFn|adminCreateRequestFn)$/.test(
            n,
          ),
      ),
    ).toEqual([]);
  });
});

/**
 * Staff data layers: every exported async function either performs a role check (assertRole / assertManager / the DB's
 * p_actor staff assertions) or is on a reviewed list of member-scoped functions that only ever act on the caller's own rows.
 */
const ROLE_CHECK =
  /assertRole\(|assertManager\(|assertStaff|assertAdmin|assertBudtender|p_actor|_assert_staff|requireStaff/;
const DATA_LAYERS: Record<string, string[]> = {
  "src/lib/admin-data.server.ts": [
    "assertRole",
    "listStoreProducts",
    "listMemberOrders",
    "confirmOrderPayment",
  ],
  "src/lib/pos-data.server.ts": ["friendlyPosError"],
  "src/lib/payments/payments-data.server.ts": [
    "availableOnlineMethods",
    "startMemberPayment",
    "confirmMemberPayPalReturn",
    "memberPaymentStatus",
  ],
  "src/lib/verification-data.server.ts": [
    "getMyVerification",
    "createIdUpload",
    "submitVerification",
    "sweepOrphanedIdFolders",
    "sweepOrphanedIdDocuments",
  ],
};
describe("authorization in the data layers", () => {
  for (const [file, exempt] of Object.entries(DATA_LAYERS)) {
    it(`${file}: every exported function checks the caller's role or is reviewed member-scoped`, () => {
      const parts = read(join(root, file))
        .split(/\n(?=export (?:async )?function )/)
        .slice(1);
      const missing = parts
        .map((p) => ({
          name: /export (?:async )?function (\w+)/.exec(p)![1]!,
          body: p.split(/\nexport /)[0]!,
        }))
        .filter((f) => !ROLE_CHECK.test(f.body) && !exempt.includes(f.name))
        .map((f) => f.name);
      expect(missing).toEqual([]);
    });
  }
  it("money-moving staff actions need MANAGER (EFT, FX, product pricing) — budtenders cannot", () => {
    const pay = read(join(root, "src/lib/payments/payments-data.server.ts"));
    for (const fn of [
      "submitEft",
      "approveEft",
      "rejectEft",
      "getPaymentsOverview",
      "updateFxSettings",
      "setManualFxRate",
    ]) {
      const body = pay
        .split(new RegExp(`export async function ${fn}\\b`))[1]!
        .split(/\nexport /)[0]!;
      expect(body, fn).toMatch(/assertRole\(userId, "manager"\)/);
    }
    const admin = read(join(root, "src/lib/admin-data.server.ts"));
    for (const fn of ["saveAdminProduct", "deactivateAdminProduct"])
      expect(
        admin.split(new RegExp(`export async function ${fn}\\b`))[1]!.split(/\nexport /)[0]!,
        fn,
      ).toMatch(/assertRole\(userId, "manager"\)/);
    expect(
      admin.split(/export async function confirmOrderPayment\b/)[1]!.split(/\nexport /)[0]!,
    ).toMatch(/submitEft/); // delegates to the manager-only workflow
  });
});

// -------------------------------------------------------------------------------------------------
// Client/server boundary, CORS, SQL, secrets
// -------------------------------------------------------------------------------------------------
describe("client/server boundary", () => {
  it("browser code only ever imports server modules as TYPES (they are erased from the bundle)", () => {
    const browser = src.filter(
      (f) => /\/src\/(components|hooks|routes)\//.test(f) && !f.includes("/routes/api/"),
    );
    const offenders: string[] = [];
    for (const f of browser)
      for (const line of read(f).split("\n"))
        if (
          /^\s*import\s+(?!type\b)[^;]*from\s+["'][^"']*\.server["']/.test(line) ||
          /^\s*import\s+["'][^"']*\.server["']/.test(line)
        )
          offenders.push(`${relative(root, f)}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });
  it("no server-only secret is read from import.meta.env or exposed through a VITE_ variable", () => {
    const offenders = src.filter(
      (f) =>
        /VITE_[A-Z_]*(SERVICE_ROLE|SECRET|PRIVATE|API_KEY|WEBHOOK)/.test(read(f)) ||
        /import\.meta\.env\.[A-Z_]*(SERVICE_ROLE|SECRET|API_KEY)/.test(read(f)),
    );
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });
  it("only the server client touches the service-role key", () => {
    const offenders = src.filter(
      (f) =>
        /SERVICE_ROLE_KEY/.test(read(f)) &&
        !/\/(client\.server|payments\/service\.server|ai\/chat\.server)\.ts$|\.server\.ts$/.test(f),
    );
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });
});

describe("CORS and raw SQL", () => {
  const fnFiles = walk(join(root, "supabase/functions")).filter((f) => f.endsWith(".ts"));
  it("no edge function or route allows every origin", () => {
    const all = [...fnFiles, ...src];
    const offenders = all
      .filter((f) => /Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*["']/.test(read(f)))
      .map((f) => relative(root, f));
    expect(offenders).toEqual([]);
  });
  it("no application code builds SQL from strings", () => {
    const offenders = src
      .filter(
        (f) =>
          /\.unsafe\(|sql\.raw\(|\$queryRaw|\.query\(\s*`/.test(read(f)) ||
          /execute_sql|exec_sql/.test(read(f)),
      )
      .map((f) => relative(root, f));
    expect(offenders).toEqual([]);
  });
});

describe("committed secrets", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: root })
    .toString()
    .split("\n")
    .filter(Boolean);
  const text = tracked.filter(
    (f) =>
      /\.(ts|tsx|js|mjs|json|sql|md|sh|yml|yaml|toml|env\.example|html|css)$/.test(f) &&
      !/bun\.lock|package-lock|\.snap$/.test(f) &&
      !f.startsWith("e2e/") &&
      !f.startsWith("src/test/") &&
      !f.startsWith("scripts/live-stack/"),
  );
  const PATTERNS: [string, RegExp][] = [
    ["Stripe/Yoco live key", /\bsk_live_[A-Za-z0-9]{8,}/],
    ["Yoco/Stripe test key", /\bsk_test_[A-Za-z0-9]{16,}/],
    ["webhook signing secret", /\bwhsec_[A-Za-z0-9+/=]{20,}/],
    ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}/],
    ["Resend key", /\bre_[A-Za-z0-9]{20,}/],
    ["Firecrawl key", /\bfc-[a-f0-9]{24,}/],
    ["JWT", /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
    ["private key block", /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/],
    ["Supabase service key literal", /service_role["']?\s*[:=]\s*["']eyJ/],
  ];
  it("no tracked file contains a credential-shaped value", () => {
    const hits: string[] = [];
    for (const f of text) {
      const body = read(join(root, f));
      for (const [label, re] of PATTERNS) if (re.test(body)) hits.push(`${f}: ${label}`);
    }
    expect(hits).toEqual([]);
  });
  it("no .env file is tracked, and .env.example holds names only", () => {
    expect(
      tracked.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith(".env.example")),
    ).toEqual([]);
    const ex = read(join(root, ".env.example"));
    for (const line of ex.split("\n").filter((l) => /^[A-Z_]+=/.test(l)))
      expect(line.split("=")[1]!.trim(), line).toBe("");
  });
});
