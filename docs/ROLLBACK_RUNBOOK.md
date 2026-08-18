# TopFlowNG — Rollback Runbook

How to roll back the production website safely if a deploy introduces a defect.

## 1. Know the known-good commit

The last verified-good `main` commit before the current deploy. Confirm it with:

```bash
git log --oneline -10
```

Production auto-deploys from GitHub `main` via Railway. `DEPLOYED COMMIT == GITHUB MAIN` when healthy.

## 2. Decision: revert code vs. revert deployment

- **Revert the deployment only** (fastest, no history rewrite) when you need the previous running build immediately.
- **Revert the code** (git revert, a new forward commit) when the defect is on `main` and you want CI green again.

Use `git revert` (never `git reset --hard` + force-push) so history stays append-only and CI/deploy are consistent.

```bash
git checkout main
git pull origin main
git revert --no-edit HEAD        # or: git revert <bad-commit-sha>
git push origin main             # triggers Railway deploy
```

## 3. Database migration recovery

Migrations are forward-only, tracked in `schema_migrations` (lexical order in `migrations/*.sql`).

- **Rolling back a migration that already ran** requires a *new* forward migration (e.g. `010_revert_009.sql`) that drops/recreates the affected objects. Never edit an already-applied migration file.
- If a failed deploy applied a partial migration, the migration runner must be re-run idempotently; each file is guarded by `schema_migrations`.

## 4. Railway previous deployment

In the Railway dashboard (project `fd606d99-5e37-42c2-804e-75382864501c`, service `10b0c2e2-6f66-4278-9836-1b53cb42ecdc`):

1. Open the **Deployments** tab.
2. Locate the last healthy deployment.
3. Use **Redeploy** to restore that build.

This is the fastest rollback when the running container is broken but the DB is fine.

## 5. Post-rollback verification

```bash
curl -sS https://topflowng.com/api/health
curl -sS https://topflowng.com/api/ready
curl -sS https://topflowng.com/api/providers/health
curl -sI https://topflowng.com
```

Also verify:
- `/api/admin/ops` returns healthy with no issues
- financial reconciliation reports "In balance"
- no broken assets / 5xx in the browser console

## 6. Guardrails

- Never run destructive SQL against production.
- Never force-push `main`.
- Keep migrations forward-only.
- Confirm the financial ledger is balanced before and after any rollback that touches purchases.
