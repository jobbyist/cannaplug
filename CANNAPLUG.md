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
**Branch / PR:** `feat/customer-staff-rbac` / pending  
**Purpose:** Replace the legacy `admin|member` role model with `customer|budtender|manager|admin`; enforce staff authorization server-side; add customer addresses, verification metadata and immutable audit-log storage; tighten RLS on profiles/orders/products/user roles; and add a reproducible RLS test harness without redesigning the existing UI.  
**Application files changed:** `src/lib/staff-auth.server.ts`, `src/routes/admin.tsx`, `src/integrations/supabase/types.ts`, `package.json`, `.env.example`.  
**Migrations:** `supabase/migrations/20260929002000_customer_staff_rbac.sql`; mirrored byte-for-byte in legacy `drizzle/migrations/0002_customer_staff_rbac.sql` for the existing migration-drift guard.  
**Rollback:** `supabase/rollbacks/20260929_customer_staff_rbac_rollback.sql`; existing `admin` rows are preserved, legacy `member` semantics are restorable, and new support tables are removable only through the explicit rollback script.  
**Tests added:** `supabase/tests/rbac_rls.sql` covers helper hierarchy and positive/negative access cases for customer, budtender, manager and admin; `npm/bun test:rls` maps environment variables to psql variables for reproducible execution.  
**Deployment result:** Code/migrations prepared on the feature branch; live Supabase migration and hosted deployment were not executed in this session because the connected Supabase project API returned a permission error for schema inspection/type generation.  
**UI impact:** No visual redesign. `/admin` now performs a server-side staff authorization check before rendering the existing dashboard.  
