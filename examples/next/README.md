# Next example development

Private dogfood app for the Yolk SDK. Commands below run from the checkout root.

## Worktree provisioning

Use the operator-installed `provision-env` / `sandbox-db` tools used by Herdr; these
are not SDK dependencies or a copy of 10x's Factory. The installed tool guide is
`~/.local/share/sandbox-db/README.md`.

Prerequisites:

- Installed provisioning tools, Bun, pnpm, and authenticated Vercel CLI.
- An app-local, ignored `examples/next/.vercel/project.json` linked to the existing
  `magoz-team/yolk` project. Verify its connected repository is `magoz/yolk-sdk` and
  its Root Directory is `examples/next`; do not create a new Vercel project.
- Readable Vercel **Development** and custom **test** environments.
- A complete Development-only Neon profile: `SANDBOX_DB_NEON_API_KEY`,
  `SANDBOX_DB_NEON_PROJECT_ID`, and `SANDBOX_DB_PARENT_BRANCH_ID`. Do not silently
  substitute an unrelated global profile.

Root `package.json#provisionEnv.appDir` selects `examples/next`. Herdr uses this
setting when provisioning a requested new worktree. For an existing checkout,
stop its app servers before an authorized provisioning run:

```bash
provision-env --repo "$PWD" --check-vercel-link --non-interactive
provision-env --repo "$PWD" --database --ttl 7d
```

This installs locked dependencies, pulls Development into
`examples/next/.env.local` and custom test into `examples/next/.env.test`, strips
known generated deployment metadata and Vercel database URLs, and overlays two
independent Neon databases. Both env files are ignored, untracked, and mode `0600`.
`DATABASE_URL` and `DATABASE_URL_UNPOOLED` are written separately for each lease.
Installation, lease identity, and locking remain checkout-rooted.

The tool reuses unambiguous sibling Vercel links at the **same app-relative path**;
it does not fall back to an old root `.vercel` link. Repeated provisioning refreshes
local env files by default. Use `--env-conflict error` to refuse existing files or
`--env-conflict preserve` when intentionally retaining them. `--skip-install` is
available when dependencies are already installed.

## Environment and baseline policy

Development app variables were copied from custom `test`, excluding database URLs
and generated deployment metadata. Keep required app variables available in both
environments. Never print their values or commit env files. Provisioning does not
change Vercel variables; future remote changes require approval.

**The configured parent in the Neon `yolk` project is named `production`, but the
owner confirmed that this app and its current data are testing-only and explicitly
approved cloning that parent.** Branch creation copies its schema and data as-is;
it does not sanitize them or mutate the parent. Reconfirm this policy if the app
starts serving real production users or the configured project/parent changes.
Do not infer clone permission from a branch name alone.

Only the databases are isolated. Copied credentials and service URLs can still
refer to shared email, AI, telemetry, storage, or Cloudflare services. Local app
origin/auth configuration is a separate concern: provisioning does not adapt
`NEXT_PUBLIC_PROJECT_URL` or `YOLK_APP_URL` to each worktree. Do not assign `PORT`
in provisioning; Portless owns the development server port.

## Lease verification and lifecycle

```bash
sandbox-db status --worktree "$PWD" --lease default
sandbox-db status --worktree "$PWD" --lease test
```

Before running DB commands, confirm both leases are live, use distinct branches,
point to this checkout's app-local env files, and clone the approved parent.
Leases expire automatically; the default and maximum requested lifetime is seven
days. Renew each slot if needed:

```bash
sandbox-db renew --worktree "$PWD" --lease default --ttl 7d
sandbox-db renew --worktree "$PWD" --lease test --ttl 7d
```

When finished, stop the app and release only this checkout's disposable slots:

```bash
sandbox-db release --worktree "$PWD" --lease default
sandbox-db release --worktree "$PWD" --lease test
```

Release removes the leased DB URL keys. Keep the Development sandbox profile
available for lifecycle commands. If env files are lost or leases expire, rerun
`provision-env --repo "$PWD" --database` to restore or replace the pair.

## Schema and tests are separate

Provisioning does **not** push schemas, migrate, reset tables, seed, or start the
app. A cloned baseline may already contain the schema. Review schema differences
and obtain approval for DB operations before using `pnpm db:push` on the verified
development lease.

`pnpm test:db:push`, `pnpm test:run`, and `pnpm test:e2e*` can **drop and recreate the
test public schema**; Playwright also resets/truncates data. Run them only against
the verified disposable test lease. The current test guard checks `NODE_ENV=test`;
that flag alone does not prove database isolation. See [E2E rules](e2e/AGENTS.md).
Do not run these as read-only provisioning checks.

After configuration and any separately approved schema preparation, start with
`pnpm dev`. For manual setup without provisioning, install dependencies and copy
`examples/next/.env.example` to `examples/next/.env.local`, supplying approved
configuration; the template alone is not a runnable environment.
