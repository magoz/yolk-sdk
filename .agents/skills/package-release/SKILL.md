---
name: package-release
description: Prepare and release @yolk-sdk packages end to end. Use for release-readiness audits, package README and docs-site updates, Changesets coverage, canary/stable versioning, validation, and approved GitHub Actions publishing.
---

# Package Release

One entry point for Yolk public npm package releases under `@yolk-sdk/*`, including package
READMEs, public docs-site readiness, and release notes. The parent owns orchestration, edits,
versioning, validation, and approval gates; subagents audit independently.

Read `patterns/PACKAGE_DISTRIBUTION.md` and relevant owner `AGENTS.md` files first.
A request to audit or update docs is not permission to version, commit, push, or publish.

## In This Skill

| File                                                                           | Purpose                                        |
| ------------------------------------------------------------------------------ | ---------------------------------------------- |
| [references/package-documentation.md](./references/package-documentation.md)   | Package README workflow and boundaries         |
| [references/package-docs-checklist.md](./references/package-docs-checklist.md) | Package documentation audit                    |
| [references/readme-template.md](./references/readme-template.md)               | README structure and package-specific guidance |
| [references/docs-site.md](./references/docs-site.md)                           | Public docs-site workflow and writing rules    |
| [references/docs-site-checklist.md](./references/docs-site-checklist.md)       | Docs drift and discovery audit                 |
| [references/docs-site-map.md](./references/docs-site-map.md)                   | Changed-code → docs mapping                    |
| [references/versioning.md](./references/versioning.md)                         | SemVer, canary, Changesets rules               |
| [references/publishing.md](./references/publishing.md)                         | GitHub Actions publish flow                    |
| [references/troubleshooting.md](./references/troubleshooting.md)               | Common release failures                        |

## Workflow

```text
Scope → parallel audits → parent fixes → version → validate → approval → publish → verify
```

### 1. Scope

- Confirm intent: audit only, docs update only, dry run, canary prep, or explicitly approved stable.
- Audit-only is read-only. Docs-only stops after edits and relevant validation. Dry run checks
  readiness and existing artifacts without versioning, committing, pushing, or publishing.
- Record `git status --short`, target commit SHA, release channel, and comparison base before work.
  Inspect staged, unstaged, and untracked files separately; exclude unrelated pre-existing changes.
- Use the latest release tag reachable from the target commit, not the highest tag on another branch.
  If no tag exists, use the previous release-prep commit or agree an explicit initial-release scope.
- Give every auditor the same base/target SHAs, changed-file list, approved working-tree scope,
  and relevant owner docs. Freeze that scope while audits run.

### 2. Parallel readiness audits

Discover available subagents first (in Pi, `subagent({ action: "list" })`); use only executable,
non-disabled read-only reviewers with fresh context. Run these three tasks in parallel:

| Audit                 | References to read                                                                                             | Required result                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Package documentation | `references/package-documentation.md`, `references/package-docs-checklist.md`, `references/readme-template.md` | README/import/subpath/host-boundary gaps verified against manifests and source                |
| Docs site             | `references/docs-site.md`, `references/docs-site-checklist.md`, `references/docs-site-map.md`                  | Missing/stale guides, catalogs, API reference, migration and troubleshooting pages            |
| Changeset coverage    | `references/versioning.md`, `.changeset/config.json`, `.changeset/pre.json` when present, pending changesets   | User-facing changes missing from notes, inaccurate notes, lockstep coverage and bump concerns |

Resolve `references/*` paths relative to this skill directory; other repo paths are root-relative.
Pass each child its audit assignment and resolved reference paths, not a mandate to execute the
whole release skill. Children must not edit project files, run builds/versioning, commit, push,
publish, or spawn more agents. Return findings through the response or distinct temporary
artifacts outside the repo. Ask for:

- scope inspected and source/test evidence with file references
- concrete gaps and proposed file-level fixes, or an explicit no-gaps result
- required validation and unresolved questions

Wait for all three results before editing or advancing. A failed or incomplete audit is not a
pass: retry it or complete it in the parent. If delegation is unavailable or the user declines it,
run the same three audits sequentially and report that fallback.

