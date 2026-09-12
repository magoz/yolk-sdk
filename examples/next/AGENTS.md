# Next Example

Private Next.js dogfood/reference app for `@yolk-sdk/*` packages.

## Role

- Show real host integration for SDK packages.
- Own app-specific auth, DB, UI, telemetry, and deployment adapters.
- Keep reusable, domain-free primitives in `packages/*`.

## Rules

- Consult `examples/next/patterns/README.md` before app/page/API/server-action work.
- App Router code lives in `examples/next/app`; see nested `AGENTS.md` files.
- UI components live in `examples/next/components/ui`; Tailwind/shadcn config is app-local.
- App-owned backend/domain/services live in `examples/next/lib/*`; they are not public SDK.
- App-specific Playwright tests live in `examples/next/e2e`.
- Use `pnpm --filter @yolk-example/next check` when touching example config/app code.
- Use `pnpm --filter @yolk-example/next build` after routing/config changes.
- Do not publish this workspace.

## Commands

- Dev: `pnpm dev:app` or root `pnpm dev` through portless
- Typecheck: `pnpm --filter @yolk-example/next check`
- Build: `pnpm --filter @yolk-example/next build`

## Env

- App env files live under `examples/next`: `.env.local`, `.env.test`, `.env.example`.
- Keep `.vercel` linking files here. Root `package.json` sets `provisionEnv.appDir` to `examples/next`.
- Preferred worktree setup: `provision-env --repo <worktree> --database` from any directory. It pulls Vercel Development into `.env.local` and the custom `test` environment into `.env.test`, then overlays isolated Neon branches. Do not assign `PORT`; Portless owns it.
- Follow [the provisioning runbook](README.md) for prerequisites, the owner-approved testing-only Neon parent named `production`, lease verification/renewal/release, and shared-service boundaries. Reconfirm clone approval if the app gains real production data or the configured parent changes.
- Provisioning does not prepare schemas. Verify the disposable lease and obtain DB-operation approval first; `pnpm test:db:push`, `pnpm test:run`, and `pnpm test:e2e*` can drop the test public schema. Do not use them as read-only provisioning checks.
- Manual fallback: `cp examples/next/.env.example examples/next/.env.local`.
- DB-backed app tests load `.env.test`; root `pnpm test:run` pushes the test schema first, and DB-dependent tests skip when `DATABASE_URL` is absent.
- Effect app/services use `Config.*`; map config errors around the owning `Effect.gen` block.
- Direct `process.env` is limited to app config, `lib/dotenv.ts`, Playwright setup/fixtures/spec skips, property-test helpers, DB scripts, and synchronous SDK callbacks such as `TelemetryLayer`.
- `lib/dotenv.ts` is the only direct `dotenv.config()` owner and loads app-local env for scripts, Vitest, and Playwright.

## App Notes

- Auth and Next dev-origin checks use validated `PORTLESS_URL` only in `NODE_ENV=development`; see [Portless origins](README.md#portless-origins). Keep deployed/static fallback and fixed-port E2E behavior intact; never trust arbitrary request origins.
- React Compiler is enabled.
- PostHog is proxied through `/ph/*`.
- Drizzle v1 RC uses the Effect-native driver.
