# Deployment

## Record (2026-10-12)

The owner chose an existing Cloudflare account that also hosts other, unrelated projects. Only new resources with the `halloween-checkin` prefix were created; nothing else in the account was read beyond listing names to avoid collisions:

- D1 database `halloween-checkin` (id `8e431479-cb92-4c97-9c2e-1ae28caf1fab`), migration `0002_halloween_checkin.sql` applied
- R2 bucket `halloween-checkin-media`
- Worker `halloween-checkin` at https://halloween-checkin.a512884335.workers.dev (workers.dev only, preview URLs disabled, no custom route)
- Worker secret `OWNER_TOKEN` (random, stored only as a secret and in the developer's gitignored `.env.local` as `HC_TOKEN`)

The account id is not stored in the repository; export `CLOUDFLARE_ACCOUNT_ID` when running wrangler. The resources share the account's plan limits and billing with the other projects. To remove everything: delete the Worker, the D1 database and the R2 bucket by those exact names.

The demo contains one synthetic check-in (`ck-462c1a3b8d40`, normal + halloween editions). The Worker, D1 database and R2 bucket were first deployed from the predecessor development repository and are now deployed from this one; data and bindings are unchanged. There is no delete feature; removing it means clearing the `hc_*` tables in this project's own D1 database.

## Original checklist (kept for reference or for a second environment)

Steps marked **owner** change a Cloudflare account and must not be run without the owner naming the target account.

## Decisions needed from the owner (for a new environment)

1. **Target Cloudflare account.** Name it explicitly; never reuse resources of other projects in that account.
2. A public hostname (a workers.dev subdomain is enough for the demo).
3. Whether the repository and the demo are shared publicly.

## Steps (owner)

```bash
npx wrangler d1 create halloween-checkin            # note the database_id
npx wrangler r2 bucket create halloween-checkin-media
```

Add to `wrangler.jsonc` (use the real ids from the commands above):

```jsonc
"d1_databases": [{ "binding": "DB", "database_name": "halloween-checkin", "database_id": "<id>", "migrations_dir": "migrations" }],
"r2_buckets": [{ "binding": "MEDIA", "bucket_name": "halloween-checkin-media" }],
"vars": { "PROJECT_ID": "halloween-checkin-prod" }
```

```bash
npx wrangler d1 migrations apply halloween-checkin --remote
openssl rand -base64 32 | npx wrangler secret put OWNER_TOKEN     # stored only as a Worker secret
npm run build && npx wrangler deploy
```

Then, on the machine that runs the Skill: `export HC_API_URL=https://<worker-host>` and `export HC_TOKEN=<the same token>` in the shell environment only.

`PROJECT_ID` is part of every approval's target; changing it invalidates earlier approvals by design.

## Smoke test after deployment

Run the same checks as `scripts/e2e-local.mjs`, but against the deployed URL, with a clearly labelled synthetic pair first. Confirm: anonymous `POST /api/revisions` returns 401; `/api/checkins` lists the record; both `/media/<revisionId>/day.png|night.png` return `image/png`; the public JSON contains no owner id, hashes or storage keys.

## Known gaps before real use

- Bearer token only (no OAuth, no MCP connector); the owner chose a skill-only integration.
- No rate limiting. Add a Cloudflare rate-limiting rule on `/api/*` before sharing the URL widely.
- Approval is an agent attestation (see design §3), not an independent human confirmation.
- Worker CPU time for PNG verification was only observed in local workerd, not measured on the Workers Free plan.
- Backups: D1 time travel and R2 are the only recovery tools; there is no delete/replace feature.
