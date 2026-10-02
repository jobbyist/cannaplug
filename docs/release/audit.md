# Milestone 6 audit report

Scope: dependencies, secrets, client/server boundary, CORS, SQL, input validation, error handling, authorization, database privileges.
Method: static checks that now run in CI (`src/test/security-audit.test.ts`, `src/test/db/security-audit.test.ts`), the hosted project's security
advisors, and manual review. Evidence is in the test files; this document records the findings and what was done.

## Findings and resolutions

| #   | Finding                                                                                                                                                                                      | Severity         | Resolution                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `cleanup_old_rate_limits()` (legacy, on the hosted DB only) was executable by **anonymous** visitors and deletes chat-rate-limit rows                                                        | Medium           | Revoked (`20261004006000_legacy_function_exposure`); applied to hosted; verified                                                                                 |
| 2   | Three legacy trigger/event-trigger functions were executable by `anon`/`authenticated`                                                                                                       | Low              | Same migration                                                                                                                                                   |
| 3   | Early tables kept Supabase's default ALL grants for `anon`/`authenticated` (RLS blocked rows, but TRUNCATE/TRIGGER/REFERENCES bypass RLS); service-only tables were visible to browser roles | Medium           | `20261004003000_least_privilege_baseline`; DB test asserts anon can only `SELECT` `articles`, `delivery_options`, `products`                                     |
| 4   | Unpaid order could be confirmed by a plain status change (staff or script) — a payment bypass                                                                                                | High             | Closed in Milestone 5 (`payment_confirmation_required`); regression tests + live test                                                                            |
| 5   | EFT confirmation was available to budtenders and had no dual control                                                                                                                         | Medium           | Manager-only workflow, dual control ≥ R10,000, audited (M5)                                                                                                      |
| 6   | `audit_log` could be edited/deleted by a privileged connection                                                                                                                               | Medium           | Append-only triggers (update/delete/truncate)                                                                                                                    |
| 7   | Role changes, till sales, order transitions and ID decisions relied on application code to log                                                                                               | Medium           | Database triggers (`20261004004000_audit_hardening`) + coverage tests                                                                                            |
| 8   | `paypal-subscription` edge function and the old chat edge function answered CORS with `*`                                                                                                    | Low              | PayPal function now allow-lists origins; the legacy chat function was removed (one chat path: server function) — **delete the hosted `cannaplug-chat` function** |
| 9   | Chatbot rate limit was per client-supplied session id (a new UUID bypassed it) and unbounded globally                                                                                        | Medium           | IP-hash + session + shared per-minute/per-day budget in the database, below the Gemini free tier                                                                 |
| 10  | No Content-Security-Policy / HSTS / Permissions-Policy on ordinary pages                                                                                                                     | Medium           | CSP compatible with TanStack Start SSR and Supabase; verified in the browser with zero violations on member + staff pages                                        |
| 11  | No CI                                                                                                                                                                                        | Medium           | `.github/workflows/ci.yml`                                                                                                                                       |
| 12  | `on_auth_user_created_assign_admin` grants the admin role to any sign-up whose email is in `admin_emails` (1 row; that account already exists)                                               | Info/operational | Dormant while that account exists. **Recommended:** delete the row and the trigger once the owner confirms (decision left to you; not changed automatically)     |
| 13  | Supabase Auth "leaked password protection" is off                                                                                                                                            | Low              | Dashboard setting: Authentication → Passwords → enable **[needs you]**                                                                                           |
| 14  | 4 advisories "RLS enabled, no policy" (13 tables)                                                                                                                                            | Info             | Intentional: those tables are service-role only                                                                                                                  |
| 15  | `_current_doctor_id`, `current_user_role`, `has_*`, `is_staff` are SECURITY DEFINER and callable by signed-in users                                                                          | Info             | Required by RLS policies; they only answer about the caller. Locked in by `BROWSER_CALLABLE` in the DB audit test                                                |

## Checks that now run on every CI build

- Every server function is authenticated unless on a reviewed public list; every POST validates input; no server function takes an actor, role or price from the browser.
- Every exported staff data-layer function checks the caller's role; money-moving actions require `manager`.
- Browser code imports `*.server` modules only as types; no `VITE_`-exposed secrets; service-role key only in server modules.
- No `Access-Control-Allow-Origin: *`; no string-built SQL; no credential-shaped strings in tracked files.
- DB: only five RLS helper functions executable by browsers; RLS on every table; `search_path` pinned on every SECURITY DEFINER function; anon read surface = 3 catalogue tables.

## Dependencies

`bun audit`: the **runtime/production** surface is clean after the overrides added in this milestone (`nanoid`, `js-yaml`, `esbuild`).
The remaining advisories are all **brace-expansion DoS in the ESLint/TypeScript-ESLint dev toolchain** (build machine only, never deployed, not reachable
from user input). CI gates on `critical`; revisit when the lint toolchain publishes a fixed minimatch.

## Error handling

Server functions surface friendly, code-mapped errors (`friendlyMemberError`, `PaymentError`, quota messages); webhook responses never explain a refusal;
provider/database failures during webhooks answer 5xx so providers retry (replay is safe by design); no stack traces or SQL text reach the browser.
Known inconsistency (non-blocking): admin/staff panels show the raw server message rather than a mapped one.
