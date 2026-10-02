// bun scripts/check-compliance-copy.ts [--strict]
// Verifies compliance/copy-register.json against the source. Without --strict it reports (exit 0 unless the register itself
// is broken); with --strict it also FAILS while any claim is not approved — that is the release gate.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export interface Loc {
  file: string;
  snippet: string;
}
export interface Claim {
  id: string;
  claim: string;
  needs: string;
  locations: Loc[];
  status: "pending" | "approved" | "placeholder";
  evidence?:
    { issuer: string; documentId: string; documentDate: string; sha256: string } | undefined;
  approvedBy?: string | undefined;
  approvedOn?: string | undefined;
}

const root = new URL("../", import.meta.url).pathname;
const REGULATED =
  /SAHPRA|Section 21|Registration No|Reg\. No|lab[- ]tested|Licensed Medical|\+27 68 291 2107|63210843975/i;

export function validate(
  claims: Claim[],
  read: (f: string) => string | null,
  today = new Date().toISOString().slice(0, 10),
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const c of claims) {
    if (ids.has(c.id)) problems.push(`${c.id}: duplicate id`);
    ids.add(c.id);
    for (const l of c.locations) {
      const body = read(l.file);
      if (body === null) problems.push(`${c.id}: ${l.file} does not exist`);
      else if (!body.replace(/\s+/g, " ").includes(l.snippet.replace(/\s+/g, " ")))
        problems.push(
          `${c.id}: "${l.snippet}" no longer appears in ${l.file} (wording changed — re-approve)`,
        );
    }
    if (c.status === "approved") {
      const e = c.evidence;
      if (
        !e ||
        !e.issuer ||
        !e.documentId ||
        !/^\d{4}-\d{2}-\d{2}$/.test(e.documentDate) ||
        !/^[0-9a-f]{64}$/.test(e.sha256)
      )
        problems.push(
          `${c.id}: approved without complete documentary evidence (issuer, documentId, documentDate, sha256)`,
        );
      if (
        !c.approvedBy ||
        !c.approvedOn ||
        !/^\d{4}-\d{2}-\d{2}$/.test(c.approvedOn) ||
        c.approvedOn > today
      )
        problems.push(
          `${c.id}: approved without a named client approver and a valid approval date`,
        );
      else if (e && e.documentDate > c.approvedOn)
        problems.push(`${c.id}: evidence is dated after the approval`);
    } else if (c.evidence || c.approvedBy)
      problems.push(`${c.id}: has evidence/approver but status is "${c.status}"`);
  }
  return problems;
}

/** Files that carry regulated wording but are not covered by any register entry. */
export function unregisteredFiles(
  claims: Claim[],
  files: string[],
  read: (f: string) => string | null,
  ignore: string[] = [],
): string[] {
  const covered = new Set([...ignore, ...claims.flatMap((c) => c.locations.map((l) => l.file))]);
  return files.filter((f) => !covered.has(f) && REGULATED.test(read(f) ?? ""));
}

if (import.meta.main) {
  const strict = process.argv.includes("--strict");
  const register = JSON.parse(readFileSync(`${root}compliance/copy-register.json`, "utf8")) as {
    claims: Claim[];
    ignoreFiles?: Record<string, string>;
  };
  const claims = register.claims;
  const read = (f: string) => (existsSync(root + f) ? readFileSync(root + f, "utf8") : null);
  const siteFiles = execFileSync("git", ["ls-files", "src/routes", "src/components", "src/lib"], {
    cwd: root,
  })
    .toString()
    .split("\n")
    .filter((f) => /\.(tsx?)$/.test(f) && !f.includes("/clinical/") && !f.includes("/ui/"));
  const problems = [
    ...validate(claims, read),
    ...unregisteredFiles(claims, siteFiles, read, Object.keys(register.ignoreFiles ?? {})).map(
      (f) => `${f}: contains regulated wording that is not in the register`,
    ),
  ];
  const open = claims.filter((c) => c.status !== "approved");
  for (const c of claims)
    console.log(
      `${c.status === "approved" ? "approved   " : c.status === "placeholder" ? "PLACEHOLDER" : "pending    "} ${c.id}  ${c.claim}`,
    );
  if (problems.length) {
    console.error("\nRegister problems:\n - " + problems.join("\n - "));
    process.exit(1);
  }
  if (strict && open.length) {
    console.error(
      `\nRELEASE BLOCKED: ${open.length} claim(s) lack client approval + documentary evidence.`,
    );
    process.exit(2);
  }
  console.log(
    open.length
      ? `\n${open.length} claim(s) awaiting client approval + evidence (not yet blocking; --strict blocks).`
      : "\nAll claims approved with evidence.",
  );
}
