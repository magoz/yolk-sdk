# Changesets

Canary release prep:

1. `pnpm changeset:canary:enter`
2. `pnpm changeset:version`
3. `pnpm install --lockfile-only`
4. verify all public packages got same canary version
5. validate artifacts and repo checks:
   - `pnpm packages:build`
   - `pnpm packages:publint`
   - `pnpm packages:smoke`
   - `pnpm packages:check`
   - `pnpm cloudflare:check`
   - `pnpm tsc`
   - `pnpm lint`
   - `pnpm test:run`
6. verify public `packages/*` are publishable and private apps stay private
7. verify `git status` is clean/understood
8. commit/push release prep after approval
9. run GitHub Actions → `Publish packages` from `main`
10. verify npm and tag:
    - `npm view @yolk-sdk/agent version`
    - `npm view @yolk-sdk/agent dist-tags`
    - `git tag --list 'v*' --sort=-v:refname | head -n 1`

Canary versions stay lockstep across every public `@yolk-sdk/*` package.

Use `/package-release` after restarting opencode for guided release steps.
