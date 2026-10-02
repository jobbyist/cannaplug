# CannaPlug Development Reference

**Repository:** jobbyist/cannaplug  
**Live:** https://cannaplug.lovable.app  
**Stack:** TanStack Start (React 19) + Vite 8 + Tailwind CSS 4 + Supabase + Framer Motion + shadcn/ui  
**Last audit:** 2026-09-25

---

## Architecture Overview

| Layer | Technology |
|-------|------------|
| Framework | TanStack Start (SSR-capable) with file-based routing |
| UI | React 19, Tailwind 4 (oklch design tokens), custom CSS in `src/styles.css` + `src/journal.css` |
| Data | Supabase (`articles`, `products`, auth, edge functions) |
| State | TanStack Query, React context (`CartProvider`, `AuthProvider`) |
| Chat | `ChatWidget` → Supabase edge function `cannaplug-chat` / AI gateway |
| Theme | Class-based dark mode (`html.dark`), persisted in `localStorage` key `cannaplug.theme` |

### Key routes

- `/` — Homepage (`CannaPlugHome`)
- `/shop`, `/checkout`, `/account`, `/admin`
- `/journal/`, `/journal/$slug` — The CannaPlug Journal (newsroom)
- `/api/public/newsroom/run` — Newsroom pipeline trigger
- Legal: `/privacy-policy`, `/terms-of-service`, `/refund-policy`, `/delivery-policy`, `/faq`
- `/about`

### Signature UX

1. Instagram-style story navigation (top)
2. Floating bottom nav (pill with elevated leaf CTA)
3. Theme toggle (header)
4. Chat notch + panel (CannaPlug AI)

---

## CRITICAL: Manual git restore for `src/styles.css`

During the 2026-09-25 audit, `src/styles.css` was accidentally overwritten with a partial bootstrap. **Homepage and most site chrome will look broken until this restore is applied.**

`src/journal.css` (Journal/newsroom styles) and this document are already on `main` and should be kept.

### Last known-good commit for styles

```
53a63af69dbc2692f2fc13724b59a3aa320353cf
```

### Option A — Restore file only (recommended)

From a clean clone or your existing working tree on `main`:

```sh
# 1. Ensure you are on main and up to date
git fetch origin
git checkout main
git pull origin main

# 2. Restore styles.css from the last good commit
git show 53a63af69dbc2692f2fc13724b59a3aa320353cf:src/styles.css > src/styles.css

# 3. Append the Journal stylesheet import (journal.css is already on main)
printf '\n@import "./journal.css";\n' >> src/styles.css

# 4. Verify the import is present and file size is ~34KB+
wc -c src/styles.css
tail -n 5 src/styles.css
# Expected last line: @import "./journal.css";

# 5. Commit and push
git add src/styles.css
git status
git commit -m "fix(styles): restore full styles.css from 53a63af and import journal.css"
git push origin main
```

### Option B — Interactive checkout (same result)

```sh
git fetch origin
git checkout main
git pull origin main

# Restore only this path from the good commit
git checkout 53a63af69dbc2692f2fc13724b59a3aa320353cf -- src/styles.css

# Append Journal import
printf '\n@import "./journal.css";\n' >> src/styles.css

git add src/styles.css
git commit -m "fix(styles): restore full styles.css from 53a63af and import journal.css"
git push origin main
```

### Option C — If you already have local uncommitted work

```sh
# Stash other changes first
git stash push -m "wip before styles restore" --keep-index
# or stash everything:
# git stash push -u -m "wip before styles restore"

git show 53a63af69dbc2692f2fc13724b59a3aa320353cf:src/styles.css > src/styles.css
printf '\n@import "./journal.css";\n' >> src/styles.css

git add src/styles.css
git commit -m "fix(styles): restore full styles.css from 53a63af and import journal.css"
git push origin main

# Re-apply stashed work if needed
git stash pop
```

### Verify after restore

```sh
bun install   # or npm i
bun run build
bun run preview
# Open / and /journal — filters should be separate pills; homepage chrome restored
```

**Do not** delete `src/journal.css` or rewrite Journal routes; only restore `styles.css` and keep the `@import "./journal.css";` line at the end.

---

## Changes & Fixes Logged (2026-09-25)

### 1. Broken Journal / Newsroom page build (FIXED — CSS)

**Symptom:** Journal index and article pages rendered content but layout was broken. Category filter links appeared concatenated (`AllCultureIndustryLaw & PolicyWellnessLifestyle`) with no spacing, cards lacked structure, lead story had no grid.

**Root cause:** `src/styles.css` contained **zero** rules for any `.journal-*` classes used by:

- `src/routes/journal.index.tsx`
- `src/routes/journal.$slug.tsx`

Components were correct; CSS was never shipped after the Journal feature was added in Lovable.

**Fix:** Added complete Journal stylesheet in `src/journal.css` covering:

- Masthead, category filters (flex + gap + pill active states)
- Lead story grid, card grid, cover fallbacks
- Article detail (standfirst, hero, body typography, sources, related)
- Product callouts inside articles
- Responsive breakpoints (900px / 600px) including horizontal-scroll filters on mobile
- Dark-mode accent overrides

**Follow-up:** Wire via `@import "./journal.css";` at the end of restored `src/styles.css` (see restore section above).

### 2. Accidental `styles.css` overwrite (MUST FIX MANUALLY)

Tooling overwrote `src/styles.css` with a partial bootstrap. Use the **Manual git restore** section above. Until restored, homepage custom CSS is missing.

### 3. Production / smoke verification notes

| Area | Status | Notes |
|------|--------|-------|
| Homepage | OK (pre-overwrite) | Hero, stories, categories, products, Plug Back, experience, news teaser, events, contact, floating nav |
| Theme toggle | OK | Persists `cannaplug.theme`; root script applies class before paint |
| Chat widget | OK | Notch visible; panel open/close, session storage, AI call path present |
| Journal index | Fixed (CSS) | Filters, lead, grid in `journal.css` |
| Journal article | Fixed (CSS) | Typography, product callouts, related, sources |
| Mobile / tablet | Partial | Homepage & floating nav responsive; Journal filters scroll on small screens |
| Assets | OK | Favicons, social-preview, store video under `public/` |

### 4. Remaining recommendations

1. **CI / build** — After styles restore, run `bun run build` (or `npm run build`); watch Tailwind `@source` and large video assets.
2. **Journal empty state** — Ensure seed/newsroom runner populates Supabase `articles`.
3. **Newsroom API** — Rate-limit and auth-gate `/api/public/newsroom/run`.
4. **Accessibility** — Focus rings on filter chips and chat panel; reduce-motion already respected for cart badge.
5. **Image performance** — Lazy covers + fixed aspect ratios to avoid CLS.
6. **Dark mode polish** — Journal lead contrast and chat panel under `.dark`.
7. **Type safety** — Prefer Zod on journal article rows if schema drifts.

---

## How to verify locally

```sh
git clone https://github.com/jobbyist/cannaplug.git
cd cannaplug
# Apply styles restore (see CRITICAL section) if not already done
bun install   # or npm i
bun run dev
# Visit / and /journal
bun run build && bun run preview
```

---

## File touch list (this run)

