# Troubleshooting

## Publish Action fails `pnpm format:check` on generated changelogs

Cause: `pnpm changeset:version` formats each changelog with its own formatter, which can rewrite
older entries (for example code-block quotes and semicolons) in a way `oxfmt` rejects. The Action's
Validate step runs `pnpm format:check` and stops before packing, so nothing is published.

Fix:

- Run `pnpm exec oxfmt packages/*/CHANGELOG.md` on the release-prep branch before validating.
- If the release PR already merged, land a formatting-only PR on `main`, then rerun the Action for
  the same version; no version bump is needed because nothing was published or tagged.

## Publish Action fails tests that passed locally

Cause: the Action validates on the Node version pinned in `.github/workflows/publish.yml`, which can
differ from your local Node. Runtime limits differ between versions; for example (canary.99), Node 22
overflowed `JSON.stringify` on nesting that Node 24 handles. The Validate step stops before packing, so
nothing is published or tagged.

Fix:

- Reproduce with the pinned version from the failing package, which uses the root Vitest install:
  `NODE_ENV=test npx -y node@<pin> ../../node_modules/vitest/vitest.mjs run` (add
  `--config vitest.workflow.config.ts` for the Workflow suite). Make the test independent of runtime
  limits (measure them in the test rather than hardcoding a size).
- Land the fix as a separate PR on `main`, then rerun the Action for the same version; no version
  bump is needed because nothing was published or tagged.

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

The publish workflow rejects `latest` for prerelease versions and `canary` for stable versions. If
uncertain, stop and ask before rerunning publish.

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
- provenance needs a public repo and GitHub-hosted runner; E422 "repository.url ... expected to match" means a manifest `repository.url` no longer matches `https://github.com/magoz/yolk-sdk`
- local first/emergency publishes must pass `--provenance=false`; manifests set `publishConfig.provenance: true`

## New package publish returns npm 404

Symptom: existing packages publish, then a renamed/new scoped package fails with `npm error 404 Not Found - PUT ...`.

Cause: npm treats missing package + insufficient org/package publish permission as 404.

Fix:

- If the package does not exist yet, first publish only that package locally from a packed tarball with interactive npm auth/OTP.
- Then configure trusted publishing: `npm trust github @yolk-sdk/<name> --repo magoz/yolk-sdk --file publish.yml --allow-publish`.
- Treat earlier `+ @yolk-sdk/*@version` lines as published (confirm with `npm view <pkg>@<version>`; a 404 may mean npm is still validating it, see Version published but not visible); do not rerun the same version outside the workflow retry.
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

## Version published but not visible (npm validation)

Symptom: the workflow (or `npm publish`) reports success, yet `npm view @yolk-sdk/<name>@<version>`
is 404 and consumers' installs fail to resolve it. A rerun of the same version fails with
`npm error 409 Conflict ... Cannot publish over previously staged version "<version>"`, although
the version is absent from `npm stage list`. The SKILL.md version check (`npm view ... versions`)
also lists such a version as unpublished.

Cause: npm holds each new version in a validation scan before it becomes public; the 409 usually
means the version is still being validated. Usually minutes, sometimes hours, and only some packages
of one release may be held: canary.117 `extractors` took about 20 minutes, canary.118 `extractors`
about 4 hours, canary.119 `extractors`, `mcp`, `sandbox` and `vercel-workflows` a few minutes each.

Check, as the owner (or an agent the owner allowed to use the npm token); keep the token out of the
command line, logs and PRs:

```bash
# NPM_TOKEN holds the npm user's token (for example exported from ~/.npmrc by the owner).
printf 'Authorization: Bearer %s\n' "$NPM_TOKEN" | curl -s -H @- \
  "https://registry.npmjs.org/-/package/@yolk-sdk%2f<name>/version/<version>/status"
# {"packageName":"@yolk-sdk/<name>","version":"<version>","status":"validating"}
```

`validating` means wait; `published` means it is public (the CDN may lag a few minutes).

Fix:

- While any package reports `validating`, do not rerun the same version and do not bump to a new
  one: wait, and check every package of the release before moving `latest` or pinning the version
  downstream.
- Once every package reports `published`, rerun the same workflow only if packages or `v<version>`
  are still missing (it skips published tarballs).
- If a version stays `validating` for many hours, contact npm support
  (https://www.npmjs.com/support) with the package, version and status response.
- Treat a version as lost only when its status is neither `validating` nor `published` (for example
  the endpoint returns 404) or npm support confirms it. Then bump all public packages to the next
  canary: add `.changeset/canary-<n>-lockstep.md` (all public packages, `patch`) saying it
  republishes the partial version unchanged, land it on `main`, run the usual release prep and
  dispatch `publish.yml`. Afterwards optionally deprecate the partial version of each package that
  did publish:
  `npm deprecate @yolk-sdk/<name>@<partial version> "<message pointing to the new version>"`.
  (canary.118 was such a republish of canary.117 before the cause was known; it was not needed.)

## Release prep includes unrelated files

Cause: working tree had feature, env, generated, or local-only changes before release prep.

Fix:

- Stop before committing.
- Inspect `git status` and diffs.
- Commit only generated release files: package versions, changelogs, lockfile, consumed changesets, and `.changeset/pre.json`.
- Land workflow/docs/code fixes separately before release prep; do not mix them into the release PR.
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
