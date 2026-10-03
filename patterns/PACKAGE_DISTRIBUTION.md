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
  "fixed": [
    [
      "@yolk-sdk/agent",
      "@yolk-sdk/connectors",
      "@yolk-sdk/knowledge",
      "@yolk-sdk/mcp",
      "@yolk-sdk/sandbox",
      "@yolk-sdk/vercel-workflows",
      "@yolk-sdk/harness",
      "@yolk-sdk/conformance",
      "@yolk-sdk/emulators",
      "@yolk-sdk/codemode",
      "@yolk-sdk/extractors"
    ]
  ],
  "updateInternalDependencies": "patch",
  "ignore": ["@yolk-sdk/cloudflare-agent"],
  "access": "public",
  "privatePackages": false
}
```

Rationale:

- Agent APIs and the sibling MCP, connectors, knowledge, sandbox, and Workflow packages are tightly coupled.
- Users should not debug package version skew.
- Early APIs will move quickly.
- Docs can say: install matching `@yolk-sdk/*` versions.

Keep internal dependencies as `workspace:^`; Changesets rewrites publish ranges.

Use SemVer for all package versions. Before `1.0.0`, treat `0.x` as unstable: breaking changes may land in minor releases, while patch releases should stay fixes/small compatible changes when practical. After `1.0.0`, follow normal SemVer strictly: patch = compatible fix, minor = compatible feature, major = breaking change.

Current release channel is `canary`. Consumers install canaries with npm dist-tag syntax:

```bash
pnpm add @yolk-sdk/agent@canary
```

Until the first stable release, npm `latest` also points at the newest canary on every public
package. An untagged install (`pnpm add @yolk-sdk/agent`) then resolves to the same lockstep
version as `@canary`, instead of an old canary that mixes versions with newer packages. The
workflow publishes canaries with `--tag canary` only, so moving `latest` is a manual post-publish
step (see [Move `latest` to the new canary](#move-latest-to-the-new-canary)). npm does not let you
delete `latest`, and it assigns `latest` to a brand-new package's first version.

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
        "types": "./dist/index.d.mts",
        "import": "./dist/index.mjs",
        "default": "./dist/index.mjs"
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
- `.d.mts` declaration output.
- no bundled peer deps.
- source maps optional.
- package-local `build`, `check`, and `test:run` scripts stay consistent.

Exception: `@yolk-sdk/extractors` also builds `dist/node/extraction-worker.mjs` as one
self-contained file (its dependencies inlined, the optional `xlsx` peer left as a dynamic
import). It runs in its own worker thread, so Effect identity does not matter there, and hosts
only have to ship that file and `xlsx` (ADR 0004).

## Dependency Policy

Current canary policy: keep runtime libraries in package `dependencies` unless singleton identity matters at runtime. This makes first canary installs simpler and avoids peer-resolution friction while APIs are unstable.

Host-owned singletons/platform deps to revisit before stable releases:

- `effect`: peer for publishable packages that expose Effect services/types.
- `react`: optional peer for `@yolk-sdk/agent/react`.
- `workflow`: current dependency for `@yolk-sdk/vercel-workflows`; revisit peer if host version skew matters.

Current exceptions:

- `@yolk-sdk/agent` keeps `react` as an optional peer for the `./react` subpath.
- `@yolk-sdk/extractors` keeps SheetJS (`xlsx`, `>=0.20.3`) as an optional peer, loaded lazily by
  `./node` only when an XLSX file is extracted. Fixed SheetJS releases ship only as a tarball from
  `cdn.sheetjs.com` (npm `xlsx` stops at the vulnerable 0.18.5), and a published package must not
  depend on a URL. Consumers install `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`; the
  workspace installs the same tarball as a dev dependency (see `docs/adr/0004-extractors-package.md`).

Keep platform-specific deps behind explicit subpaths.

## Public Package Set

Publish all public packages together:

- `@yolk-sdk/agent`
- `@yolk-sdk/mcp`
- `@yolk-sdk/knowledge`
- `@yolk-sdk/connectors`
- `@yolk-sdk/sandbox`
- `@yolk-sdk/vercel-workflows`
- `@yolk-sdk/harness`
- `@yolk-sdk/conformance` (experimental)
- `@yolk-sdk/emulators` (experimental)
- `@yolk-sdk/codemode`
- `@yolk-sdk/extractors`

Rationale: lockstep versions are simpler when every public `packages/*` package is published together. Private app workspaces stay private; unstable public packages document instability in README.

## Package Metadata Decisions

- License: `MIT`.
- npm scope: `@yolk-sdk/*`.
- npm org access: confirmed; `magoz` is owner.
- Node engine: `>=22` (`@yolk-sdk/codemode`: `>=22.19.0`).
- Prerelease npm tag: `canary`.
- Include source in npm tarballs: yes.
- Provenance: the publish Action publishes with `--provenance` (public repo, GitHub-hosted runner, `id-token: write`). Every manifest's `repository.url` must stay `git+https://github.com/magoz/yolk-sdk.git`; npm rejects provenance whose source repo does not match. Local publishes cannot produce an attestation and use `--provenance=false`.

## Actual npm Release Prep

Canary prep flow:

```bash
# if not already in canary prerelease mode
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
pnpm format:check
pnpm test:run
pnpm --filter @yolk-sdk/vercel-workflows test:workflow
```

Public `packages/*` manifests are publishable. Keep private workspaces such as `examples/next` and `cloudflare/agent` private/ignored.

Verify `git status` is clean/understood. Normal publish path is GitHub Actions after merged version-prep commit, not local publish. The Action validates versions/tags, publishes with npm CLI, then creates `v<version>`.

Local publish is emergency-only. Require explicit approval, a clean checkout of the merged release
commit on `main`, and a recorded reason, commit SHA, package/version set, and approver:

```bash
release_dir="$(mktemp -d)"
pnpm packages:build
pnpm -r --filter './packages/*' pack --pack-destination "$release_dir"
for tarball in "$release_dir"/*.tgz; do
  npm publish "$tarball" --tag canary --access public --provenance=false
done
```

Use npm for the registry operation. Emergency local publishes are intentionally unprovenanced; a
local run cannot produce the GitHub Actions attestation, and the manifests' `provenance: true`
would otherwise make the local publish fail. After publishing,
rerun `.github/workflows/publish.yml` as an all-published/missing-tag repair so it validates the
release commit and creates `v<version>`.

Verify npm after publish:

```bash
for package in \
  @yolk-sdk/agent \
  @yolk-sdk/mcp \
  @yolk-sdk/knowledge \
  @yolk-sdk/connectors \
  @yolk-sdk/sandbox \
  @yolk-sdk/vercel-workflows \
  @yolk-sdk/harness \
  @yolk-sdk/conformance \
  @yolk-sdk/emulators \
  @yolk-sdk/codemode \
  @yolk-sdk/extractors; do
  npm view "$package" dist-tags --json
done
git fetch --tags
git tag --list "v<version>"
git ls-remote --tags origin "refs/tags/v<version>"
```

For lockstep canaries, verify every public package has the new `canary` dist-tag and `v<version>` exists locally and on origin.

### Move `latest` to the new canary

While no stable version exists, after the publish is verified, point `latest` at the new canary on
every public package. This is an owner action with npm account auth; one OTP usually covers all
commands if they run back to back:

```bash
version=<version>
for package in agent mcp knowledge connectors sandbox vercel-workflows harness conformance emulators codemode extractors; do
  npm dist-tag add "@yolk-sdk/$package@$version" latest --otp=<code>
done
```

Then confirm every package reports the same `latest` and `canary`. Stop doing this once a stable
version exists; the workflow then publishes stable versions with `latest` itself.

Requirements:

- `@yolk-sdk` org exists and `magoz` is owner.
- package names are available or already owned by `@yolk-sdk`.
- all public package versions are lockstep.
- no dirty/unclear release state.

Local npm login as `magoz` is required only for approved local first-publish or emergency-publish exceptions.

Use the `package-release` skill for the guided release workflow.

## GitHub Actions Publish

`.github/workflows/publish.yml` runs manually from `main`.
The workflow fails immediately when dispatched against any other ref.

Requirements before dispatch:

- changesets consumed by `pnpm changeset:version`
- every public package has same version
- the requested npm dist-tag matches the version channel (`canary` for prereleases, `latest` for stable versions)
- `v<version>` tag does not exist
- normal publishes have at least one unpublished public package; all-published runs are only for missing-tag repair
- validation passes: package build/publint/smoke/check, Cloudflare check, `pnpm tsc`, `pnpm lint`, `pnpm format:check`, `pnpm test:run`, and `pnpm --filter @yolk-sdk/vercel-workflows test:workflow`

The Action publishes canaries with npm tag `canary` and stable versions with `latest`, then creates annotated git tag `v<version>`. It skips already-published tarballs so partial failures can be retried. It publishes with `--provenance`, so each Action-published version carries an npm provenance attestation; versions published locally (first publish or emergency) have none.

## New Package First Publish

Trusted publishing can only be configured after a package exists on npm. For a renamed/new `@yolk-sdk/*` package, the first publish is the only approved local publish exception.

Pending first publish: `@yolk-sdk/conformance`, `@yolk-sdk/emulators`, `@yolk-sdk/codemode`, and `@yolk-sdk/extractors` still need the local first publish and trusted-publisher setup below, done by the owner.

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

Rerun `.github/workflows/publish.yml` from `main`. The workflow skips already-published tarballs and creates the missing `v<version>` tag. Verify all package dist-tags; npm assigns `latest` to the first version of a brand-new package even when `--tag canary` is used, which matches the canary-only `latest` policy above.

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
   - Confirm canary prerelease mode exists; enter it before first canary versioning.
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
   - `pnpm format:check`
   - `pnpm test:run`
   - `pnpm --filter @yolk-sdk/vercel-workflows test:workflow`
   - clean fixture install from packed tarballs
7. Publish canary via GitHub Actions.
   - Public `packages/*` are publishable; private apps stay private.
   - The Action publishes with provenance; keep `repository.url` matching `magoz/yolk-sdk`.
   - Treat canary as feedback, not stability.

## Open Questions

- none
