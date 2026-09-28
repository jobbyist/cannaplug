# Database migrations (canonical)

`supabase/migrations/*.sql` is the single source of truth for the CannaPlug schema.
Add new changes as new timestamped files (`YYYYMMDDHHMMSS_description.sql`); never edit an applied migration.

`drizzle/` is written by Lovable's tooling and is a frozen legacy mirror. Do not add schema there.
`src/test/migrations.test.ts` fails if the two ever drift.
