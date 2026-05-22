# Versioning

## Policy

Yolk uses SemVer plus Changesets.

Public packages are lockstep/fixed:

```txt
@yolk-sdk/*
```

All public packages share one version, even if only one package changed.

## Current prerelease

Default release channel is canary.

First intended version:

```txt
0.0.1-canary.0
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
  "fixed": [["@yolk-sdk/agent", "@yolk-sdk/react", "..."]],
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
- Include all public packages for first canary.
- Use patch for canary bootstrap unless user requests otherwise.
- Do not include private Cloudflare package.
- Keep changeset text user-facing and concise.

## Release PR rules

- Release PRs are generated release bookkeeping only.
- Include package version bumps, changelogs, lockfile updates, and prerelease state.
- Exclude feature code and unrelated cleanup.
- Publish only after the release PR merges to `main`.

## Channels

Recommended phases:

1. `canary`: active iteration, breakage allowed.
2. optional `alpha` / `beta`: staged external testing.
3. `0.x` stable-ish: cleaner installs, still pre-1.0 unstable.
4. `1.0.0`: compatibility commitment.
