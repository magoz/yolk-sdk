# Changesets

Canary release flow:

1. `pnpm changeset:canary:enter`
2. `pnpm changeset:version`
3. verify all public packages got same canary version
4. validate artifacts and repo checks:
   - `pnpm packages:build`
   - `pnpm packages:publint`
   - `pnpm packages:smoke`
   - `pnpm packages:check`
   - `pnpm cloudflare:check`
   - `pnpm tsc`
   - `pnpm lint`
   - `pnpm test:run`
5. verify public `packages/*` are publishable and private apps stay private
6. verify `git status` is clean/understood
7. `pnpm release:canary`
8. verify npm:
   - `npm view @yolk-sdk/agent version`
   - `npm view @yolk-sdk/agent dist-tags`

First canary version should be `0.0.1-canary.0`.

Use `/package-release` after restarting opencode for guided release steps.
