---
name: package-release
description: Manage Yolk package versioning and npm releases. Use for @yolk-sdk canary/stable releases, Changesets, artifact validation, and publish workflows.
---

# Package Release

Use this skill for Yolk public npm package releases under `@yolk-sdk/*`.

## In This Skill

| File | Purpose |
| --- | --- |
| [references/versioning.md](./references/versioning.md) | SemVer, canary, Changesets rules |
| [references/publishing.md](./references/publishing.md) | Manual and automated publish flow |
| [references/troubleshooting.md](./references/troubleshooting.md) | Common release failures |

## Quick Start

1. Confirm release intent.
   - Canary: prerelease testing, default for now.
   - Stable: only after explicit user approval.
   - Dry run: validate artifacts only.

2. Inspect release state.
   - Check `.changeset/config.json`.
   - Check `.changeset/pre.json` if prerelease mode matters.
   - Check pending changesets in `.changeset/*.md`.
   - Check public package manifests in `packages/*/package.json`.

3. Use fixed lockstep public package versioning.
   - Public scope: `@yolk-sdk/*` in `packages/*`.
   - Private app package: `@yolk-sdk/cloudflare-agent`, ignored by Changesets.
   - All public packages share one version.

4. Validate before publish.

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

5. Do not publish if any validation fails.
   - Fix package manifests, exports, deps, or tests first.
   - Re-run full validation.

6. Publish only after explicit user approval.
   - Publishing is irreversible.
   - Never publish secrets or private packages.
   - Never publish from dirty or unclear working tree without confirming scope.

## Common Commands

Enter canary prerelease mode:

```bash
pnpm changeset:canary:enter
```

Version packages:

```bash
pnpm changeset:version
```

Publish canary:

```bash
pnpm release:canary
```

Exit canary prerelease mode:

```bash
pnpm changeset:canary:exit
```

## Automation Model

Yolk should mirror Effect + MCP SDK:

- Changesets release PR on `main`.
- Build and validate before publish.
- npm provenance/trusted publishing where available.
- Optional snapshot workflow later, inspired by AI SDK.

## Guardrails

- Use `pnpm` only.
- Keep `@yolk-sdk/*` lockstep until a deliberate versioning change.
- Keep `dist/` generated and ignored.
- Keep local source exports; `publishConfig.exports` points to `dist`.
- Public `packages/*` manifests are publishable; private apps stay private.
- Run required checks before finishing any release-prep change.

## Reading Order

| Task | Files |
| --- | --- |
| Decide version | SKILL.md → versioning.md |
| Publish canary | SKILL.md → publishing.md |
| Add CI release | SKILL.md → publishing.md |
| Debug failure | SKILL.md → troubleshooting.md |
