# Changesets

Canary release prep:

1. if not already in canary prerelease mode: `pnpm changeset:canary:enter`
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
7. commit/push release prep after approval
8. run GitHub Actions → `Publish packages` from `main`
9. verify npm and tag:
   - `npm view @yolk-sdk/agent dist-tags`
   - `npm view @yolk-sdk/mcp dist-tags`
   - `npm view @yolk-sdk/knowledge dist-tags`
   - `npm view @yolk-sdk/connectors dist-tags`
   - `npm view @yolk-sdk/sandbox dist-tags`
   - `npm view @yolk-sdk/vercel-workflows dist-tags`
   - `git fetch --tags`
   - `git tag --list "v<version>"`
   - `git ls-remote --tags origin "refs/tags/v<version>"`

Canary versions stay lockstep across every public `@yolk-sdk/*` package.

Use the `package-release` skill for guided release steps.
