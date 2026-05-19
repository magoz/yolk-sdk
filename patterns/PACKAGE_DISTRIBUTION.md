# Package Distribution

Plan for publishing `packages/*` as public npm packages under the `@yolk-sdk/*` scope.

## Reference Model

Use the Effect repository as the primary distribution model:

- pnpm workspaces, no Turbo by default.
- Changesets for versioning and release notes.
- Fixed/lockstep versions for every public package.
- Source exports for local development.
- `publishConfig.exports` points npm consumers at built `dist` files.
- Explicit `files`, package metadata, provenance, and artifact checks before publish.

Use the AI SDK repository as a secondary reference for package hygiene:

- Clean `dist` exports.
- `publint` validation.
- Per-package README examples.
- Host-framework peer deps.

Do not copy AI SDK's independent versioning unless Yolk packages become independently useful and stable.

## Versioning Policy

Yolk packages should release in lockstep.

Use canary releases for initial public distribution. Canary communicates fast-moving APIs and matches the AI SDK prerelease style. Reserve `alpha`/`beta` for curated stability milestones if needed later.

Planned Changesets config:

```json
{
  "fixed": [["@yolk-sdk/*"]],
  "updateInternalDependencies": "patch",
  "access": "public",
  "privatePackages": false
}
```

Rationale:

- `@yolk-sdk/agent` protocol, loop, runtime, client, tools, React, MCP, and related packages are tightly coupled.
- Users should not debug package version skew.
- Early APIs will move quickly.
- Docs can say: install matching `@yolk-sdk/*` versions.

Keep internal dependencies as `workspace:^`; Changesets rewrites publish ranges.

## Turbo Decision

Do not add Turborepo yet.

Current pnpm scripts are enough:

- package count is small.
- no CI/CD task graph exists yet.
- package publishing blockers are API, docs, metadata, and artifact validation, not orchestration.
- Turbo adds config and cache invalidation surface before we need it.

Reconsider Turbo when one of these is true:

- package checks/builds are slow enough to hurt iteration.
- CI needs affected-only package jobs.
- remote caching would save real time.
- package/app graph becomes hard to run with pnpm recursive scripts.

Until then, prefer pnpm recursive/filter scripts.

## Publish Shape

While private, packages may keep source exports:

```json
{
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  }
}
```

For npm, keep local dev source exports but publish `dist` via `publishConfig.exports`, Effect-style:

```json
{
  "files": ["src/**/*.ts", "dist/**/*", "README.md", "CHANGELOG.md"],
  "publishConfig": {
    "access": "public",
    "provenance": true,
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "import": "./dist/index.js",
        "default": "./dist/index.js"
      }
    }
  }
}
```

Use explicit subpath exports only. Keep roots tiny.

## Build Tooling

Use `tsdown` for publish prep unless a concrete package needs something else.

Requirements:

- ESM only.
- `.d.ts` output.
- no bundled peer deps.
- source maps optional.
- package-local `build`, `check`, and `test:run` scripts stay consistent.

## Dependency Policy

Model host-owned singletons as peers:

- `effect`: peer for publishable packages that expose Effect services/types.
- `react`: peer for `@yolk-sdk/react`.
- `workflow`: peer for `@yolk-sdk/vercel-workflows-runtime` if published.

Keep package-local dev deps for tests/builds. Keep platform-specific deps behind explicit subpaths.

## First Alpha Candidate Set

Publish all packages in the first public canary:

- `@yolk-sdk/agent`
- `@yolk-sdk/react`
- `@yolk-sdk/mcp`
- `@yolk-sdk/rag`
- `@yolk-sdk/knowledge`
- `@yolk-sdk/oauth`
- `@yolk-sdk/openai`
- `@yolk-sdk/anthropic`
- `@yolk-sdk/vercel-workflows-runtime`
- `@yolk-sdk/skillset`
- `@yolk-sdk/voice-runtime`

Rationale: lockstep versions are simpler when every workspace package is public. Unstable packages should document instability in README rather than staying private.

## Package Metadata Decisions

- License: `MIT`.
- npm scope: `@yolk-sdk/*`.
- npm org access: confirmed; `magoz` is owner.
- Node engine: `>=22`.
- Prerelease npm tag: `canary`.
- Include source in npm tarballs: yes.
- Publish all packages with provenance enabled.

## Release Prep Order

1. Freeze public API surface.
   - Review every exported symbol.
   - Keep test helpers behind `./testing`.
   - Hide or defer unstable APIs.
2. Normalize manifests.
   - Add description, license, repository directory, engines, keywords.
   - Add explicit `files`.
   - Add `publishConfig` with provenance.
3. Add build output.
   - Add `tsdown`.
   - Emit `dist` JS and declarations.
   - Publish `dist` exports.
4. Add release tooling.
   - Add Changesets fixed group.
   - Add package build/check/publint scripts.
   - Add publish dry-run script.
5. Add docs.
   - Root package overview.
   - Per-package README.
   - Install/import examples.
   - Host-owned responsibility notes.
6. Validate artifacts.
   - `pnpm packages:check`
   - `pnpm tsc`
   - `pnpm lint`
   - `pnpm test:run`
   - `publint`
   - clean fixture install from packed tarballs
7. Publish canary.
   - Remove `private: true` only after artifact validation.
   - Publish with provenance.
   - Treat canary as feedback, not stability.

## Open Questions

Answer before implementation:

- Package renaming/import migration timing?
