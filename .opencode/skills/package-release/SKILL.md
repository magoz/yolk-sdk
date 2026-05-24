---
name: package-release
description: Manage Yolk package releases via GitHub Actions. Use for @yolk-sdk canary/stable version bumps, Changesets release notes, validation, and publish workflow prep.
---

# Package Release

Use this skill for Yolk public npm package releases under `@yolk-sdk/*`.

## In This Skill

| File | Purpose |
| --- | --- |
| [references/versioning.md](./references/versioning.md) | SemVer, canary, Changesets rules |
| [references/publishing.md](./references/publishing.md) | GitHub Actions publish flow |
| [references/troubleshooting.md](./references/troubleshooting.md) | Common release failures |

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

4. Use fixed lockstep public package versioning.
   - Public scope: `@yolk-sdk/*` in `packages/*`.
   - Private app package: `@yolk-sdk/cloudflare-agent`, ignored by Changesets.
   - All public packages share one version.

5. Version locally; publish only in GitHub Actions. This step is mandatory before any publish action.

```bash
pnpm changeset:version
pnpm install --lockfile-only
```

   - If no files change, stop: there is no new version to publish.
   - Never tell user to run the GitHub Action until bumped versions/changelogs are committed and pushed.

6. Inspect generated release files.
   - Package `package.json` versions.
   - Package `CHANGELOG.md` release notes.
   - `pnpm-lock.yaml` when changed.
   - `.changeset/pre.json` and removed consumed changesets.
   - No feature code, env files, `dist`, `.next`, `.turbo`, coverage.
   - Confirm package versions advanced beyond npm-published versions.

```bash
node - <<'NODE'
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
for (const d of fs.readdirSync('packages')) {
  const p = `packages/${d}/package.json`
  if (!fs.existsSync(p)) continue
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (!pkg.name?.startsWith('@yolk-sdk/') || pkg.private) continue
  const versions = execFileSync('npm', ['view', pkg.name, 'versions', '--json'], { encoding: 'utf8' })
  if (JSON.parse(versions).includes(pkg.version)) {
    throw new Error(`${pkg.name}@${pkg.version} already published`)
  }
  console.log(`${pkg.name}@${pkg.version} ok`)
}
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
    - Tell user to run Actions → `Publish packages` from `main`.
    - Use `canary` unless stable was explicitly approved.
    - Never run local `pnpm release:canary` for normal releases.
    - Before saying “run action”, confirm current `main` contains the version bump commit.
    - After action completes, verify npm dist-tags.

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
pnpm install --lockfile-only
```

## Common Commands

Enter canary prerelease mode:

```bash
pnpm changeset:canary:enter
```

Version packages:

```bash
pnpm changeset:version
```

Publish from GitHub:

- Push release PR to `main`.
- Run Actions → `Publish packages`.
- Choose `canary` unless stable was explicitly approved.

Exit canary prerelease mode:

```bash
pnpm changeset:canary:exit
```

## Automation Model

Yolk should mirror Effect + MCP SDK:

- Agent prepares and validates release files locally.
- Human triggers GitHub Actions publish from `main`.
- GitHub Actions builds, validates, packs, and publishes tarballs.
- Optional snapshot workflow later, inspired by AI SDK.

## Guardrails

- Use `pnpm` only.
- Keep `@yolk-sdk/*` lockstep until a deliberate versioning change.
- Keep `dist/` generated and ignored.
- Keep local source exports; `publishConfig.exports` points to `dist`.
- Public `packages/*` manifests are publishable; private apps stay private.
- Run required checks before finishing any release-prep change.
- Do not publish from local machine during normal flow.
- Remind user to restart opencode after editing this skill.

## Reading Order

| Task | Files |
| --- | --- |
| Decide version | SKILL.md → versioning.md |
| Publish canary | SKILL.md → publishing.md |
| Add CI release | SKILL.md → publishing.md |
| Debug failure | SKILL.md → troubleshooting.md |
