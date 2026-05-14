# Package Architecture

Rules for `packages/*` public shape, import boundaries, and tree-shaking.

## Public Shape

- `@yolk/agent` is the main agent package.
- Agent APIs use explicit subpaths:
  - `@yolk/agent/protocol`
  - `@yolk/agent/loop`
  - `@yolk/agent/loop/testing`
  - `@yolk/agent/runtime`
  - `@yolk/agent/client`
  - `@yolk/agent/tools`
- `@yolk/mcp` is a sibling MCP package, not part of agent core.
- MCP APIs use explicit subpaths:
  - `@yolk/mcp/client`
  - `@yolk/mcp/client/node`
  - `@yolk/mcp/protocol`
  - `@yolk/mcp/server`
- `@yolk/rag` is a sibling RAG package; agent integration lives behind `@yolk/rag/agent`.
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
app/lib/cloudflare/e2e -> @yolk/agent/* + @yolk/mcp/*
@yolk/react -> @yolk/agent/client + @yolk/agent/protocol
@yolk/rag -> @yolk/agent/protocol + @yolk/agent/tools only for agent adapter
@yolk/mcp -> @yolk/agent/protocol only for ToolDef/ToolResult
@yolk/agent -> no @yolk/react, @yolk/rag, @yolk/mcp, app, Next, provider SDKs
```

## Tree-Shaking Constraints

- ESM only: package manifests use `"type": "module"`.
- Every publishable package declares `"sideEffects": false`.
- Use explicit `exports`; avoid broad root barrels for feature APIs.
- No top-level env reads, service construction, SDK clients, or network calls in packages.
- Import types as types; ESLint enforces `@typescript-eslint/consistent-type-imports`.
- Keep Node-specific APIs behind Node subpaths (`@yolk/mcp/client/node`).
- Prefer runtime-portable Effect APIs in package code.

## Boundary Enforcement

- `pnpm packages:check` runs package typechecks and `scripts/check-package-boundaries.ts`.
- Boundary script prevents app/lib/cloudflare/e2e from importing retired internal package names.
- Boundary script prevents `@yolk/agent` from importing `@yolk/rag`, `@yolk/mcp`, `@yolk/react`, Next, React, or Node builtins.
- Boundary script prevents RAG from importing MCP/React/Next/Node.

## When Adding A Package API

1. Add the source under the package that owns the public namespace.
2. Add an explicit subpath export in `package.json`.
3. Add tests under the matching `test/*` area.
4. Update `packages/AGENTS.md` and the package-local `AGENTS.md` if the boundary changes.
5. Run `pnpm packages:check`, `pnpm tsc`, `pnpm lint`, and `pnpm test:run`.
