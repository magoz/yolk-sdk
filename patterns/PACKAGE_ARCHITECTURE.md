# Package Architecture

Rules for `packages/*` public shape, import boundaries, and tree-shaking.

## Public Shape

- `@yolk-sdk/agent` is the main agent package.
- Agent APIs use explicit subpaths:
  - `@yolk-sdk/agent/protocol`
  - `@yolk-sdk/agent/loop`
  - `@yolk-sdk/agent/loop/testing`
  - `@yolk-sdk/agent/runtime`
  - `@yolk-sdk/agent/client`
  - `@yolk-sdk/agent/tools`
- `@yolk-sdk/mcp` is a sibling MCP package, not part of agent core.
- MCP APIs use explicit subpaths:
  - `@yolk-sdk/mcp/client`
  - `@yolk-sdk/mcp/client/node`
  - `@yolk-sdk/mcp/protocol`
  - `@yolk-sdk/mcp/server`
- `@yolk-sdk/rag` is a sibling RAG package; agent integration lives behind `@yolk-sdk/rag/agent`.
- Package roots stay tiny; prefer subpath imports for feature APIs.

## Physical Layout

- Keep repo package shape aligned with public package shape.
- Agent internals live under `packages/agent/src/*`, not separate workspace packages.
- MCP internals live under `packages/mcp/src/*`, not separate workspace packages.
- Area tests mirror source layout:
  - `packages/agent/test/{protocol,loop,runtime,client,tools}`
  - `packages/mcp/test/{client,server}`

## Dependency Direction

```txt
app/lib/cloudflare/e2e -> @yolk-sdk/agent/* + @yolk-sdk/mcp/*
@yolk-sdk/react -> @yolk-sdk/agent/client + @yolk-sdk/agent/protocol
@yolk-sdk/rag -> @yolk-sdk/agent/protocol + @yolk-sdk/agent/tools only for agent adapter
@yolk-sdk/mcp -> @yolk-sdk/agent/protocol only for ToolDef/ToolResult
@yolk-sdk/agent -> no @yolk-sdk/react, @yolk-sdk/rag, @yolk-sdk/mcp, app, Next, provider SDKs
```

## Tree-Shaking Constraints

- ESM only: package manifests use `"type": "module"`.
- Every publishable package declares `"sideEffects": false`.
- Use explicit `exports`; avoid broad root barrels for feature APIs.
- No top-level env reads, service construction, SDK clients, or network calls in packages.
- Import types as types; ESLint enforces `@typescript-eslint/consistent-type-imports`.
- Keep Node-specific APIs behind Node subpaths (`@yolk-sdk/mcp/client/node`).
- Prefer runtime-portable Effect APIs in package code.

## Workspace Setup

- Shared dependency pins live in `pnpm-workspace.yaml` catalogs; use `catalog:` for Effect-family packages, TypeScript, and Vitest.
- Root `packageManager` pins pnpm for reproducible installs.
- Package tsconfigs extend `packages/tsconfig.base.json`; keep package-local configs to `outDir`, `rootDir`, and include/exclude overrides.
- Keep package dependencies explicit in each package manifest even when versions come from catalogs.
- Internal `@yolk-sdk/*` dependencies use `workspace:^`; Changesets rewrites publish ranges.
- Package-internal relative imports use explicit `.ts` extensions. `packages/tsconfig.base.json` enables `rewriteRelativeImportExtensions` for emit.

## Boundary Enforcement

- `pnpm packages:check` runs package typechecks, `scripts/check-package-boundaries.ts`, and `scripts/check-package-exports.ts`.
- Boundary script prevents app/lib/cloudflare/e2e from importing retired internal package names.
- Boundary script prevents retired package directories from reappearing.
- Boundary script prevents root `@yolk-sdk/agent` and `@yolk-sdk/mcp` imports in app/lib/cloudflare/e2e; use explicit subpaths.
- Boundary script prevents `@yolk-sdk/agent` from importing `@yolk-sdk/rag`, `@yolk-sdk/mcp`, `@yolk-sdk/react`, Next, React, or Node builtins.
- Boundary script prevents RAG from importing MCP/React/Next/Node.
- Export smoke script verifies explicit exports, ESM, `sideEffects: false`, and tiny agent/MCP roots.

## When Adding A Package API

1. Add the source under the package that owns the public namespace.
2. Add an explicit subpath export in `package.json`.
3. Add tests under the matching `test/*` area.
4. Update `packages/AGENTS.md` and the package-local `AGENTS.md` if the boundary changes.
5. Run `pnpm packages:check`, `pnpm tsc`, `pnpm lint`, and `pnpm test:run`.
