# Packages

Public `@yolk-sdk/*` packages. Domain-free SDK surface; apps own product policy, storage, auth, prompts, provider selection, and UI.

## Package map

| Package                      | Role                                                                                                   | Local docs                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `@yolk-sdk/agent`            | Agent protocol, loop, runtime, Effect-native client, compaction, tools, React, providers, OAuth, skillset, and voice | `packages/agent/AGENTS.md`            |
| `@yolk-sdk/mcp`              | MCP client/server/protocol adapters                                                                    | `packages/mcp/AGENTS.md`              |
| `@yolk-sdk/knowledge`        | Knowledge document/file/context/search contracts and lookup/manage tool helpers                        | `packages/knowledge/AGENTS.md`        |
| `@yolk-sdk/connectors`       | Effect-native connector, integration, credential, and action primitives                                | `packages/connectors/AGENTS.md`       |
| `@yolk-sdk/sandbox`          | Sandbox execution plane, agent tool, Vercel client/layer adapter, and testing fakes                    | `packages/sandbox/AGENTS.md`          |
| `@yolk-sdk/vercel-workflows` | Workflow loop contract, generic durable stream helpers, and Effect Workflow client/layer                | `packages/vercel-workflows/AGENTS.md` |

## Dependency direction

Canonical package dependency rules live in `patterns/PACKAGE_ARCHITECTURE.md#dependency-direction`.
Package-local boundaries and exceptions live in each package `AGENTS.md`.

## Rules

- Canonical package architecture/dependency rules: `patterns/PACKAGE_ARCHITECTURE.md`.
- Package distribution/release: `patterns/PACKAGE_DISTRIBUTION.md`.
- Keep package APIs generic over host context; never model app users, teams, orgs, projects, billing, token storage, or product permissions.
- Package-specific boundaries/design rules live in each package `AGENTS.md`.
- When public packages/subpaths change, update package `exports`, `publishConfig.exports`, `scripts/check-package-exports.ts`, and `scripts/smoke-package-imports.ts` together.

## Commands

- Check packages: `pnpm packages:check`
- Build packages: `pnpm packages:build`
- Release validation: see `patterns/PACKAGE_DISTRIBUTION.md`; full gates include build, publint, smoke, packages check, Cloudflare check, `tsc`, lint, and tests.
- Package tests run through root `pnpm test:run` unless a local doc says otherwise.
