# Knowledge Domain

App-owned knowledge use-cases and agent context helpers.

## Role

- Compose `@yolk/knowledge` contracts with app services, auth, and policy.
- Keep reusable models in `packages/knowledge`.
- Keep DB/R2 concrete adapters in `lib/services/knowledge`.

## Current scope

- Pinned knowledge context loading for text agents.
- User-owned v0: scope id maps to authenticated `userId`.

## Boundaries

- Domain helpers return Effect values; do not run effects inside helpers.
- No provider SDKs or raw env access here.
- UI/server actions belong in separate `*-action.ts` files when added.
