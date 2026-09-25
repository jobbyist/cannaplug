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
| UI | React 19, Tailwind 4 (oklch design tokens), custom CSS in `src/styles.css` |
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

## Changes & Fixes Logged (2026-09-25)

### 1. Broken Journal / Newsroom page build (FIXED)

**Symptom:** Journal index and article pages rendered content but layout was broken. Category filter links appeared concatenated (`AllCultureIndustryLaw & PolicyWellnessLifestyle`) with no spacing, cards lacked structure, lead story had no grid.

**Root cause:** `src/styles.css` contained **zero** rules for any `.journal-*` classes used by:

- `src/routes/journal.index.tsx`
- `src/routes/journal.$slug.tsx`

Components were correct; CSS was never shipped after the Journal feature was added in Lovable.

**Fix:** Appended a complete Journal stylesheet covering:

- Masthead, category filters (flex + gap + pill active states)
- Lead story grid, card grid, cover fallbacks
- Article detail (standfirst, hero, body typography, sources, related)
- Product callouts inside articles
- Responsive breakpoints (900px / 600px) including horizontal-scroll filters on mobile
- Dark-mode accent overrides

### 2. Production / smoke verification notes

| Area | Status | Notes |
|------|--------|-------|
| Homepage | OK | Hero, stories, categories, products, Plug Back, experience, news teaser, events, contact, floating nav |
| Theme toggle | OK | Persists `cannaplug.theme`; root script applies class before paint |
| Chat widget | OK | Notch visible; panel open/close, session storage, AI call path present |
| Journal index | Fixed | Filters, lead, grid now styled |
| Journal article | Fixed | Typography, product callouts, related, sources |
| Mobile / tablet | Partial | Homepage & floating nav responsive; Journal filters now scroll on small screens |
| Assets | OK | Favicons, social-preview, store video present under `public/` |

### 3. Remaining recommendations

1. **CI / build** — Run `bun run build` (or `npm run build`) in CI; watch for Tailwind `@source` and any missing asset warnings from large video files.
2. **Journal empty state** — When Supabase `articles` is empty or RLS blocks, empty copy is already present; ensure seed/newsroom runner populates content.
3. **Newsroom API** — `/api/public/newsroom/run` + `src/lib/newsroom.server.ts` should be rate-limited and auth-gated in production.
4. **Accessibility** — Confirm focus rings on filter chips and chat panel; reduce-motion already respected for cart badge.
5. **Image performance** — Journal cover images from Unsplash should use `loading="lazy"` (already present) and consider fixed aspect-ratio containers to avoid CLS.
6. **Dark mode polish** — Logo invert filter exists; verify Journal lead image contrast and chat panel surfaces under `.dark`.
7. **Type safety** — `journal.$slug` casts Supabase row; keep Zod validation if schema drifts.

---

## How to verify locally

```sh
git clone https://github.com/jobbyist/cannaplug.git
cd cannaplug
bun install   # or npm i
bun run dev
# Visit / and /journal
bun run build && bun run preview
```

---

## File touch list (this run)

| File | Action |
|------|--------|
| `src/styles.css` | Appended full Journal CSS block |
| `CANNAPLUG.md` | Created (this document) |

---

## Commit message suggestion

```
fix(journal): restore missing Journal/newsroom styles

Category filters, lead story, card grid and article layout had no CSS
after the Journal feature landed. Adds responsive journal stylesheet and
CANNAPLUG.md audit log.
```
