@AGENTS.md

# MVP build rules

These rules apply to every Claude Code session in this repository (jobbyist/cannaplug). Production: https://cannaplug012.co.za on Vercel; database: Supabase project `khltynzzcjhlujxbgyod`.

## Business decisions in force (23 Oct 2026)

- Cannaplug is replacing **Yoco completely** (POS and online). Online payments: **PayPal** (USD at a live rate) and **PayFast** (ZAR). In store: **cash, card and EFT** recorded in the Cannaplug till.
- The POS must produce **receipts that can be printed or emailed** to the customer.
- Products come from the Yoco POS export; customers will be imported separately; EFT bank details are confirmed by the owner before they are shown anywhere.

## How to work

1. Read `CANNAPLUG.md`, `README.md` and `docs/release/*.md` first. Follow the patterns already used for migrations, RPCs, RLS and tests; do not invent new ones.
2. One branch per workstream: `feat/mvp-<slug>` from `origin/main`. Never force-push, rebase or amend pushed commits (the repo syncs with Lovable). Keep `main` deployable.
3. **Database:** every change is a new file in `supabase/migrations/` with a byte-identical mirror in `drizzle/migrations/`, a rollback in `supabase/rollbacks/` and a rehearsal script in `scripts/`. Functions are `SECURITY DEFINER` with `search_path=''`, an explicit actor argument, an idempotency key and an audit row, executable by `service_role` only. RLS on every new table; browser roles get no write grants. List each migration in the PR and record whether it was applied to the hosted project.
4. Server logic lives in TanStack server functions (`*.functions.ts` + `*.server.ts`). The browser sends ids and quantities, never prices, roles or user ids.
5. **Tests:** unit and component tests in `src/test`, real-Postgres tests in `src/test/db` (`bun run test:db`), and a mutation check for every new security rule. Run `scripts/verify-release.sh` before opening a PR and paste its summary into the PR.
6. **UI:** use the design tokens (Forest `#0B3D20`, Leaf `#16A34A`, Gold `#D4AF37`, Cream `#F8FAF8`; Montserrat + Inter) and the shadcn components in `src/components/ui`. Keep the Stories bar and floating bottom nav as the signature UX.
7. Never put health, ID or clinical data in emails, push messages, receipts, logs or analytics.
8. Append a dated entry to `CANNAPLUG.md` for every PR: purpose, files, migrations, tests run, owner actions, rollback.
9. When a step needs the owner's credentials or decisions, stop at that step, record it under **Needs the owner** in the PR description, and finish everything else.
