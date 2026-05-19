# Changesets

Canary release flow:

1. `pnpm changeset:canary:enter`
2. `pnpm changeset:version`
3. remove `private: true` from public package manifests when ready
4. `pnpm release:canary`

First canary version should be `0.0.1-canary.0`.
