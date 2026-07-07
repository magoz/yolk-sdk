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
rm -rf examples/next/.next
pnpm tsc
```

Only remove generated output, never source files. Remove root `.next` only if it was accidentally generated.

## GitHub Action publishes wrong tag

Check:

- `.changeset/pre.json`
- workflow_dispatch input tag
- current package versions

If uncertain, stop and ask before rerunning publish.

## Package accidentally still private

Symptom: GitHub Action omits a public package from the publish set or npm refuses the tarball as private.

Fix:

- Public `packages/*` should be publishable.
- Keep private workspaces private and ignored.

## npm auth/provenance fails

Check:

- package availability: `npm view @yolk-sdk/agent`
- CI OIDC permissions: `id-token: write`
- npm trusted publisher settings for `magoz/yolk-sdk`, workflow `publish.yml`
- current workflow sets `NPM_CONFIG_PROVENANCE=false`; do not flip without updating npm/package support

## New package publish returns npm 404

Symptom: existing packages publish, then a renamed/new scoped package fails with `npm error 404 Not Found - PUT ...`.

Cause: npm treats missing package + insufficient org/package publish permission as 404.

Fix:

- If the package does not exist yet, first publish only that package locally from a packed tarball with interactive npm auth/OTP.
- Then configure trusted publishing: `npm trust github @yolk-sdk/<name> --repo magoz/yolk-sdk --file publish.yml --allow-publish`.
- Treat earlier `+ @yolk-sdk/*@version` lines as published; do not rerun the same version outside the workflow retry.
- Rerun the same workflow; it skips already-published tarballs and creates the missing tag.
- If retry guard is unavailable, bump all public packages to the next canary first.

## Existing package lacks trusted publisher

Symptom: workflow publishes some packages, then fails with npm 404/permission for an existing package.

Cause: package exists, but npm trusted publishing is not configured for `magoz/yolk-sdk` + `publish.yml`.

Fix:

- Do not bump versions again if no git tag was created.
- Configure trust with npm auth/2FA:

```bash
npm trust github @yolk-sdk/<name> \
  --repo magoz/yolk-sdk \
  --file publish.yml \
  --allow-publish \
  --yes
```

- Example: `npm trust github @yolk-sdk/sandbox --repo magoz/yolk-sdk --file publish.yml --allow-publish --yes`.
- Rerun the same workflow; already-published tarballs are skipped.
- Verify all dist-tags and `v<version>` after rerun.

## Release prep includes unrelated files

Cause: working tree had feature, env, generated, or local-only changes before release prep.

Fix:

- Stop before committing.
- Inspect `git status` and diffs.
- Commit only release files: package versions, changelogs, lockfile, `.changeset/pre.json`, and intentional release workflow/docs changes.
- Never commit env files or generated outputs.
- Ask user to approve the exact commit scope.

## Action says no new packages

Cause: package versions already exist on npm, or `pnpm changeset:version` produced no bump. If `v<version>` is missing, the same workflow can still repair the tag.

Fix:

- Check pending `.changeset/*.md` before versioning.
- Check package versions vs npm dist-tags.
- If this is missing-tag repair, rerun the same workflow and do not bump versions.
- Add/repair changeset release notes, run version prep again, validate, commit, push, rerun action.

## npm 403 cannot publish over existing version

Cause: GitHub Action tried to publish a package version that already exists on npm. Current workflow skips these tarballs; treat this as a guard regression or legacy run.

Most common cause: pushed only a `.changeset/*.md`, then ran action without `pnpm changeset:version` output committed.

Fix:

- Run `pnpm changeset:version`.
- Confirm public packages bumped to a new unpublished version.
- Confirm changelog entries generated.
- Validate, commit, push, rerun action.
- Update skill/workflow if agent ever advised running action before version bump commit.

## Publish succeeded but tag failed

Cause: workflow could not write tags or tag already exists.

Fix:

- Check `contents: write` in `.github/workflows/publish.yml`.
- Check whether `v<version>` already exists.
- If publish succeeded and tag is missing, rerun the same workflow; already-published tarballs are skipped and the tag is created.
