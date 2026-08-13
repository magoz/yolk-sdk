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
- DB-backed app tests load `.env.test`; root `pnpm test:run` pushes the test schema first, and DB-dependent tests skip when `DATABASE_URL` is absent.
- Effect app/services use `Config.*`; map config errors around the owning `Effect.gen` block.
- Direct `process.env` is limited to app config, `lib/dotenv.ts`, Playwright setup/fixtures/spec skips, property-test helpers, DB scripts, and synchronous SDK callbacks such as `TelemetryLayer`.
- `lib/dotenv.ts` is the only direct `dotenv.config()` owner and loads app-local env for scripts, Vitest, and Playwright.

## App Notes

- React Compiler is enabled.
- PostHog is proxied through `/ph/*`.
- Drizzle v1 RC uses the Effect-native driver.
