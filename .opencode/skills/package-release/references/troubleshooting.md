# Troubleshooting

## `pnpm packages:smoke` fails on missing internal package

Cause: packed package depends on unpublished internal `@yolk-sdk/*`.

Fix:

- Ensure smoke fixture installs/extracts all local tarballs.
- Ensure Changesets rewrites internal `workspace:^` ranges during versioning.
- For pre-version smoke, account for `0.0.0` local packages.

## `publint` fails on exports

Common causes:

- `types` order wrong.
- export points to missing `dist` file.
- `.d.mts` / `.mjs` mismatch.
- `publishConfig.exports` differs from build output.

Fix manifest exports, rebuild, rerun publint.

## Runtime import fails after pack

Cause: missing package dependency.

Fix:

- Add runtime dependency to the package `dependencies`.
- Do not rely on root dev dependencies.
- Re-run `pnpm install`, build, smoke, and checks.

Example found during setup: `@yolk-sdk/mcp/client/node` needed `@effect/platform-node` as a dependency.

## `pnpm tsc` sees stale `.next` errors

Cause: stale generated Next types.

Fix:

```bash
rm -rf .next
pnpm tsc
```

Only remove generated output, never source files.

## GitHub Action publishes wrong tag

Check:

- `.changeset/pre.json`
- workflow_dispatch input tag
- current package versions

If uncertain, stop and ask before rerunning publish.

## Package accidentally still private

Symptom: `changeset publish` skips package.

Fix:

- Public `packages/*` should be publishable.
- Keep private app packages private and ignored.

## npm auth/provenance fails

Check:

- package availability: `npm view @yolk-sdk/agent`
- CI OIDC permissions: `id-token: write`
- npm trusted publisher settings for `magoz/yolk-sdk`, workflow `publish.yml`
- current workflow sets `NPM_CONFIG_PROVENANCE=false`; do not flip without updating npm/package support

## Release prep includes unrelated files

Cause: working tree had feature, env, generated, or local-only changes before release prep.

Fix:

- Stop before committing.
- Inspect `git status` and diffs.
- Commit only release files: package versions, changelogs, lockfile, `.changeset/pre.json`, and intentional release workflow/docs changes.
- Never commit env files or generated outputs.
- Ask user to approve the exact commit scope.

## Action says no new packages

Cause: package versions already exist on npm, or `pnpm changeset:version` produced no bump.

Fix:

- Check pending `.changeset/*.md` before versioning.
- Check package versions vs npm dist-tags.
- Add/repair changeset release notes, run version prep again, validate, commit, push, rerun action.
