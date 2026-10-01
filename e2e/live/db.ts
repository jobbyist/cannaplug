import { execFileSync } from "node:child_process";

export const API = process.env["SUPABASE_URL"] ?? "http://127.0.0.1:54321";
export const ANON = process.env["ANON_KEY"] ?? "";
export const SERVICE = process.env["SERVICE_ROLE_KEY"] ?? "";
export const PASSWORD = "Live-test-pass-1!";

/** Runs SQL as the database superuser (stands in for server-side/staff operations). */
export function sql(query: string): string {
  return execFileSync(
    "psql",
    [
      "-X",
      "-q",
      "-At",
      "-h",
      "127.0.0.1",
      "-p",
      process.env["LIVE_PGPORT"] ?? "54330",
      "-U",
      "postgres",
      "-d",
      "live",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: query },
  )
    .toString()
    .trim();
}

export const RUN_FILE = new URL("./.run.json", import.meta.url);
