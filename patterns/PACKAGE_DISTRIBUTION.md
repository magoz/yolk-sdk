# Package Distribution

Plan for publishing `packages/*` as public npm packages under the `@yolk-sdk/*` scope.

## Reference Model

Use the Effect repository as the primary distribution model:

- pnpm workspaces for membership and version linking.
- Turbo for task orchestration/cache/order.
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

The first public canary should be `0.0.1-canary.0`.

Current Changesets config:

```json
{
  "fixed": [["@yolk-sdk/agent", "@yolk-sdk/react", "..."]],
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

Use SemVer for all package versions. Before `1.0.0`, treat `0.x` as unstable: breaking changes may land in minor releases, while patch releases should stay fixes/small compatible changes when practical. After `1.0.0`, follow normal SemVer strictly: patch = compatible fix, minor = compatible feature, major = breaking change.

Current release channel is `canary`. Consumers install canaries with npm dist-tag syntax:

```bash
pnpm add @yolk-sdk/agent@canary
```

## Turbo Boundary

Turbo is present for task orchestration/cache/order only.

- `pnpm-workspace.yaml` owns workspace membership, catalogs, lockfile, and `workspace:^` links.
- `turbo.json` owns task dependency order and cache outputs.
- Package publish scripts still use pnpm filters where direct package fan-out is simpler.
- Do not move package membership/version policy into Turbo config.

## Publish Shape

Packages keep source exports for local workspace/dev use:

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
  "files": ["src/**/*.ts", "dist/**/*", "README.md"],
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

Current canary policy: keep runtime libraries in package `dependencies` unless singleton identity matters at runtime. This makes first canary installs simpler and avoids peer-resolution friction while APIs are unstable.

Host-owned singletons to revisit before stable releases:

- `effect`: peer for publishable packages that expose Effect services/types.
- `react`: peer for `@yolk-sdk/react`.
- `workflow`: peer for `@yolk-sdk/vercel-workflows-runtime` if published.

Current exception: `@yolk-sdk/react` keeps `react` as a peer now. Keep platform-specific deps behind explicit subpaths.

## First Canary Package Set

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

## Actual npm Publish Flow

First canary/manual publish flow:

```bash
pnpm changeset:canary:enter
pnpm changeset:version
```

Verify every public package got the same canary version. Then run full validation before publishing:

```bash
pnpm packages:build
pnpm packages:publint
pnpm packages:smoke
pnpm packages:check
pnpm cloudflare:check
pnpm tsc
pnpm lint
pnpm test:run
```

Public `packages/*` manifests are publishable. Do not remove `private: true` from private app packages such as `@yolk-sdk/cloudflare-agent`.

Verify `git status` is clean/understood, then publish canary only after explicit approval:

```bash
pnpm release:canary
```

Verify npm after publish:

```bash
npm view @yolk-sdk/agent version
npm view @yolk-sdk/agent dist-tags
```

Requirements:

- npm logged in as `magoz`.
- `@yolk-sdk` org exists and `magoz` is owner.
- package names are available or already owned by `@yolk-sdk`.
- all public package versions are lockstep.
- no dirty/unclear release state.

Use the `/package-release` command after restarting opencode for guided release workflow.

## Automation Plan

Automate releases later with GitHub Actions + Changesets, mirroring Effect and MCP SDK.

Recommended workflow:

- trigger on push to `main`
- use `changesets/action`
- version command: `pnpm changeset:version && pnpm install --no-frozen-lockfile`
- publish command: validation + canary/stable publish script
- permissions include `contents: write`, `pull-requests: write`, and `id-token: write`
- npm provenance/trusted publishing enabled
- optional snapshot workflow later, AI SDK-style

Manual first canary is acceptable; automate after the flow proves correct once.

## Release Prep Order

1. Freeze public API surface.
   - Review every exported symbol.
   - Keep test helpers behind `./testing`.
   - Hide or defer unstable APIs.
2. Normalize manifests.
   - Done for public packages: description, license, repository directory, engines, keywords, `files`, `publishConfig`.
3. Add build output.
   - Done: `tsdown` emits `dist` JS and declarations; npm exports use `publishConfig.exports`.
4. Add release tooling.
   - Done: Changesets fixed group and package build/check/publint/smoke scripts.
   - Enter canary mode with `pnpm changeset:canary:enter` before first versioning.
5. Add docs.
   - Root package overview.
   - Per-package README.
   - Install/import examples.
   - Host-owned responsibility notes.
6. Validate artifacts.
   - `pnpm packages:check`
   - `pnpm packages:build`
   - `pnpm packages:publint`
   - `pnpm packages:smoke`
   - `pnpm tsc`
   - `pnpm lint`
   - `pnpm test:run`
   - clean fixture install from packed tarballs
7. Publish canary.
   - Public `packages/*` are publishable; private apps stay private.
   - Publish with provenance.
   - Treat canary as feedback, not stability.

## Open Questions

- none
