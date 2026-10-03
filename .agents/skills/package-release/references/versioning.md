# Versioning

## Policy

Yolk uses SemVer plus Changesets.

Public packages are lockstep/fixed:

```txt
@yolk-sdk/agent
@yolk-sdk/mcp
@yolk-sdk/knowledge
@yolk-sdk/connectors
@yolk-sdk/sandbox
@yolk-sdk/vercel-workflows
@yolk-sdk/harness
@yolk-sdk/conformance
@yolk-sdk/emulators
@yolk-sdk/codemode
@yolk-sdk/extractors
```

All public packages share one version, even if only one package changed.

## Current prerelease

Default release channel is canary.

Current release line:

```txt
0.1.0-canary.x
```

Canary install example:

```bash
pnpm add @yolk-sdk/agent@canary
```

## SemVer interpretation

Yes: Yolk package releases use SemVer.

Before `1.0.0`:

- `0.x` is unstable.
- Breaking changes may land in minor bumps.
- Patch means bugfix/small compatible change when possible.

After `1.0.0`:

- `patch`: compatible bugfix.
- `minor`: compatible feature.
- `major`: breaking change.

## Changesets config

Expected `.changeset/config.json` traits:

```json
{
  "fixed": [["@yolk-sdk/agent", "@yolk-sdk/mcp", "..."]],
  "updateInternalDependencies": "patch",
  "ignore": ["@yolk-sdk/cloudflare-agent"],
  "access": "public",
  "privatePackages": false
}
```

## Changeset rules

- Add changesets for public API/runtime/package changes.
- Add changesets in the feature PR that introduces the user-facing package change.
- Do not version packages in feature PRs; release PRs consume pending changesets.
- Include all public packages for lockstep canaries when preparing a broad SDK release.
- Use patch for canaries unless user requests otherwise.
- Do not include private Cloudflare package.
- Keep changeset text user-facing and concise.
- Changesets become npm-shipped `CHANGELOG.md` text: never name private apps (`examples/*`,
  `cloudflare/*`, `apps/*`) or internal app paths. Describe the package behavior instead.
- A new package's first changeset describes current behavior, not deltas ("now", "no longer",
  "replaces the old …"): its users have no previous version to compare against.
- Write release notes before `pnpm changeset:version`; generated changelogs inherit this text.
- Fixed-group lockstep notes: when a release would bump fixed-group packages that have no pending
  changeset, add `.changeset/canary-<n>-lockstep.md` (`<n>` is the upcoming canary number) with a
  `patch` entry for each of them and one note saying they advance in lockstep with no direct
  changes, naming what did change. Otherwise their changelogs get a version entry with no release note (at most "Updated
  dependencies").
  Precedents: `canary-96-lockstep.md`, `canary-98-lockstep.md`. Check coverage with the pending
  changesets' front matter against the `fixed` group in `.changeset/config.json`.

## Release-note source

Use the parent's shared comparison base/target from [package-release](../SKILL.md).
For the default release scope, inspect history since the latest reachable release tag:

```bash
git fetch --tags
target=$(git rev-parse HEAD)
base=$(git describe --tags --match 'v[0-9]*' --abbrev=0 "$target" 2>/dev/null || true)
if [ -n "$base" ]; then
  git log --oneline "${base}..${target}"
  git diff --stat "${base}..${target}" -- packages
else
  printf '%s\n' 'No reachable release tag; establish an explicit comparison base before auditing.'
fi
```

If no tag is reachable, use the previous release-prep commit or agree an explicit initial-release
scope. Audit children use the supplied SHAs; they do not fetch tags or select a different base.

## Release PR rules

- Release PRs are generated release bookkeeping only.
- Include package version bumps, changelogs, lockfile updates, and prerelease state.
- Exclude feature code and unrelated cleanup.
- Publish only via GitHub Actions after release prep lands on `main`.

## Version prep commands

Canary prerelease mode should already exist for canary releases. If missing and user wants canary:

```bash
pnpm changeset:canary:enter
```

Consume changesets and bump package manifests/changelogs:

```bash
pnpm changeset:version
```

This command must run before GitHub Actions publish. A changeset file alone does not change package versions. `pnpm changeset:version` already runs `pnpm install --lockfile-only` in this repo.

Required generated output:

- each public `packages/*/package.json` version increments lockstep
- each public package changelog gets the release note
- consumed changeset id appears in `.changeset/pre.json`

If output does not include package version bumps, stop and do not run publish action.

After GitHub Action publish, expect tag `v<version>` for future release-note diffs.

Stable release requires explicit approval, then exit prerelease mode first:

```bash
pnpm changeset:canary:exit
pnpm changeset:version
```

## Channels

Recommended phases:

1. `canary`: active iteration, breakage allowed.
2. optional `alpha` / `beta`: staged external testing.
3. `0.x` stable-ish: cleaner installs, still pre-1.0 unstable.
4. `1.0.0`: compatibility commitment.
