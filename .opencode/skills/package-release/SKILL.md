---
name: package-release
description: Manage Yolk package releases via GitHub Actions. Use for @yolk-sdk canary/stable version bumps, Changesets release notes, validation, and publish workflow prep.
---

# Package Release

Use this skill for Yolk public npm package releases under `@yolk-sdk/*`.

## In This Skill

| File                                                             | Purpose                          |
| ---------------------------------------------------------------- | -------------------------------- |
| [references/versioning.md](./references/versioning.md)           | SemVer, canary, Changesets rules |
| [references/publishing.md](./references/publishing.md)           | GitHub Actions publish flow      |
| [references/troubleshooting.md](./references/troubleshooting.md) | Common release failures          |

## Quick Start

1. Confirm release intent.
   - Canary: prerelease testing, default for now.
   - Stable: only after explicit user approval.
   - Dry run: validate artifacts only; never publish.

2. Inspect release state.
   - Check `.changeset/config.json`.
   - Check `.changeset/pre.json` if prerelease mode matters.
   - Check pending changesets in `.changeset/*.md`.
   - Check public package manifests in `packages/*/package.json`.

3. Ensure release notes exist.
   - Add or update `.changeset/*.md` before versioning.
   - Cover all public packages for lockstep release notes.
   - Keep notes concise, user-facing, and accurate.
   - If writing notes from repo history, compare from latest release tag.

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

4. Use fixed lockstep public package versioning.
   - Public scope: `@yolk-sdk/*` in `packages/*`.
   - Private workspace: `cloudflare/agent` (`@yolk-sdk/cloudflare-agent`), ignored by Changesets.
   - All public packages share one version.

5. Version locally; publish only in GitHub Actions. This step is mandatory before any publish action.

```bash
pnpm changeset:version
```

`pnpm changeset:version` already runs `pnpm install --lockfile-only` in this repo.

- If no files change, stop: there is no new version to publish.
- Never tell user to run the GitHub Action until bumped versions/changelogs are committed and pushed.

6. Inspect generated release files.
   - Package `package.json` versions.
   - Package `CHANGELOG.md` release notes.
   - `pnpm-lock.yaml` when changed.
   - `.changeset/pre.json` and removed consumed changesets.
   - No feature code, env files, `dist`, `.next`, `.turbo`, coverage.
   - Confirm normal releases have unpublished package versions; already-published versions are partial retry/tag repair only.
   - Confirm `v<version>` tag does not already exist.

```bash
node - <<'NODE'
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const packages = []
for (const d of fs.readdirSync('packages')) {
  const p = `packages/${d}/package.json`
  if (!fs.existsSync(p)) continue
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (!pkg.name?.startsWith('@yolk-sdk/') || pkg.private) continue
  packages.push(pkg)
}
const versions = [...new Set(packages.map((pkg) => pkg.version))]
if (versions.length !== 1) throw new Error(`Versions not lockstep: ${versions.join(', ')}`)
const publishedPackages = []
const unpublishedPackages = []
for (const pkg of packages) {
  let publishedVersionsJson = '[]'
  try {
    publishedVersionsJson = execFileSync('npm', ['view', pkg.name, 'versions', '--json'], { encoding: 'utf8' })
  } catch (error) {
    if (!String(error).includes('E404')) throw error
  }
  if (JSON.parse(publishedVersionsJson).includes(pkg.version)) {
    publishedPackages.push(`${pkg.name}@${pkg.version}`)
  } else {
    unpublishedPackages.push(`${pkg.name}@${pkg.version}`)
  }
}
const tag = `v${versions[0]}`
const refs = execFileSync('git', ['ls-remote', '--tags', 'origin', tag], { encoding: 'utf8' }).trim()
if (refs.length > 0) throw new Error(`${tag} already exists`)
console.log(`unpublished:\n${unpublishedPackages.map((pkg) => `- ${pkg}`).join('\n') || '- none'}`)
console.log(`already published:\n${publishedPackages.map((pkg) => `- ${pkg}`).join('\n') || '- none'}`)
if (unpublishedPackages.length === 0) console.log('all packages already published; proceed only for missing-tag repair')
NODE
```

7. Validate before push/action.

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

8. Do not proceed if validation fails.
   - Fix package manifests, exports, deps, or tests first.
   - Re-run full validation.

9. Commit and push release prep only after explicit approval.
   - Inspect `git status` and changed files.
   - List exact files intended for commit.
   - Propose concise commit message, e.g. `prepare canary release`.
   - Do not commit or push without explicit user approval.

10. Publish by GitHub Actions only.
    - Manual UI default; approved agent can run `gh workflow run publish.yml --ref main -f tag=canary`.
    - Use `canary` unless stable was explicitly approved.
    - Never run local `pnpm release:canary` for normal releases.
    - Exception: first publish of a new npm package name may be a local packed-tarball publish after explicit approval; see `references/publishing.md`.
    - Before UI/`gh` trigger, confirm current `main` contains the version bump commit.
    - After action completes, verify every public package dist-tag and new `v<version>` git tag.

## PR Workflow

- Feature PRs contain code changes and pending `.changeset/*.md` notes when public packages change.
- Changeset notes are release memory; add them when the user-facing package change happens.
- Release PRs contain only generated release files: package versions, changelogs, lockfile, and prerelease state.
- Do not mix feature code into release PRs.
- Publish only with `.github/workflows/publish.yml` after release prep lands on `main`.
- After release prep passes, propose commit/push but wait for explicit approval.
- A pending changeset alone is not release prep; consumed changesets plus bumped package versions/changelogs are release prep.

Typical flow:

```bash
# feature branch
pnpm changeset

# release branch from main
pnpm changeset:version
```

## Common Commands

Enter canary prerelease mode only when missing:

```bash
pnpm changeset:canary:enter
```

Version packages:

```bash
pnpm changeset:version
```

Publish from GitHub:

- Push release PR to `main`.
- Run Actions → `Publish packages`, or approved `gh workflow run publish.yml --ref main -f tag=canary`.
- Choose `canary` unless stable was explicitly approved.

Exit canary prerelease mode:

```bash
pnpm changeset:canary:exit
```

## Automation Model

Yolk should mirror Effect + MCP SDK:

- Agent prepares and validates release files locally.
- Human or explicitly approved agent triggers GitHub Actions publish from `main`.
- GitHub Actions builds, validates version/tag state, packs, publishes missing tarballs, then tags `v<version>`.

## Guardrails

- Use `pnpm` for repo/package scripts; use `npm` only for registry publish/view/trust flows documented in `patterns/PACKAGE_DISTRIBUTION.md`.
- Keep `@yolk-sdk/*` lockstep until a deliberate versioning change.
- Keep `dist/` generated and ignored.
- Keep local source exports; `publishConfig.exports` points to `dist`.
- Public `packages/*` manifests are publishable; private apps stay private.
- Run required checks before finishing any release-prep change.
- Do not publish from local machine during normal flow.
- Remind user to restart opencode after editing this skill.

## Reading Order

| Task           | Files                         |
| -------------- | ----------------------------- |
| Decide version | SKILL.md → versioning.md      |
| Publish canary | SKILL.md → publishing.md      |
| Add CI release | SKILL.md → publishing.md      |
| Debug failure  | SKILL.md → troubleshooting.md |
