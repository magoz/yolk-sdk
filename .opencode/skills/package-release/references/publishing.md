# Publishing

## Model

Feature PRs:

- Include code/docs/package changes.
- Add `.changeset/*.md` when public package behavior, API, runtime deps, exports, or release-facing docs change.
- Do not run `pnpm changeset:version` in feature PRs.
- Make changeset notes user-facing, concise, specific.

Release PRs:

- Start from `main` after feature PRs merge.
- Run `pnpm changeset:version`.
- Include only generated release files: package versions, changelogs, lockfile, consumed changesets, `.changeset/pre.json`.
- No feature code.
- Merge/push to `main`, then publish manually or by approved agent `gh` trigger.
- Do not run the action from a commit that only adds `.changeset/*.md`; it has no release-prep output to publish.

After successful release prep:

- Inspect `git status`.
- List exact files that belong in the release PR.
- Propose a concise commit message.
- Ask before committing or pushing.
- Never include env files, `dist`, `.next`, `.turbo`, coverage, or unrelated local changes.

## Agent release-prep flow

Use for canary/stable prep. This does not publish.

```bash
pnpm changeset:version
pnpm packages:build
pnpm packages:publint
pnpm packages:smoke
pnpm packages:check
pnpm cloudflare:check
pnpm tsc
pnpm lint
pnpm test:run
```

Then inspect, commit, push after explicit approval.

Before any publish trigger, verify version/tag state with the check from `SKILL.md`:

- normal publishes have unpublished public package versions
- already-published package versions are explicit partial retry/tag repair only
- `v<version>` does not exist
- changelog entries generated
- consumed changeset ids recorded in `.changeset/pre.json`

## GitHub Actions publish steps

1. Ensure release prep is committed and pushed to `main`.
2. Confirm version/tag state with the `SKILL.md` checker.
3. Get explicit user approval to publish.
4. Trigger manually or by approved agent command.

Manual:

```txt
GitHub → Actions → Publish packages → Run workflow
```

Approved agent:

```bash
gh workflow run publish.yml --ref main -f tag=canary
gh run list --workflow publish.yml --limit 3
gh run view <run-id> --json conclusion,status,url,headSha,displayTitle
gh run watch <run-id> --exit-status
```

Use `canary` by default. Use `latest` only after explicit stable approval.

Workflow runs:

```bash
pnpm packages:build
pnpm packages:publint
pnpm packages:smoke
pnpm packages:check
pnpm cloudflare:check
pnpm tsc
pnpm lint
pnpm test:run
verify lockstep version and missing git tag
pnpm -r --filter './packages/*' pack --pack-destination .release
npm publish each unpublished tarball --tag <tag> --access public
git tag -a v<version> && git push origin v<version>
```

Verify after action completes:

```bash
npm view @yolk-sdk/agent dist-tags
npm view @yolk-sdk/mcp dist-tags
npm view @yolk-sdk/knowledge dist-tags
npm view @yolk-sdk/connectors dist-tags
npm view @yolk-sdk/sandbox dist-tags
npm view @yolk-sdk/vercel-workflows dist-tags
git fetch --tags
git tag --list 'v<version>'
git ls-remote --tags origin 'refs/tags/v<version>'
```

Preconditions:

- release prep commit is on `main`
- release prep includes package version bumps and changelog entries, not just changesets
- explicit user approval was given before any `gh workflow run`
- normal publishes have at least one unpublished public package version; all-published runs are missing-tag repair only
- `v<version>` does not exist
- publish target tag is `canary` unless stable approved
- all public versions are lockstep
- working tree state was clean before release prep

## Public package gates

Before publish:

- public package names use `@yolk-sdk/*`
- versions are lockstep
- public `packages/*` are publishable; private apps stay private
- `publishConfig.access` is `public`
- `files` includes `dist`, `src`, README, license as intended
- `publishConfig.exports` points to `dist`
- all runtime deps declared in package manifests

`pnpm packages:publint` checks package export health.
`pnpm packages:smoke` packs public packages, installs/extracts them in a temp fixture, and imports every public subpath.
If either fails, fix package exports/deps before publishing.

## Workflow notes

Use `.github/workflows/publish.yml` for npm trusted publishing.

Configure each npm package trusted publisher:

- Provider: GitHub Actions
- Organization/user: `magoz`
- Repository: `yolk-sdk`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

Current workflow policy:

- Manual `workflow_dispatch` only.
- Uses `contents: write` for git tags and `id-token: write`; provenance currently disabled with `NPM_CONFIG_PROVENANCE=false`.
- Installs/builds/tests with `pnpm`.
- Fails before publish if `v<version>` already exists.
- Skips package tarballs whose exact `name@version` already exists on npm, so partial retries and missing-tag repair reuse the same version.
- Packs package artifacts with `pnpm pack`.
- Publishes tarballs with npm CLI, because npm trusted publishing is the supported OIDC path.
- Tags the published commit as `v<version>` after successful publish.

Do not run local publish in normal flow. Local `pnpm release:canary` is emergency-only and requires explicit user approval.

## Exceptions/failures

New package first publish:

- New npm package names cannot be trusted-publisher preauthorized until they exist on npm.
- After approval, first publish only the missing package from a packed tarball with interactive npm auth/OTP.
- Then configure trust: `npm trust github @yolk-sdk/<name> --repo magoz/yolk-sdk --file publish.yml --allow-publish --yes`.
- Rerun `.github/workflows/publish.yml`; it skips already-published tarballs and creates `v<version>`.
- First publish of a brand-new package may leave `latest` on the canary version; note or correct intentionally.

Partial trusted-publish failure:

```bash
gh run view <run-id> --log-failed
npm trust github @yolk-sdk/sandbox \
  --repo magoz/yolk-sdk \
  --file publish.yml \
  --allow-publish \
  --yes
```

If no git tag was created, do not bump versions. Rerun the same workflow; already-published tarballs are skipped.

Bad publish response: never unpublish unless user explicitly asks and npm policy allows it. Prefer fixed canary, deprecation, or docs/changelog update.
