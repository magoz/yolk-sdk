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
- Write release notes before `pnpm changeset:version`; generated changelogs inherit this text.

## Release-note source

Prefer writing changeset notes from git history since last release tag:

```bash
git fetch --tags
base=$(git tag --list 'v*' --sort=-v:refname | head -n 1)
if [ -n "$base" ]; then
  git log --oneline "${base}..HEAD"
  git diff --stat "${base}..HEAD" -- packages
else
  git log --oneline -20
fi
```

If no tags exist yet, use the previous `prepare canary release` commit as base and note that tags start after next publish.

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
