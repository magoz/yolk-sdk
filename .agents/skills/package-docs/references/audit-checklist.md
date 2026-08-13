# Package Docs Audit Checklist

Use this checklist before npm canaries and after package API changes.

## Package README coverage

Every public package should have `packages/<name>/README.md`:

- `@yolk-sdk/agent`
- `@yolk-sdk/mcp`
- `@yolk-sdk/knowledge`
- `@yolk-sdk/connectors`
- `@yolk-sdk/sandbox`
- `@yolk-sdk/vercel-workflows`

Do not require READMEs for private workspaces unless useful internally.

## README content checklist

- package name matches `package.json`
- one-line role matches root `README.md` and `packages/AGENTS.md`
- install snippet uses `@canary`
- lockstep version note included
- feature/API subpaths match `package.json` exports; the standard `./package.json` metadata export may stay centralized in `patterns/PACKAGE_ARCHITECTURE.md`
- imports use real exported symbols
- examples do not depend on app internals
- host-owned responsibilities explicit
- package boundaries explicit
- canary instability not overpromised

## Cross-doc cleanup

Check these after package shape changes:

- root `README.md` package table
- `packages/AGENTS.md` package map and high-level dependency direction
- `packages/<name>/AGENTS.md` package-specific design/boundary rules
- `patterns/PACKAGE_ARCHITECTURE.md` cross-package shape/dependency rules
- `patterns/PACKAGE_DISTRIBUTION.md` publish/versioning policy
- `.changeset/README.md` release flow
- package-release skill references if release flow changed
- `scripts/AGENTS.md` if validation scripts changed

## API drift checks

Search for stale names after exports change. `scripts/check-package-boundaries.ts` is the retired-package source of truth.

```txt
makeCharacterChunker
VectorStore
@yolk-sdk/agent-loop
@yolk-sdk/agent-runtime
@yolk-sdk/anthropic
@yolk-sdk/client
@yolk-sdk/mcp-client
@yolk-sdk/mcp-server
@yolk-sdk/oauth
@yolk-sdk/openai
@yolk-sdk/protocol
@yolk-sdk/react
@yolk-sdk/skillset
@yolk-sdk/tool-registry
@yolk-sdk/voice-runtime
@yolk-sdk/vercel-workflows-runtime
@yolk/
First Alpha
Planned Changesets
```

Use `grep` tool, not shell grep, for content searches.

## Validation commands

For package docs that affect public imports/examples:

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

For pure wording-only docs:

```bash
pnpm tsc
pnpm lint
```

## Common failures

- README references symbols not exported by package.
- Root README lists retired packages.
- Package `files` includes README but README missing.
- Subpath docs omit Node-only/runtime-specific boundaries.
- Release docs say planned when config is already current.
- Docs say peer deps while manifests use dependencies; document current policy or update manifests.
- Dense package-specific rules drift into root `packages/AGENTS.md` instead of local package docs.
