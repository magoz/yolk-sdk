# Package Documentation

Reference for the package-documentation phase of [package-release](../SKILL.md).
Audit public `@yolk-sdk/*` READMEs and package knowledge against code reality. Auditors return
findings only; the parent applies approved fixes and runs validation.

## In This Skill

| File                                                     | Purpose                                         |
| -------------------------------------------------------- | ----------------------------------------------- |
| [readme-template.md](./readme-template.md)               | Package README structure and examples           |
| [package-docs-checklist.md](./package-docs-checklist.md) | Release-readiness and stale-doc audit checklist |

## Quick Start

1. Inspect package reality first.
   - Read `packages/<name>/package.json`.
   - Read `packages/<name>/src/index.ts` and exported subpath entrypoints.
   - Read `packages/<name>/AGENTS.md` if present.
   - Read existing `packages/<name>/README.md` if present.

2. Keep docs public-facing.
   - README explains what npm users need.
   - AGENTS explains what repo agents need.
   - Root `packages/AGENTS.md` is an index and boundary summary only.
   - Package-local `packages/<name>/AGENTS.md` owns detailed package rules.
   - Patterns explain cross-package architecture/distribution policy.

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
   - `packages/AGENTS.md` package map only when package list/roles change.
   - `packages/<name>/AGENTS.md` for package-specific boundaries/design rules.
   - `patterns/PACKAGE_ARCHITECTURE.md` for cross-package shape/dependency rules.
   - `patterns/PACKAGE_DISTRIBUTION.md` package/release policy.
   - `scripts/AGENTS.md` if package docs/check scripts change.

5. Parent validates after edits, not each auditor.
   - Full release prep: use the suite in [package-release](../SKILL.md).
   - Docs-only: `pnpm tsc`, `pnpm lint`, and `pnpm packages:check` when `packages/*` changed.
   - For public import/example changes, also use the [audit validation checklist](./package-docs-checklist.md).

## Documentation Boundaries

- Do not document app-owned examples as package-owned APIs.
- Do not promise API stability during canary.
- Do not list private packages as public npm packages.
- Do not invent exports; verify every import exists.
- Do not duplicate long parent docs in child README files.
- Keep package roots tiny and explicit; docs should reinforce subpath imports.
- Do not put dense package-specific rules back into root `packages/AGENTS.md`; move them to package-local AGENTS or package architecture patterns.
- Before deleting package docs, verify unique rules are preserved elsewhere.

## Reading Order

| Task                   | Files                                                |
| ---------------------- | ---------------------------------------------------- |
| Create README          | package-documentation.md → readme-template.md        |
| Audit all packages     | package-documentation.md → package-docs-checklist.md |
| Fix stale release docs | package-docs-checklist.md → publishing.md            |
