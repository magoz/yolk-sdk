# Next Example

Private Next.js dogfood/reference app for `@yolk-sdk/*` packages.

## Role

- Show real host integration for SDK packages.
- Own app-specific auth, DB, UI, telemetry, and deployment adapters.
- Keep reusable, domain-free primitives in `packages/*`.

## Rules

- Consult `examples/next/patterns/README.md` before app/page/API/server-action work.
- App Router code lives in `examples/next/app`; see nested `AGENTS.md` files.
- App-owned backend/domain/services remain in root `lib/*` for now; they are not public SDK.
- Use `pnpm --filter @yolk-example/next check` when touching example config/app code.
- Use `pnpm --filter @yolk-example/next build` after routing/config changes.
- Do not publish this workspace.

## Commands

- Dev: `pnpm dev:app`
- Typecheck: `pnpm --filter @yolk-example/next check`
- Build: `pnpm --filter @yolk-example/next build`
