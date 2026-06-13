# Package Distribution

Distribution policy for `packages/*` public npm packages under the `@yolk-sdk/*` scope.

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

The first public canary was `0.0.1-canary.0`. Future canaries continue lockstep prerelease versions.

Current Changesets config:

```json
{
  "fixed": [["@yolk-sdk/agent", "@yolk-sdk/mcp", "..."]],
  "updateInternalDependencies": "patch",
  "access": "public",
  "privatePackages": false
}
```

Rationale:

- `@yolk-sdk/agent` protocol, loop, runtime, client, tools, React, providers, MCP, connectors, and related packages are tightly coupled.
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
- `react`: optional peer for `@yolk-sdk/agent/react`.
- `workflow`: peer for `@yolk-sdk/vercel-workflows` if published.

Current exception: `@yolk-sdk/agent` keeps `react` as an optional peer for the `./react` subpath. Keep platform-specific deps behind explicit subpaths.

## Public Package Set

Publish all public packages together:

- `@yolk-sdk/agent`
- `@yolk-sdk/mcp`
- `@yolk-sdk/knowledge`
- `@yolk-sdk/connectors`
- `@yolk-sdk/vercel-workflows`

Rationale: lockstep versions are simpler when every workspace package is public. Unstable packages should document instability in README rather than staying private.

## Package Metadata Decisions

- License: `MIT`.
- npm scope: `@yolk-sdk/*`.
- npm org access: confirmed; `magoz` is owner.
- Node engine: `>=22`.
- Prerelease npm tag: `canary`.
- Include source in npm tarballs: yes.
- Package manifests keep provenance-ready metadata; workflow disables provenance while the repo is private.

## Actual npm Release Prep

Canary prep flow:

```bash
pnpm changeset:canary:enter
pnpm changeset:version
```

`pnpm changeset:version` already runs `pnpm install --lockfile-only` in this repo.

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

Verify `git status` is clean/understood. Normal publish path is GitHub Actions after merged version-prep commit, not local publish. The Action validates versions/tags, publishes with npm CLI, then creates `v<version>`.

Local publish is emergency-only and requires explicit approval:

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

## GitHub Actions Publish

`.github/workflows/publish.yml` runs manually from `main`.

Requirements before dispatch:

- changesets consumed by `pnpm changeset:version`
- every public package has same version
- package version is not already fully published on npm; partial retries skip already-published tarballs
- `v<version>` tag does not exist
- validation passes: package build/publint/smoke/check, Cloudflare check, `pnpm tsc`, `pnpm lint`, `pnpm test:run`

The Action publishes canaries with npm tag `canary` and stable versions with `latest`, then creates annotated git tag `v<version>`. It skips already-published tarballs so partial failures can be retried. Provenance is disabled while the repo is private; re-enable it when source is public.

## New Package First Publish

Trusted publishing can only be configured after a package exists on npm. For a renamed/new `@yolk-sdk/*` package, the first publish is the only approved local publish exception.

Preconditions:

- release prep commit is already on `main`
- package version was validated with the full release checks
- `npm view @yolk-sdk/<name>` returns 404
- local `npm whoami` is `magoz`
- user explicitly approves local first publish

Create only the missing package from a packed tarball:

```bash
pnpm --filter @yolk-sdk/<name> build
pnpm --filter @yolk-sdk/<name> pack --pack-destination /tmp
npm publish /tmp/yolk-sdk-<name>-<version>.tgz \
  --tag canary \
  --access public \
  --provenance=false \
  --otp=<code>
```

Then configure npm trusted publishing for that package:

```bash
npm trust github @yolk-sdk/<name> \
  --repo magoz/yolk-sdk \
  --file publish.yml \
  --allow-publish
```

or npmjs.com → package → Settings → Trusted Publisher → GitHub Actions:

- Organization/user: `magoz`
- Repository: `yolk-sdk`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

Rerun `.github/workflows/publish.yml` from `main`. The workflow skips already-published tarballs and creates the missing `v<version>` tag. Verify all package dist-tags; npm may assign `latest` to the first version of a brand-new package even when `--tag canary` is used.

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
7. Publish canary via GitHub Actions.
   - Public `packages/*` are publishable; private apps stay private.
   - Keep provenance disabled while repo source is private.
   - Treat canary as feedback, not stability.

## Open Questions

- none
