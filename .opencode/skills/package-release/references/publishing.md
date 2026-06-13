# Publishing

## GitHub Actions first workflow

Feature PRs:

- Include code/docs/package changes.
- Add `.changeset/*.md` when public package behavior, API, runtime deps, exports, or release-facing docs change.
- Do not run `pnpm changeset:version` in feature PRs.
- Release notes live in changesets. Make them user-facing, concise, and specific.

Release PRs:

- Start from `main` after feature PRs merge.
- Run `pnpm changeset:version`.
- Include only generated release files: package versions, changelogs, lockfile, consumed changesets, and `.changeset/pre.json` changes.
- No feature code.
- Merge/push to `main`, then user manually runs `.github/workflows/publish.yml`.
- Do not run the action from a commit that only adds `.changeset/*.md`; it will republish the existing package version and 403.

After successful release prep:

- Inspect `git status`.
- List exact files that belong in the release PR.
- Propose a concise commit message.
- Ask before committing or pushing.
- Never include env files, generated `dist`, `.next`, `.turbo`, coverage, or unrelated local changes.

Release PR content should be mechanically reviewable: “these changesets became these versions/changelogs”.

## Agent release-prep flow

Use this for canary/stable prep. This does not publish.

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

Before telling user to run the Action, verify with the unpublished-version check from `SKILL.md`:

- public package versions changed from the previously published canary/latest
- changelog entries were generated
- consumed changeset ids were recorded in `.changeset/pre.json`
- no package version to publish already exists on npm

## GitHub Actions publish steps

1. Ensure release prep is on `main`.

2. User opens GitHub → Actions → `Publish packages` → Run workflow.

3. Select dist-tag:
   - `canary`: default prerelease.
   - `latest`: stable only after explicit approval.

4. Workflow runs:

```bash
pnpm packages:build
pnpm packages:publint
pnpm packages:smoke
pnpm packages:check
pnpm cloudflare:check
pnpm tsc
pnpm lint
pnpm test:run
verify unpublished package versions
pnpm -r --filter './packages/*' pack --pack-destination .release
npm publish .release/*.tgz --tag <tag> --access public
git tag -a v<version> && git push origin v<version>
```

5. Verify locally after action completes:

```bash
npm view @yolk-sdk/agent dist-tags
npm view @yolk-sdk/connectors dist-tags
git fetch --tags
git tag --list 'v*' --sort=-v:refname | head -n 5
```

Or check every public package:

```bash
node - <<'NODE'
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
for (const d of fs.readdirSync('packages')) {
  const p = `packages/${d}/package.json`
  if (!fs.existsSync(p)) continue
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (!pkg.name?.startsWith('@yolk-sdk/') || pkg.private) continue
  const tags = execFileSync('npm', ['view', pkg.name, 'dist-tags', '--json'], { encoding: 'utf8' })
  console.log(pkg.name, tags.trim())
}
NODE
```

Preconditions:

- release prep commit is on `main`.
- release prep includes package version bumps and changelog entries, not just changesets.
- publish target tag is `canary` unless stable approved.
- all public versions are lockstep.
- working tree state was clean before release prep.

## Public package gates

Before publish:

- public package names use `@yolk-sdk/*`
- versions are lockstep
- public `packages/*` are publishable; private apps stay private
- `publishConfig.access` is `public`
- `files` includes `dist`, `src`, README, license as intended
- `publishConfig.exports` points to `dist`
- all runtime deps declared in package manifests

## Artifact validation

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
- Fails before publish if package versions already exist on npm.
- Fails before publish if `v<version>` already exists.
- Packs package artifacts with `pnpm pack`.
- Publishes tarballs with npm CLI, because npm trusted publishing is the supported OIDC path.
- Tags the published commit as `v<version>` after successful publish.

Do not run local publish in normal flow. Local `pnpm release:canary` is emergency-only and requires explicit user approval.
## Future automation model

Recommended later workflow:

- Trigger release PR on push to `main`.
- Use `changesets/action` for version PRs.
- `version`: `pnpm changeset:version`.
- `publish`: validation + `.github/workflows/publish.yml`.
- Set `id-token: write` for npm trusted publishing/provenance.

Reference patterns:

- Effect: fixed group + `changesets/action` release PR/publish.
- MCP SDK: separate version/publish jobs + OIDC provenance.
- AI SDK: optional snapshot workflow.

## Post-publish checks

After GitHub Action publish:

```bash
npm view @yolk-sdk/agent version
npm view @yolk-sdk/agent dist-tags
git fetch --tags
git tag --list 'v*' --sort=-v:refname | head -n 1
```

Optionally run a clean external install fixture with `@canary`.

## Bad publish response

Never unpublish unless user explicitly asks and npm policy allows it.

Prefer:

- publish a fixed canary
- deprecate bad version with clear message
- update docs/changelog
