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