### 3. Reconcile and fix

For audit-only or dry run, report readiness findings without applying fixes. The following edits
apply only to docs-update or release-prep requests.

- Parent verifies findings against code/tests, resolves overlaps, and applies the smallest fixes as
  the sole writer. Never change implementation merely to make documentation true.
- Escalate unapproved API, scope, or release-channel decisions to the user.
- Add or repair user-facing changesets before versioning; preserve lockstep release-note coverage.
- Recheck affected audit findings after fixes. If target/scope changes materially, refresh the audits.
- Documentation/code/changeset fixes belong in feature/docs PRs and must land on `main` before a
  separate generated-only release-prep PR. Stop for explicit commit/push/merge approval as needed;
  do not mix readiness fixes into release bookkeeping or create a worktree without a request.
- For audit-only, report findings and stop. For docs-only or dry run, perform only the requested
  work and applicable validation, then stop. Read-only audit findings do not authorize fixes.

### 4. Prepare, validate, and publish

Proceed only after readiness gaps are resolved and the release-prep checkout is clean. The parent
runs the following steps; do not delegate mutation or approval gates to audit children.

1. Confirm release intent.
   - Canary: prerelease testing, default for now.
   - Stable: only after explicit user approval.

2. Inspect release state.
   - Check `.changeset/config.json`.
   - Check `.changeset/pre.json` if prerelease mode matters.
   - Check pending changesets in `.changeset/*.md`.
   - Check public package manifests in `packages/*/package.json`.

3. Confirm audited release notes are present.
   - Pending changesets cover all public packages for lockstep release notes.
   - Notes are concise, user-facing, and accurate for the agreed comparison scope.
   - If notes need changes, return to phase 3 and land fixes separately before versioning.
   - See [versioning.md](./references/versioning.md) for history comparison and Changesets rules.

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

7. Validate the final release files before push/action. Run the suite once in the parent, not
   once per auditor. Earlier feature/docs fixes still require their own pre-merge checks.

```bash
pnpm packages:build
pnpm packages:publint
pnpm packages:smoke
pnpm packages:check
pnpm cloudflare:check
pnpm tsc
pnpm lint
pnpm test:run
pnpm --filter @yolk-sdk/vercel-workflows test:workflow
```

If readiness work touched `apps/docs`, also run `pnpm docs:check` and `pnpm build:docs`.
Run docs check/build and `pnpm tsc` serially: they regenerate shared docs types.
If `.agents/skills/**` changed, run `pnpm skillset:build`, inspect the documented generated
Cloudflare fallback, and run `pnpm cloudflare:check`.

8. Do not proceed if validation fails.
   - Return code/docs fixes to phase 3 and land them separately; do not mix them into release prep.
   - Re-run full validation on the corrected release candidate.

9. Commit and push release prep only after explicit approval.
   - Inspect `git status` and changed files.
   - List exact files intended for commit.
   - Propose concise commit message, e.g. `prepare canary release`.
   - Do not commit or push without explicit user approval.

10. Publish by GitHub Actions only.
    - Manual UI default; approved agent can run `gh workflow run publish.yml --ref main -f tag=canary`.
    - Use `canary` unless stable was explicitly approved.
    - Never publish locally for normal releases.
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

## Reading Order

| Task                    | Files                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Audit release readiness | SKILL.md → three audit assignments above                                             |
| Update package READMEs  | SKILL.md → package-documentation.md → package-docs-checklist.md → readme-template.md |
| Update public docs site | SKILL.md → docs-site.md → docs-site-checklist.md → docs-site-map.md                  |
| Decide version          | SKILL.md → versioning.md                                                             |
| Publish canary          | SKILL.md → publishing.md                                                             |
| Add CI release          | SKILL.md → publishing.md                                                             |
| Debug failure           | SKILL.md → troubleshooting.md                                                        |

## Report

- Comparison base/target and mode.
- Audit findings resolved, remaining blockers, and audit artifact paths when used.
- Files changed and validation commands/results.
- Version/channel and next approval needed; after publishing, workflow URL and package/tag verification.
- Do not describe preparation or an approved dispatch as a successful publish.
