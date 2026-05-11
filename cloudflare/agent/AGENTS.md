# Cloudflare Agent

Cloudflare app for the future Yolk durable agent runtime.

## Rules

- Use Alchemy for Cloudflare resources and bindings.
- Follow Alchemy style: relative TypeScript imports include explicit `.ts` extensions.
- Keep Cloudflare-specific code here, not in `packages/*`.
- Keep `@yolk/*` packages provider/runtime-neutral.
- Use faux provider until Cloudflare DO + persistence path is proven.
- Prefer typed protocol events over app-local render models.
- Persist protocol transcripts only.

## Checks

- Run `pnpm cloudflare:check` after touching this app.
- Run root `pnpm tsc`, `pnpm lint`, and `pnpm test:run` before finishing larger changes.
