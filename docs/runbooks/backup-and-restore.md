# Backup and restore

What protects FindMaxxing's data, how to get it back, and how to prove the
procedure works before you need it.

## What there is to lose

| Data | Lives in | Backed up by |
| --- | --- | --- |
| Everything relational (profiles, places, events, ratings, saves, lists, reports, moderation history, rate-limit counters) | Supabase Postgres, `public` schema | Supabase daily backups; point-in-time recovery (PITR) if enabled |
| Accounts (emails, password hashes) | Supabase Postgres, `auth` schema | Same as above (it is the same database) |
| Place photos (three sizes each) and avatars | Supabase Storage buckets `place-photos`, `avatars` | **Not** covered by database backups. See [Storage](#storage) |

## Before the beta opens

1. **Turn on point-in-time recovery** (Supabase dashboard → Project Settings →
   Add-ons → Point in time recovery). Daily backups alone can lose up to a day
   of contributions; PITR restores to any second in the retention window. Pick
   at least 7 days of retention.
2. **Rehearse a restore** against a scratch database (below) and record the
   date and result in `docs/beta-gate.md`.
3. **Set up a Storage copy** (below). Without it, a deleted bucket or a bad
   script run cannot be undone.

## Rehearsing a restore

Locally, with no credentials (proves the dump and restore path and that RLS
survives it):

```bash
npx tsx scripts/backup-restore-rehearsal.ts
```

Against real databases (install the Postgres client tools first, e.g.
`brew install libpq`; the target must be an empty scratch database or a fresh
Supabase project, never production):

```bash
SOURCE_DATABASE_URL='postgres://…staging…' \
TARGET_DATABASE_URL='postgres://…scratch…' \
  npx tsx scripts/backup-restore-rehearsal.ts --remote
```

The script dumps the `public` schema (schema and data) and the `auth.users`
rows, restores them into the target, and fails unless every table's row count,
every RLS policy, every RLS-enabled table, every function and every trigger
match, and a non-local still cannot see a locals-only place.

## Restoring production

**Accidental change to a few rows** (a bad script, a mistaken moderation
action): do not roll back the whole database. Restore a PITR copy into a *new*
project (dashboard → Database → Backups → Restore to a new project), then copy
the affected rows back with SQL. Moderation history is append-only, so it is
the record of what moderators did.

**Whole-database loss or corruption**:

1. Put the site in maintenance (Vercel: promote a static maintenance
   deployment, or remove the production domain alias).
2. Dashboard → Database → Backups → Point in time: pick the last good moment.
   Supabase restores in place; the project is unavailable while it runs
   (roughly minutes per GB).
3. Run the staging RLS checks against the restored project
   (`scripts/staging-check.ts` with the production URLs and `--skip-migrations --skip-e2e`)
   before letting traffic back in. It creates and deletes its own test users.
4. Bring the site back and note the data-loss window in the incident record.

**Without PITR** (daily backups only): the same, from the latest daily backup,
and expect to lose up to a day of writes.

## Storage

Supabase backups do not include Storage objects. Until Supabase offers it,
copy the buckets on a schedule with the S3-compatible API (dashboard →
Storage → Settings → S3 access keys):

```bash
aws s3 sync s3://place-photos ./backup/place-photos \
  --endpoint-url "https://<project-ref>.supabase.co/storage/v1/s3" --profile supabase
aws s3 sync s3://avatars ./backup/avatars \
  --endpoint-url "https://<project-ref>.supabase.co/storage/v1/s3" --profile supabase
```

Run it daily (a GitHub Actions schedule with the keys as secrets works) into a
bucket you own, with versioning on. To restore, sync back the other way.
Object paths are stable (`<user id>/<uuid>.webp` and its `.md`/`.sm` sizes), so
restored files line up with the database rows that point at them.

## Account deletions and backups

A deleted account's data stays in backups until they age out (PITR retention,
plus Supabase's daily backup retention). Say so in the privacy policy. If an
old backup is ever restored, re-run every account deletion made since that
point: keep a log of deleted user ids (the deletion action's monitoring
reports include them) for exactly this.