| File | Action |
|------|--------|
| `src/journal.css` | **Created** — full Journal/newsroom stylesheet |
| `src/styles.css` | **Corrupted** — must restore from `53a63af…` + `@import "./journal.css";` |
| `CANNAPLUG.md` | **Created/updated** — architecture, fixes, restore instructions |

---

## Commit message after restore

```
fix(styles): restore full styles.css from 53a63af and import journal.css

Homepage chrome was lost after an accidental overwrite. Restores the
complete design-system CSS and wires src/journal.css for Journal pages.
```


---

## Production Readiness Audit - 2026-09-28

**Audit baseline:** `main` at `0db21df36faa4f272df3f38e879d97302b2a0318`  
**Audit scope:** application architecture, routes, Supabase integration, database migrations/RLS, authentication/RBAC, checkout/payments, POS/inventory readiness, member portal, AI/chat, CI/CD, security and production operations.  
**Audit performed by:** ChatGPT, using the connected GitHub repository as the source of truth for the code audit.  
**Documentation-only change:** No application code or database schema was changed as part of this audit.  

### Executive audit findings

The prototype has a solid presentation and routing foundation but is not yet a production dispensary operations platform. The primary production gaps are live-data integration, transactional inventory, server-enforced RBAC, real checkout/payment processing, POS/till accounting, loyalty, fulfilment, compliance-grade auditability, and automated CI/testing.

### P0 blockers identified

1. `src/styles.css` on `main` is a 1,856-byte temporary bootstrap while the documented last-known-good version at commit `53a63af69dbc2692f2fc13724b59a3aa320353cf` is approximately 34KB. Restore the known-good stylesheet before further UI work.
2. `/admin` currently checks only whether a user is signed in. Production access must be enforced server-side and at the database policy layer by staff role.
3. The current order/checkout flow is presentation-only: no authoritative server-side cart validation, order creation, inventory transaction or payment capture exists.
4. Inventory has no batch/lot ledger or atomic stock movement model, so online ordering and counter sales cannot safely share stock.
5. The existing database role enum is only `admin|member`; it does not support the required `customer|budtender|manager|admin` operating model.
6. Production migration ownership is ambiguous: SQL migrations exist under `drizzle/migrations`, while `drizzle/schema.ts` is effectively a placeholder. A single canonical Supabase migration source must be established.
7. The repository contains a tracked `.env` file. It currently contains publishable Supabase configuration rather than a service-role secret, but production hygiene should move to an ignored `.env` plus a safe `.env.example`.
8. Two CannaPlug AI paths exist. The Supabase Edge Function is configured with `verify_jwt=false` and permissive CORS while the TanStack server function has its own rate limiting. These paths should be consolidated and hardened.

### Production change-log requirement

Every future code, schema, infrastructure or configuration change must append a dated entry to this file. Each entry should include: date/time, actor/tool, branch/PR, purpose, files or migrations changed, tests executed, deployment result, operational impact, and rollback notes. AI-assisted changes should also record the agent used and a short description of the prompt/task.

### Next implementation authority

The signed production implementation plan and handoff document dated 2026-09-28 is the controlling delivery plan for the transition from prototype to production. Changes should be made in feature branches and merged through normal PRs; do not force-push or rewrite published Lovable-connected history.


## 2026-09-28 - Production implementation plan and handoff generated
- Actor/tool: ChatGPT
- Branch / PR: `audit/production-readiness-2026-09-28` / draft PR #9
- Purpose: Document the audited prototype-to-production implementation plan and developer/client handoff.
- Files changed: documentation only; the signed handoff is delivered as an external PDF/DOCX artifact.
- Migrations: none
- Database/RLS impact: none
- Security impact: none; documentation records security blockers and target controls.
- Tests run: document render QA; PDF preflight; 27-page PDF render verification.
- Deployment result: no application deployment performed.
- Rollback: revert the documentation commit(s) on the audit branch if the audit record needs correction.
- Open risks: production remains blocked on the P0 items listed above.
- Handoff artifact: `CannaPlug_Production_Implementation_Plan_and_Handoff_2026-09-28.pdf`.


## 2026-09-28 - Verification pass: typecheck/build and lint gate
- Actor/tool: ChatGPT
- Branch / PR: `audit/production-readiness-2026-09-28` / PR #9
- Purpose: Validate the repository after the audit documentation changes and add an explicit TypeScript production check.
- Files changed: `package.json`.
- Permanent change: added `typecheck: tsc --noEmit`; production `build` now runs `tsc --noEmit && vite build`.
- Validation: Vercel preview deployment passed TypeScript typecheck and Vite production build.
- Lint validation: `eslint .` was attempted through the hosted build gate and caused a failed Vercel deployment. The connected Vercel integration does not expose build logs for this project scope, and GitHub Actions runner jobs failed before execution, so exact ESLint diagnostics could not be retrieved. No speculative lint edits were applied.
- Temporary diagnostics: CI workflow files and preview-only lint-report logic were added temporarily for diagnosis and removed before merge.
- Deployment result: latest verification deployment is expected to run the restored typecheck + production build gate.
- Rollback: revert the package.json commit if the explicit typecheck build gate causes an environment-specific deployment issue.

---

## 2026-09-28 — Baseline restore & engineering workflow

**Branch:** `chore/baseline-restore-and-test-harness` (from `e848f85`; no history rewritten)

**Intent:** Restore production styling and add guard rails. No product/UX change, no RBAC or payments work.

**Files changed**
- `src/styles.css` — restored from `53a63af` (34 KB); `@import "./journal.css";` placed at the top (after the tailwind imports) because CSS `@import` is ignored after any rule. This supersedes the "append at end" instruction in the restore section above.
- `supabase/migrations/` — canonical schema source (two migrations copied byte-for-byte from `drizzle/migrations`, timestamped from the drizzle journal dates) + README. `drizzle/` is left untouched as a Lovable-managed legacy mirror; `src/test/migrations.test.ts` fails on drift.
- `package.json`, `bun.lock` — `test`, `test:e2e` scripts; devDeps `vitest`, `@playwright/test`. (`typecheck` already existed: `tsc --noEmit`, strict config unchanged.)
- `vitest.config.ts`, `src/test/*.test.ts`, `playwright.config.ts`, `e2e/smoke.spec.ts` — unit + smoke harness.
- `.gitignore` — `.env`, `.env.*` (except `.env.example`), test output.
- `.env` — **untracked** (`git rm --cached`; file kept locally). It contained only Supabase URL/project id/publishable key, but was committed.
- `.env.example` — variable names only.

