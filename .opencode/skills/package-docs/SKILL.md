---
name: package-docs
description: Maintain Yolk package documentation. Use when adding/updating package READMEs, public subpaths, package boundaries, host responsibilities, or release-readiness docs.
---

# Package Docs

Use this skill for public `@yolk-sdk/*` package documentation and package knowledge hygiene.

## In This Skill

| File | Purpose |
| --- | --- |
| [references/readme-template.md](./references/readme-template.md) | Package README structure and examples |
| [references/audit-checklist.md](./references/audit-checklist.md) | Release-readiness and stale-doc audit checklist |

## Quick Start

1. Inspect package reality first.
   - Read `packages/<name>/package.json`.
   - Read `packages/<name>/src/index.ts` and exported subpath entrypoints.
   - Read `packages/<name>/AGENTS.md` if present.
   - Read existing `packages/<name>/README.md` if present.

2. Keep docs public-facing.
   - README explains what npm users need.
   - AGENTS explains what repo agents need.
   - Patterns explain cross-package policy.

3. For every README include:
   - one-line purpose
   - install command using `@canary`
   - lockstep/canary stability note
   - imports/subpaths
   - small examples
   - host responsibilities
   - package boundaries

4. Update related knowledge when docs drift.
   - Root `README.md` package list.
   - `packages/AGENTS.md` package map and release rules.
   - `patterns/PACKAGE_DISTRIBUTION.md` package/release policy.
   - `scripts/AGENTS.md` if package docs/check scripts change.

5. Validate after edits.

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

For docs-only edits, at minimum run:

```bash
pnpm tsc
pnpm lint
```

## Documentation Boundaries

- Do not document app-owned examples as package-owned APIs.
- Do not promise API stability during canary.
- Do not list private packages as public npm packages.
- Do not invent exports; verify every import exists.
- Do not duplicate long parent docs in child README files.
- Keep package roots tiny and explicit; docs should reinforce subpath imports.

## Reading Order

| Task | Files |
| --- | --- |
| Create README | SKILL.md → readme-template.md |
| Audit all packages | SKILL.md → audit-checklist.md |
| Fix stale release docs | SKILL.md → audit-checklist.md → package-release skill if needed |