**Tests run:** `bun install --frozen-lockfile` ✅ · `bun run typecheck` ✅ · `bun run build` ✅ · `bun run test` (4 unit) ✅ · `bun run test:e2e` (2 smoke; set `PLAYWRIGHT_CHROMIUM_PATH` if browsers aren't in the default location) ✅ · `bun run lint` ❌ ~635 pre-existing problems (almost all prettier formatting in Lovable-generated files; identical on the base commit, not touched here).

**Rollback:** revert the branch's commit(s) (`git revert`), or `git checkout e848f85 -- <path>`. To re-track env: `git add -f .env`.
---

## 2026-09-29 — Customer/staff RBAC and least-privilege data foundation

**Actor/tool:** ChatGPT via GitHub connector  
**Branch / PR:** `feat/customer-staff-rbac` / PR #11 (security hardening pending)  
**Purpose:** Replace the legacy `admin|member` role model with `customer|budtender|manager|admin`; enforce staff authorization server-side; add customer addresses, verification metadata and immutable audit-log storage; tighten RLS on profiles/orders/products/user roles; and add a reproducible RLS test harness without redesigning the existing UI.  
**Application files changed:** `src/lib/staff-auth.server.ts`, `src/routes/admin.tsx`, `src/integrations/supabase/types.ts`, `package.json`, `.env.example`.  
**Migrations:** `supabase/migrations/20260929002000_customer_staff_rbac.sql`; mirrored byte-for-byte in legacy `drizzle/migrations/0002_customer_staff_rbac.sql` for the existing migration-drift guard.  
**Rollback:** `supabase/rollbacks/20260929_customer_staff_rbac_rollback.sql`; existing `admin` rows are preserved, legacy `member` semantics are restorable, and new support tables are removable only through the explicit rollback script.  
**Tests added:** `supabase/tests/rbac_rls.sql` covers helper hierarchy and positive/negative access cases for customer, budtender, manager and admin; `npm/bun test:rls` maps environment variables to psql variables for reproducible execution. Migration list: `20260929002000_customer_staff_rbac.sql` (canonical), `20260929003000_rbac_security_hardening.sql` (Amazon Q issues 1/3/6), and `0002_customer_staff_rbac.sql` (legacy mirror).  
**Deployment result:** Code/migrations prepared on the feature branch; live Supabase migration and hosted deployment were not executed in this session because the connected Supabase project API returned a permission error for schema inspection/type generation.  
**UI impact:** No visual redesign. `/admin` now performs a server-side staff authorization check before rendering the existing dashboard.  


## 2026-09-29 — Milestone 2: live admin data & order fulfilment

**Actor/tool:** ChatGPT via GitHub connector
**Branch / PR:** `feat/milestone-2-live-admin-fulfilment` / separate PR
**Purpose:** Replace prototype operational mock state with live Supabase data while preserving the existing admin/shop/account visual structure. Payments and POS are explicitly deferred.

**Mock-data classification**
- UI fixture: catalogue presentation images and category filter labels moved to `src/fixtures/catalog-presentation.ts`.
- Product seed: the existing Supabase product seed remains a database migration concern; it is no longer imported by production React routes.
- Operational state: mock admin orders, products, inventory, customers, metrics, activity, account orders/profile and product lists were removed from production paths.

**Application changes**
- `src/lib/admin-data.server.ts`: typed server-side data-access layer for dashboard metrics, orders, fulfilment, products, customers, inventory and member orders.
- `src/lib/admin.functions.ts`: authenticated server-function boundary with Zod validation.
- `src/routes/admin.tsx`: live overview, orders/detail, fulfilment queue, product CRUD/deactivation, inventory ledger overview and customers; existing layout retained.
- `src/routes/shop.tsx`: live active product catalogue from Supabase.
- `src/routes/account.tsx`: live member orders/catalogue; no hard-coded member operational state.
- `src/lib/mock-data.ts`: removed from production source tree.

**Database**
- `supabase/migrations/20260929004000_live_admin_fulfilment.sql` adds order status history, product price history, inventory batches and immutable stock ledger, plus server-validated order transitions.
- Product physical deletion remains admin-only; deactivation is the normal manager/admin workflow.
- Historical order lines retain immutable `product_name` and `unit_price_rand` snapshots.

**Tests**
- `src/test/admin-data.test.ts` covers the fulfilment transition map.
- `supabase/tests/milestone2_live_admin.sql` covers transition rules, product price-history capture and staff policy presence.
- Full application typecheck/build and the database harness must pass before merge/deployment.

**Deployment / rollback**
- This PR contains the canonical migration but does not deploy payments/POS.
- Apply the migration through the normal Supabase migration workflow after PR approval; rollback is by reverting the migration commit and applying a dedicated rollback migration if production data has already been introduced.


## 2026-09-29 — Milestone 2 validation hardening
- Actor/tool: ChatGPT via GitHub connector
- Branch / PR: `feat/milestone-2-live-admin-fulfilment` / PR #12
- Purpose: Finalise the live-data migration after review of the branch diff.
- Changes: added legacy `user` role compatibility to the server staff hierarchy; separated order/order-item reads for typed Supabase compatibility; corrected inventory batch counting to use distinct ledger batches; removed the shop's prototype `in_stock` boolean; added indexes for new fulfilment audit foreign keys; kept canonical Supabase and legacy Drizzle migration mirrors byte-for-byte aligned.
- Tests: fulfilment Vitest and SQL regression harness committed; hosted Vercel build is running through the repository integration. The connected Vercel API scope does not currently permit access to build logs.
- Deployment result: PR preview status remains subject to Vercel's external build gate; no production deployment was performed.
- Rollback: `supabase/rollbacks/20260929004000_live_admin_fulfilment_rollback.sql`.


## 2026-09-29 — Amazon Q review hardening

**Review:** Amazon Q Developer security review of PR #12.

**Findings addressed**
- Kept the existing live-DB price sourcing, layered staff authorization, server-side fulfilment state machine, historical order-line snapshots and removal of production mock operational data.
- Documented that the authenticated-role UPDATE grant on `orders` is intentionally shared by customers and staff, while the `orders update staff` RLS policy is the actual authorization boundary.
- Added database regression assertions for order visibility, staff-only order mutation, immutable historical order-line grants and admin-only product deletion.
- Expanded Vitest coverage for all fulfilment states, terminal states and prevention of backward/skip-ahead transitions.
- Replaced the earlier service-role-targeted RLS immutability policies with database triggers for `order_status_history` and `inventory_ledger`. This is intentional because Supabase `service_role` bypasses RLS.
- Added a constrained `product_price_history` mutation trigger: historical rows cannot be deleted or rewritten; only the active row's `effective_to` may be closed by the product price-history workflow.
- Kept `supabase/migrations/20260929004000_live_admin_fulfilment.sql` and `drizzle/migrations/0004_live_admin_fulfilment.sql` byte-for-byte aligned.

**Validation**
- SQL regression harness now checks transition rules, price-history capture, order/update authorization contracts, order-line write grants, admin-only product deletion and append-only audit triggers.
- Vercel's current connected API authorization still prevents access to deployment/build logs for the CannaPlug team scope, so no claim of a successful hosted build is made from this session.
- The migration remains packaged in PR #12 and has not been represented as applied to production.


## 2026-09-29 — Milestone 3: POS & atomic inventory

**Branch / PR:** `feat/milestone-3-pos-atomic-inventory` (see PR for the number)
**Migration:** `supabase/migrations/20260929010000_pos_atomic_inventory.sql` (mirrored to `drizzle/migrations/0007_…`), rollback `supabase/rollbacks/20260929010000_pos_atomic_inventory_rollback.sql` (rehearsed: `scripts/rollback-rehearsal.sh`).
**Principle:** *one* inventory engine and *no* client-controlled money or stock. The browser sends product ids, quantities, tender amounts and an idempotency key; PostgreSQL derives every price, total, stock decision and actor check.

### 1. Inventory transaction model (extends Milestone 2 — no second engine)

| Concept | Storage | Rule |
|---|---|---|
| **Batches** | `inventory_batches` (+`qty_on_hand`, `qty_held`) | `0 ≤ qty_held ≤ qty_on_hand` enforced by CHECK constraints |
| **Stock movements** | `inventory_ledger` (+`movement_type`), read view `stock_movements` | append-only; a trigger applies every insert to `qty_on_hand`; sign/type CHECK; unique `(movement_type, reference_type, reference_id, batch_id)` so a business line can never move a batch twice |
| **Reservations (held)** | `stock_reservations` (order line × batch) | insert-as-held → `consumed`/`released`/`expired` only; triggers maintain `qty_held`; one live reservation per line+batch |
| **Available** | `qty_on_hand − qty_held` (view `inventory_availability`) | expired batches excluded |
| **Consumed** | net of `online_sale`/`pos_sale` minus restock movements (same view) | derived, never stored |

Movement types: `receipt`, `adjustment`, `online_sale`, `online_cancel_restock`, `pos_sale`, `pos_void_restock`, `pos_refund_restock`. Allocation is first-expiry-first-out.

**Locking discipline (deadlock freedom):** every path locks `inventory_batches` rows **first, in one global order** (`product_id, expires_at NULLS LAST, received_at, id`) and only then touches reservations/ledger. Row order elsewhere: order → batches; session(share) → products(share) → advisory payment-reference locks → batches; sale → session(share) → batches (void/refund). Held is reduced *before* on-hand when consuming, so the CHECKs hold between statements. All mutating RPCs refuse to run below `READ COMMITTED`.

### 2. Tables added
`stock_reservations`, `operation_idempotency`, `payment_events`, `loyalty_ledger`, `cash_drawers`, `pos_sessions`, `pos_sales`, `pos_sale_items`, `pos_tenders`, `pos_refunds`, `pos_refund_items`, `pos_refund_payouts`; views `stock_movements`, `inventory_availability`.
- `pos_sessions`: opening float, `expected_cash`, `actual_cash`, `variance`, `tender_totals`, `sales_count`, `approval_status` (`not_required|pending|approved|rejected`), `approved_by/at/note`; **one open session per drawer** (partial unique index); closed counts are immutable.
- `pos_tenders`: `cash|card|eft|paypal`; `UNIQUE (method, reference)` — the same slip/capture cannot back two payments. `pos_sales`, `pos_tenders`, refunds, loyalty, payment events are append-only (triggers bind `service_role` too). A **deferred constraint trigger** re-checks at commit that `sum(items) = sum(tenders) = total` and that every line has matching stock movements, even for direct SQL.
- Variance beyond `pos_variance_tolerance()` (R10.00) needs approval by someone **other than the cashier**.

### 3. RPC surface (all `SECURITY DEFINER`, `search_path=''`, executable by `service_role` only)
`receive_stock`, `adjust_stock` (manager, reason mandatory, audited) · `create_online_order` (server-priced order + hold; max 5 open holds/customer), `reserve_order_stock`, `confirm_order_payment` (idempotent webhook entry point; outcomes `confirmed | already_processed | amount_mismatch | stock_unavailable_needs_refund | paid_after_cancel_needs_refund`), `release_expired_reservations`, `purge_old_idempotency_keys` · `pos_upsert_drawer`, `pos_open_session`, `pos_close_session`, `pos_review_session` · `pos_complete_sale`, `pos_void_sale` (manager, audited), `pos_refund_sale` (manager, multi-method payouts, audited) · `accrue_pos_loyalty`.
`transition_order_status` (Milestone 2 signature kept) now consumes/releases/restocks stock on confirm/cancel. Direct customer `INSERT` on `orders`/`order_items` is **revoked** (they used client-chosen totals); `create_online_order` replaces it.
**Payments:** `paypal` is a *tender/event reference* only; no PayPal API or webhook signature verification is implemented (no credentials in scope). `confirm_order_payment` is the DB entry point a verified webhook handler must call.
**Loyalty:** 1 point per R10 of net spend, accrued by a separate idempotent call **after** `pos_complete_sale` has committed (`pos-data.server.ts`); void/refund reverse points if they were already accrued; a failed accrual never fails the sale.

### 4. UI (`/admin` → **POS**, visual language unchanged)
`src/components/admin/pos/{PosPanel,StockControl}.tsx`, pure logic in `pos-logic.ts`, server boundary `src/lib/pos.functions.ts` (Zod, `.strict()` sale input — a price/total field is rejected), data layer `src/lib/pos-data.server.ts`.
Speed-first search (autofocus, `/`, ↑/↓, Enter, `3*blue` quick quantity), keyboard quantity controls (↑/↓/+/−/Delete), `F4` exact cash, `F9`/Ctrl+Enter complete, split multi-tender with per-method references, cash-change helper, receipt, till open/close with **blind count** (expected cash is only revealed after the count is submitted), void/refund (managers), variance approvals, receive/adjust stock (managers). Idempotency keys are reused for retries of the *same* basket and rotated when it changes. Cron-protected `POST /api/public/inventory/maintenance` expires holds and purges idempotency keys (schedule it, e.g. every 5 minutes; holds are also swept opportunistically).

### 5. Concurrency review (design findings and the protection for each)
| Risk | Verdict / protection |
|---|---|
| SELECT-then-UPDATE stock | Eliminated: allocation uses `FOR UPDATE` on batches, values re-read under the lock; counters bounded by CHECKs; negative-control test shows the naive pattern oversells |
| Reservation creation | Same lock order + unique live reservation per line/batch; duplicate/late/expired holds re-reserved or flagged `*_needs_refund` |
| Duplicate network requests / retries | `operation_idempotency` keyed per actor, request-hash checked; concurrent duplicates block on the unique index; failed attempts roll their key back (never poisoned); key reuse with a different payload is rejected |
| Webhook ↔ sale | `pg_advisory_xact_lock` per event and per payment reference (shared with POS tenders); `UNIQUE(provider,event_id)`; order row lock; cross-channel reference reuse rejected |
| Till close vs sale/void/refund | sales take `FOR SHARE` on the session, close takes `FOR UPDATE` (waits for in-flight sales; later sales see `closed`); `closed_at` uses `clock_timestamp()` (a test found `now()` = transaction start made the audit timeline misleading) |
| Loyalty after retries | unique `(source_type, source_id)`; sale row lock serialises accrual vs void/refund; post-commit only |
| Negative stock / duplicate financial records | impossible at DB level: CHECKs, append-only triggers, unique reference/idempotency indexes, deferred reconciliation trigger |
| Inventory-denial via unpaid holds | ≤5 live held orders per customer; TTL 5–120 min; sweep job |
| Residual (documented) | a leaked `service_role` key bypasses RLS but not the triggers/CHECKs; running under REPEATABLE READ is refused; idempotency-key retention (30 days) must be scheduled |

### 5b. Amazon Q concurrency review of PR #15 — triage
Each finding was verified against the code and tests before acting; two were incorrect and were **not** applied.

| # | Finding | Verdict | Action |
|---|---|---|---|
| 1 | Cron endpoint lacks isolation enforcement | Partly valid: the HTTP route cannot set isolation, but `release_expired_reservations` / `purge_old_idempotency_keys` were the only mutators without the READ COMMITTED guard | Guard added to both (and to the new sweeper); tests |
| 2 | `consumed` double-negates restocks | **Incorrect.** Sales have negative deltas and restocks positive, so `−SUM(delta)` = sold − returned. The suggested change would leave `consumed` unchanged after a void/refund/cancel | No change; SQL comment + tests pin the net semantics |
| 3 | Unvalidated `p_provider_event_id` before advisory locks | Valid hygiene (a 64-bit hash "collision" only causes spurious serialisation, not incorrectness) | Provider / event id (4–200) / order / amount validated **before** any lock; tests |
| 4 | Loyalty reversal TOCTOU in `pos_void_sale` | **Incorrect.** Void holds the `pos_sales` row `FOR UPDATE`; `accrue_pos_loyalty` must take the same lock first, so it cannot interleave. The suggested `SELECT SUM(...) FOR UPDATE` is invalid SQL (`FOR UPDATE` is not allowed with aggregates) | No change; explanatory comment; existing void-vs-accrual race test |
| 5 | Empty `catch` on loyalty accrual | Valid — and there was no retry at all | Failure is logged; new `accrue_missing_pos_loyalty()` sweeper (run by the maintenance job) credits committed sales whose accrual failed; concurrency tests |
| 6 | Sale guard allows `voided_at` mutation | Wrong as stated (`voided_at` was already immutable), but it exposed a real gap: `voided_by` / `void_reason` were mutable | Void metadata now write-once on the `completed → voided` transition; tests |

Of the 15 review-triage tests (`src/test/db/pos-review-fixes.test.ts`), 13 fail against the pre-fix migration and pass now; the 2 "consumed" tests pass on both, as intended.

### 6. Test evidence (all executed in this session)
- `bun run test:db` (real PostgreSQL 16, separate connections, warmed pool): **90/90** (75 concurrency/correctness + 15 review-triage), the first 75 run **6× consecutively** with no flake. Covers: 20-way last-unit race, 30-way stock-5 race, online-vs-POS last unit, 10-way online hold race, 12-way duplicate sale, lost-response retry, key reuse/poisoning/actor namespacing, card-slip reuse (sequential + concurrent), multi-tender/validation matrix, price-change-mid-sale, 40-way opposite-order multi-product sales (0 deadlocks), till close vs sales/refund/void (repeated rounds), double-close, one-open-drawer, variance approval segregation, concurrent refunds/refund-vs-void/partial split payouts, audited void/refund/adjustment, adjustment vs sale races, loyalty retry/void/refund races, webhook duplicates/double-capture/cancel race/expiry, cross-channel PayPal reference, RLS/EXECUTE privileges, REPEATABLE READ refusal, direct-SQL backstops.
- **Mutation testing** (each protection removed in turn; the suite must fail): removing row locks + CHECKs → 5 tests fail; removing session locking → close test fails; disabling idempotency → 2 fail; removing sale-row locks in void/refund/accrual → 2 fail; removing order/advisory locks in the webhook → 2 fail. Surviving tests under a single mutation were protected by a second independent layer.
- UI: 17 interactive tests (Testing Library + happy-dom; real keystrokes, mocked server layer) and 25 logic tests. **Not run:** the UI has not been exercised in a browser against the hosted backend from this session (no staff login).
- Whole gate: `tsc` 0 errors, ESLint 0 errors, `vite build` OK.
- Existing harnesses run for the first time on a fresh database: `milestone2_live_admin.sql` now passes. Three latent defects were found and fixed: unbalanced `$$` in that harness, the Milestone 2 price-history CHECK rejecting a same-instant zero-length interval (relaxed to `>=` in this migration), and a temp-table privilege in `rbac_rls.sql`. `rbac_rls.sql` still stops at line ~349 on a pre-existing fixture quirk (the admin fixture receives an extra `customer` role, so its "demote admin" statement hits `user_roles_user_id_role_key`); it passes every order/RLS assertion before that point and is unrelated to Milestone 3.

### 7. Local harness
`scripts/test-db.sh start|reset|stop` boots a disposable PostgreSQL with a minimal Supabase compatibility layer (`supabase/tests/local/bootstrap.sql`) and applies every migration; `scripts/gen-m3-types.mjs` regenerates the Milestone 3 part of `types.ts` from that schema.

### 8. Deployment notes
1. Apply `20260929010000_pos_atomic_inventory.sql` to the hosted project **before** deploying this code (the admin overview now reads `inventory_availability`).
2. Schedule `POST /api/public/inventory/maintenance` (Bearer `LOVABLE_CRON_SECRET`).
3. Create at least one drawer (POS tab → *Add drawer*) and receive opening stock before first sale.

## Least-privilege grants hardening (Milestone 2 stock & order tables)

Migration `20260929011000_m2_least_privilege_grants.sql` (mirror `drizzle/migrations/0008_…`, rollback in `supabase/rollbacks/`).
Hosted Supabase grants ALL on new public tables to `anon`/`authenticated`; RLS blocked API access but TRUNCATE/TRIGGER/REFERENCES are not RLS-governed, so privilege hygiene should not rely on RLS alone.

| Table | anon | authenticated |
|---|---|---|
| `inventory_batches`, `inventory_ledger`, `product_price_history`, `order_status_history` | none | SELECT |
| `orders` | none | SELECT (+ any existing column-level UPDATE, untouched) |
| `order_items` | none | SELECT |

`service_role` (server functions, SECURITY DEFINER RPCs) is unchanged. Applied to live and verified via `information_schema.role_table_grants`; `inventory_availability` still readable (48 rows).
Tests: `src/test/db/m2-grants.test.ts` (8 real-PG tests; fails 6/8 when the rollback is applied — negative control). `supabase/tests/local/bootstrap.sql` now mirrors hosted default privileges for anon/authenticated.

## 2026-09-30 — Milestone 4: live member account (`/account`)

**Migration:** `supabase/migrations/20260930001000_member_account_live.sql` (mirrored to `drizzle/migrations/0010_…`), rollback `supabase/rollbacks/20260930001000_member_account_live_rollback.sql` (rehearsed: `scripts/rollback-rehearsal-m4.sh` — restores the Milestone 3 POS functions byte-for-byte, leaves no M4 objects, and the migration re-applies afterwards).
**Principle:** the browser can *read* its own account and *ask* for things; it can never write money, points, ownership or another member's data. Every mutation is a database transaction whose actor comes from the verified JWT.
**UX:** unchanged layout, sidebar, cards, badges and typography; the same tabs now show live state.

### 1. Prototype state removed
`src/routes/account.tsx` no longer fetches or computes anything locally: no `slice(0,3)` "saved products", no `spend / 10` points, no hard-coded address copy. The only `@/fixtures` import left is `catalog-presentation` (it picks a category *image*; it holds no data). `src/test/account-no-prototype.test.ts` enforces this, and also that no browser code writes a loyalty table / `points_balance`, and that no server-function validator accepts a user id, price, total or balance.
Code layout: route shell `src/routes/account.tsx`; panels `src/components/account/*`; one data hook `use-member-account.ts` (load + Realtime); server layer `src/lib/member-data.server.ts` + `src/lib/member.functions.ts`; pure helpers `src/lib/member-logic.ts`; Realtime wiring `src/lib/member-realtime.ts`.

### 2. Addresses — server-side ownership
- Reads: RLS `addresses select own or staff` (unchanged), through the member's own client.
- Writes: **direct client INSERT/UPDATE/DELETE on `addresses` is revoked.** `member_save_address`, `member_set_default_address`, `member_delete_address` (service-role-only RPCs, `search_path=''`) take `p_user_id` from the verified token. Ownership is part of the row lookup (`WHERE id = $1 AND user_id = $2`), so another member's id is indistinguishable from a missing one (`address_not_found`). A per-member advisory lock makes "exactly one default" and the 10-address cap hold under concurrency; deleting the default promotes the most recent address.

### 3. Order timeline + Realtime
- `order_status_history` is now readable by the **owning customer** only through a *column-level* grant — `id, order_id, from_status, to_status, created_at` — plus policy `own order status history`. `note` and `actor_user_id` (staff-internal) are not readable by any client role. Staff keep reading full history through the service-role admin functions. (This replaces the table-level `SELECT` from the Milestone 2 hardening for this one table; `m2-grants.test.ts` was updated accordingly.)
- `orders`, `order_status_history`, `loyalty_accounts`, `loyalty_transactions` are added to the `supabase_realtime` publication (guarded: skipped if the publication does not exist).
- Client: `subscribeToMemberUpdates` opens one channel (`member-account:<uid>`) on those four tables (`user_id=eq.<uid>` filters where the column exists; the history table is scoped by RLS). Events are only a *signal*: bursts are coalesced and the UI re-reads authoritative state, and a reconnect triggers a re-read, so a dropped event cannot leave stale data. Events naming another member are ignored (defence in depth, not the security boundary).
- Active orders always show their timeline; finished orders collapse it.

### 4. Loyalty (ledger-derived; never client-editable)
| Table | Role |
|---|---|
| `loyalty_transactions` | **Append-only ledger.** `txn_type` earn/redeem/reversal, signed `points`, `balance_after`. `UNIQUE (source_type, source_id)` — one row per business event. CHECK: every row links to its source (`order_id = source_id` for `order*`, `pos_sale_id` for `pos_*`). |
| `loyalty_accounts` | Cache of the ledger: `points_balance`, `lifetime_points`, `tier_id`. A trigger guard rejects any write that does not come from the ledger trigger — **for every role including `service_role`**. No client role has INSERT/UPDATE/DELETE. |
| `loyalty_tiers` | seed 0 / sprout 500 / bloom 2000 / canopy 5000 **lifetime** points (spending points never demotes). Seed data — edit via SQL/admin later. |
| `loyalty_rules` | `earn_rand_per_point` (10), `redeem_rand_per_point` (0.10), `redeem_min_points` (100), `redeem_max_pct_of_order` (50, CHECK ≤ 90). POS accrual and POS refund reversal now read these too (defaults reproduce Milestone 3 exactly). |

How a ledger row is applied (`_loyalty_apply_txn`, BEFORE INSERT): lock the member's account row → return `NULL` (skip, no side effect) if the `(source_type, source_id)` already exists → refuse a **redemption** larger than the balance → update balance/lifetime/tier and stamp `balance_after`. The account lock serialises all of a member's ledger writes, which is what makes retries idempotent and double-spend impossible. A *reversal* may legitimately take the balance negative (clawback after a voided/refunded sale whose points were already spent); redemption is then blocked until it is positive again.

Milestone 3's `loyalty_ledger` stays as the POS event feed and is **mirrored** into `loyalty_transactions` by a trigger in the same transaction (existing rows were back-filled), so there is one balance and one tier across channels.

### 5. Accrual and redemption — database transactions linked to the source
| Event | Mechanism |
|---|---|
| Online order completed | `AFTER UPDATE OF status` trigger on `orders` → `accrue_order_loyalty(order)`; earns on `total_rand` (what was actually paid, after any points discount). Idempotent per order; also callable for retries. |
| Online order cancelled | same trigger → `reverse_order_loyalty(order)`: returns redeemed points (`order_redeem_release`) and claws back earned ones (`order_cancel`), once each. |
| POS sale | unchanged flow (`accrue_pos_loyalty` after commit + sweeper), now rule-driven; void/refund reverse through the mirror. |
| Redemption | `redeem_loyalty_points(user, order, points, key)`: order must be **owned by the caller** and `awaiting_payment`; one redemption per order; min / balance / max-share-of-item-subtotal limits; `total_rand` becomes the payable amount (so `confirm_order_payment` compares against the discounted figure) with `orders.loyalty_points_redeemed` / `loyalty_discount_rand` recording it. Idempotency-key replay returns the stored result. |
The triggers fire for `transition_order_status` and any future payment path without touching those functions. Lock order is orders → account everywhere (POS: sale → ledger → account).

### 6. Wishlist and back-in-stock (RLS)
- `wishlist_items (user_id, product_id)` and `back_in_stock_subscriptions`: members `SELECT`/`DELETE` their own rows and `INSERT (user_id, product_id)` only — policies require `user_id = auth.uid()`; the subscription `status` cannot be set by a client. The server functions use the member's **own** client so RLS is the enforcement, not application code.
- Guards (triggers): wishlist cap 200 and active products only; a subscription is accepted only for an *active, currently unavailable* product (`product_in_stock` otherwise), capped at 50 active.
- `claim_back_in_stock_notifications(limit)` (service-role) atomically flips due subscriptions to `notified` (`FOR UPDATE SKIP LOCKED`) and returns who to tell. **Not scheduled yet** — see *Known gaps*.
- Members only ever learn a boolean `in_stock`; counts stay staff-only.

### 7. Reorder
`reorder_check(user, order)` (read-only) re-evaluates every line against today's catalogue → `ok | price_changed | insufficient_stock | unavailable`, plus the current total. `create_reorder(user, order, expected_total, key)` re-runs that check **inside the transaction that creates the order**, refuses if the total the member confirmed differs from the live one (`price_changed`) or any line is unavailable (`reorder_unavailable`), then calls the existing `create_online_order` (server pricing + stock hold; a last-unit race still ends in `insufficient_stock`, never an oversold order). The UI shows the re-validated lines and total in a confirmation dialog first. Idempotent per key; ownership-checked.

### 8. Test evidence (executed in this session)
- **Real PostgreSQL** (`bun run test:db`): **137/137** — the 98 pre-existing (POS concurrency, review triage, M2 grants) plus **39 new** in `src/test/db/member-account.test.ts` covering address ownership/default/cap/RLS, timeline visibility and column privileges, publication membership, accrual idempotency (sequential + 12-way concurrent), tier promotion, POS mirror/void, client-write denial on every loyalty table (incl. `service_role` guard and append-only), redemption minimum/balance/share/once-per-order/replay/4-way double-spend/ownership/paid-order/cancel-release/earn-after-discount/clawback, wishlist + subscription RLS, notifier hand-off, reorder price/stock/retired/idempotency/ownership/last-unit race.
- **Mutation testing** (clean DB reset per run; each protection removed, suite must fail): idempotency check → **29** tests fail; overspend check → 3; redeem ownership check → 1; per-order cap → 1; reorder price re-check → 1. Baseline 137/137 afterwards. (A first attempt was invalid — the postgres OS user could not read my scratch file so nothing was mutated — and was discarded and redone.)
- **Browser layer** (Testing Library + happy-dom, network mocked): `member-realtime.test.ts` (5: subscription shape/filters, burst coalescing, foreign-row guard, cleanup, status forwarding), `member-timeline-live.test.tsx` (the real hook + timeline: a Realtime event makes a new status step appear without reload, and unmount removes the channel), `member-logic.test.ts` (10), `account-no-prototype.test.ts` (4).
- Whole gate: `tsc` 0 errors, ESLint 0 errors (9 pre-existing warnings), `vite build` OK, unit suite 71/71.
- **Not verified from this session:** (a) behaviour against the *hosted* Supabase Realtime server — the tests prove the RLS/column-grant visibility Realtime evaluates, and the client wiring, but not a live websocket; (b) the UI in a real browser with a member login. See deployment checklist.

### 8b. Live browser run (2026-10-01) — real Chromium, real auth/PostgREST/Realtime/Postgres
Harness: `scripts/live-stack/` (`up.sh`, README) builds a local Supabase-equivalent stack — GoTrue, PostgREST with the real RLS/column grants, Realtime over websockets (wal2json), Postgres with every migration — and `e2e/live/*.spec.ts` (`playwright.live.config.ts`) drives the real app in Chromium against it. It never touches the hosted project. **9/9 live specs pass** (`e2e/live/pr19-member-account.spec.ts`): sign-in shows the real (empty) account; addresses add/default/delete persist; wishlist + back-in-stock under RLS persist across reloads; an order's timeline updates **live over Realtime without a page reload** and the staff-only note never reaches the browser; **Realtime isolation** (raw websocket clients with no client-side filter): the owner receives their `orders`/`order_status_history`/`loyalty_transactions` events with no `note`/`actor_user_id` columns, a second customer receives **nothing**; direct PostgREST tampering by a signed-in member (loyalty balance/ledger/rules, orders, addresses, privileged RPCs, `note` column) is refused by the real database; points earn on completed orders, redemption applies a limited discount once and is returned once on cancel; reorder refuses a stale total, then creates the order at the current price with stock held, and is blocked for a retired product; a second member sees only their own data.
**Two real bugs the live run found (mocks had hidden both), fixed here with regression tests:**
1. *Specific error messages never reached members.* Errors were translated by `friendlyMemberError` twice (data layer, then server-function boundary); the second pass did not recognise the already-friendly text and collapsed every message to "The action could not be completed". Now idempotent (`MemberError`), unit-tested.
2. *Reorder dialog silently changed numbers.* After a refused reorder the refresh cleared the "prices changed" explanation. Fixed (message set after the refresh) with `src/test/reorder-dialog.test.tsx` (verified to fail on the old code).
Also fixed: the address form's labels were not associated with their inputs (accessibility). Still not verified: the hosted Supabase Realtime service itself (the live stack uses the same open-source Realtime server image, but not the hosted deployment).

### 9. Fixed while here
- `src/test/migrations.test.ts` was **already failing on `main`**: `drizzle/migrations` lacked a mirror of `20260929007000_admin_api_subscriptions.sql`, so the index-wise byte comparison was off by one. Added the mirror as `0007_…` and renumbered the later mirrors (`0008_pos_…`, `0009_m2_…`, this milestone `0010_…`) — file renames only, contents unchanged. Older notes in this file that say "mirrored to 0007/0008" refer to the previous numbering.
- `types.ts` was missing `addresses`; `scripts/gen-m4-types.mjs` regenerates the M4 region (and the two new `orders` columns) from the local schema.

### 10. Deployment checklist
1. Apply `20260930001000_member_account_live.sql` to the hosted project **before** deploying this code (the account page reads the new tables and RPCs). **Done 2026-10-01** on `Cannaplug 012` (`khltynzzcjhlujxbgyod`): applied as hosted migration `20260930001000_member_account_live`; post-apply checks confirmed 6 new tables with RLS, service-role-only RPCs, no client writes on loyalty/addresses, `note`/`actor_user_id` unreadable to `authenticated`, 4 tables in `supabase_realtime`, seed tiers/rules present, legacy table preserved as `loyalty_transactions_legacy` (0 rows).
2. In the Supabase dashboard confirm `orders`, `order_status_history`, `loyalty_accounts`, `loyalty_transactions` appear under *Database → Replication → supabase_realtime*, then sign in as a member, change an order's status as staff, and confirm the timeline updates without a reload. (If Realtime ever drops the history stream for a column-limited table, the page still converges: `orders` UPDATE events and the reconnect re-read refresh it.)
3. Regenerate nothing by hand: `types.ts` already includes the M4 schema.

### 11. Known gaps (deliberate, not forgotten)
- **Checkout** was still the prototype when Milestone 4 shipped; it is wired end to end in the *Checkout end to end* section below.
- **Back-in-stock emails are not sent** — deferred to a separate PR, see *Roadmap commitments* below (must land before Milestone 7).
- Loyalty rules/tiers have no admin UI (SQL only); no tier-based earn multiplier (it would also have to apply to POS refund reversal — a deliberate follow-up). No manual points adjustment RPC (would be a ledger row with an audited staff actor).
- Deleting an `auth.users` row that has loyalty history is blocked by the append-only ledger (same behaviour as Milestone 3's `loyalty_ledger`); a data-erasure policy (anonymise rather than delete) is a separate decision.
- Local harness: `bootstrap.sql` now creates an empty `supabase_realtime` publication so the publication membership test can run; it is test-only and never applied to hosted projects.


## Roadmap commitments

- **Back-in-stock emails — separate PR, MUST land before Milestone 7.** Decided 2026-10-01. Subscriptions (`back_in_stock_subscriptions`), the member UI (bell on out-of-stock products, "Back in stock" badge) and the atomic job entry point `claim_back_in_stock_notifications(limit)` already exist (Milestone 4); nothing sends mail yet. The follow-up PR must:
  1. send through Resend and wire a scheduled job — add it to `POST /api/public/inventory/maintenance` **together with** the sender, never the claim alone: the claim flips rows to `notified`, so claiming without a successful send silently loses the notification (`FOR UPDATE SKIP LOCKED` already prevents two senders getting the same row);
  2. decide failure handling (the claim has no un-claim: either make the sender retry within the same job run, or add a `notify_failed_at`/retry column and a re-queue RPC in that PR);
  3. include the product link, an unsubscribe path (deleting the subscription row is already allowed by RLS), and respect marketing-consent rules;
  4. cover it with tests like the rest of the member milestone (idempotent per subscription, no duplicate emails under concurrent job runs).
- **Compliance gate on online orders** (age / identity verification via `customer_verification`, any purchase limits) is not enforced anywhere in the online-order path — checkout, reorder and `create_online_order` alike. It needs a decision on the rules before it can be built.

## 2026-10-01 — Checkout end to end (`/checkout` → `/admin` and `/account`)

**Migration:** `supabase/migrations/20260930002000_checkout_orders.sql` (mirror `drizzle/migrations/0011_…`), rollback `supabase/rollbacks/20260930002000_checkout_orders_rollback.sql` (rehearsed: `scripts/rollback-rehearsal-m41.sh` — restores the Milestone 4 functions byte-for-byte). Built by `scripts/build-m41-migration.py` (lifts and patches four M4 functions from the M4 file so they cannot drift).
**Depends on:** Milestone 4 (`20260930001000_member_account_live.sql`). **Applied to hosted:** *yes* — `20260930002000_checkout_orders` applied to Cannaplug 012 (`khltynzzcjhlujxbgyod`) on 2026-10-01 and verified (2 delivery options, 4 new order columns + CHECKs, `checkout_*` functions executable by `service_role` only, RLS on `delivery_options`).
**Principle (unchanged):** the browser says *what* (product ids, quantities, one of its own saved address ids, a delivery option code, contact details, the total it displayed). The database decides *how much*.

### What the member now experiences
Cart → Details (name, phone, saved or new address, optional notes) → Delivery (server-owned options) → Payment (a **server quote** of live prices, stock and total) → **Place order** → real order number, a 2-hour stock hold and EFT instructions with the order number as the reference. The cart is emptied only after the server confirms the order exists. The order is immediately in `/account` (Orders tab, live timeline over Realtime, points redemption, reorder) and in `/admin` (Orders, with address, delivery method, contact and payment info).

### Server model
| Piece | Behaviour |
|---|---|
| `delivery_options` | server-owned fees (`standard` R80, `discreet` R120); anon/authenticated can only read active rows. |
| `orders` + `delivery_method`, `delivery_fee_rand`, `delivery_address` (jsonb **snapshot**), `payment_method` | a method and its snapshot can only exist together (`orders_delivery_snapshot_chk`; deliberately not `NOT NULL`, because the order is inserted before the snapshot is stamped and staff/legacy orders have none); the snapshot survives later edits/deletion of the saved address (tested). `total_rand` = items + delivery − points discount (the figure payment is checked against). |
| `checkout_quote(items, method)` | read-only; re-prices against the live catalogue, reports per-line `ok / insufficient_stock / unavailable`, fee and total. |
| `checkout_place_order(...)` | one transaction, service-role only: contact validation → idempotency → **address ownership** (`WHERE id AND user_id`; another member's id reads as `address_not_found`) → quote → refuse if items unavailable → refuse if `expected_total` ≠ live total (`price_changed`) → `create_online_order` (server pricing + 120-minute stock hold) → stamp delivery/payment → audit. Idempotent per key; double-submits return the same order. |
| Patched M4 functions | `redeem_loyalty_points` (discount applies to goods; delivery stays payable), `accrue_order_loyalty` (points earned on goods only, not delivery), `reorder_check` / `create_reorder` (delivery re-priced today; method + address snapshot carried over; a retired delivery option blocks the reorder). |

### Payments — honest scope
**No payment processor is integrated, so none is faked.** The prototype's card/SnapScan options, its client-side `PLUGBACK10` discount and its `Math.random()` order number are gone. Only **EFT** is offered (`payment_method_unsupported` for anything else, enforced in SQL). Staff confirm receipt in `/admin` → Orders → *Confirm EFT received*: bank reference + amount received go through the existing `confirm_order_payment` (the webhook path), which is idempotent per bank reference (a reference cannot be reused on another order), amount-checked (`amount_mismatch` changes nothing), consumes stock atomically, and writes a `payment_events` receipt plus an audit row. The bare "Confirmed" button is hidden for unpaid orders (the transition itself is still permitted server-side for staff). If the 2-hour hold lapsed before the EFT arrived, confirmation re-reserves if stock remains, else returns `stock_unavailable_needs_refund` and leaves the order unpaid (tested).
When a card/wallet processor is added it should call `confirm_order_payment` from a signed webhook and add its code to the `payment_method` CHECK and `checkout_place_order`.

### Test evidence (executed in this session)
- **Real PostgreSQL:** `bun run test:db` **156/156** (137 prior + 19 new in `src/test/db/checkout.test.ts`): quote pricing/fees/stock/validation; real order with server total, snapshot, 120-minute hold and timeline row; snapshot survives address edit/delete; stale/forged total refused with nothing created; unavailable stock refused; address ownership + completeness; contact validation and EFT-only; 8-way idempotent double-submit (one order, stock held once; key reuse with different body rejected); last-units race (exactly one wins); browser roles cannot call the RPCs and cannot edit delivery fees; the order is visible to its owner and not to another member, and the admin query shows the address; EFT confirmation (amount mismatch → nothing; idempotent per reference; stock consumed); lapsed-hold payment (refund-needed outcome, order stays unpaid); loyalty interplay (redeem + delivery fee, earn on goods only); reorder carries delivery and re-prices the fee, blocks on retired option.
- **Mutation checks** (clean DB each run): total check removed → fails; address-ownership check removed → fails; stock check removed → fails; EFT-only check removed → fails; fee not added to total → 6 fail; redeem ignoring delivery → fails; accrual on delivery → fails. All seven caught; baseline 156/156.
- **Browser layer** (`src/test/checkout-flow.test.tsx`, real page + cart, server mocked, 6 tests): happy path sends only ids/quantities/owned address id/displayed total/one key (asserted: no price or user id in the payload), shows server totals, real order number and EFT reference, clears the cart only after success; a price change keeps the cart, shows the new total and uses a fresh key; unavailable items block ordering; only EFT is offered and there is no promo/prototype text; contact validation; new address saved through the server and selected. `account-no-prototype.test.ts` also guards `checkout.tsx` against regressing (no `Math.random`, `PLUGBACK`, `SnapScan`; order only via `placeOrderFn`; cart cleared after it) and checks checkout validators accept no price/fee/user id.
- Whole gate: `tsc` 0 errors, ESLint 0 errors, `vite build` OK, unit suite 80/80.
- **Not verified from this session:** the flow in a real browser against the hosted backend (needs the migration applied and a member + staff login), and live Realtime delivery of the new order to an open `/account` tab.

### Live browser run (2026-10-01) — `e2e/live/pr20-checkout.spec.ts`, real Chromium + real auth/PostgREST/Realtime/Postgres
Same harness as Milestone 4 (`scripts/live-stack/`, README). **8/8 live specs pass, and all 17 (PR 19 + PR 20) pass together:** the shop's *Add* button puts a real DB product id in the cart; **placing an order from the UI** is priced by the server (a R1 price planted in the cart is ignored; R100×2 + R120 = R320), stock is held, the order has the delivery snapshot / `eft` / contact phone, and it **arrives live in a second open `/account` tab without a reload**; another customer cannot see it; **`/admin`** shows the address, contact and delivery method, hides the bare "Confirmed" button for unpaid orders, **refuses a wrong EFT amount**, confirms the right one (stock consumed, `payment_events` receipt, audit rows), the member's open page updates live, and **the same bank reference cannot confirm a second order**; a price change while reviewing is refused with the specific "Prices changed" message, the cart is kept and the order succeeds at the new price; a stock shortfall blocks ordering and creates nothing; **a same-tick double click creates exactly one order and holds stock once**; and reordering a completed checkout order carries over the delivery method and address snapshot with the fee re-priced.
**Real bug found and fixed:** after staff confirmed an EFT the success message disappeared (it lived inside the form, which unmounts the instant the order leaves *awaiting payment*); the outcome message now lives in the parent panel. Harness lessons recorded there too: GoTrue must set `GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated` (otherwise tokens have an empty `role` and every request is `role "" does not exist`).

### Known gaps
- No card/wallet payments (see above). Delivery fees are flat per option (no zone/weight pricing); `delivery_options` has no admin UI (SQL only).
- Guest checkout is not supported (sign-in is required, as before).
- The compliance gate and back-in-stock emails are tracked under *Roadmap commitments*.
- Promo codes were removed rather than faked; a real promo/voucher system would be a server-side table + redemption RPC like loyalty.
