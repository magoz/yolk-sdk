# Package Architecture

Rules for `packages/*` public shape, import boundaries, and tree-shaking.

## Public Shape

The lists below cover feature/API subpaths. Every public package also exports `./package.json` for
metadata.

- `@yolk-sdk/agent` is the main agent package.
- Agent APIs use explicit subpaths:
  - `@yolk-sdk/agent/protocol`
  - `@yolk-sdk/agent/loop`
  - `@yolk-sdk/agent/loop/testing`
  - `@yolk-sdk/agent/runtime`
  - `@yolk-sdk/agent/client`
  - `@yolk-sdk/agent/compaction`
  - `@yolk-sdk/agent/tools`
  - `@yolk-sdk/agent/react`
  - `@yolk-sdk/agent/oauth`
  - `@yolk-sdk/agent/providers/openai`
  - `@yolk-sdk/agent/providers/openai/codex`
  - `@yolk-sdk/agent/providers/openai/codex-usage`
  - `@yolk-sdk/agent/providers/openai/codex-provider`
  - `@yolk-sdk/agent/providers/openai/provider`
  - `@yolk-sdk/agent/providers/openai/realtime`
  - `@yolk-sdk/agent/providers/openai/speech`
  - `@yolk-sdk/agent/providers/vercel/ai-gateway-provider`
  - `@yolk-sdk/agent/providers/anthropic`
  - `@yolk-sdk/agent/providers/anthropic/claude`
  - `@yolk-sdk/agent/providers/anthropic/usage`
  - `@yolk-sdk/agent/providers/anthropic/claude-provider`
  - `@yolk-sdk/agent/providers/xai`
  - `@yolk-sdk/agent/providers/xai/grok`
  - `@yolk-sdk/agent/providers/xai/grok-provider`
  - `@yolk-sdk/agent/providers/xai/usage`
  - `@yolk-sdk/agent/providers/subscription-usage`
  - `@yolk-sdk/agent/skillset`
  - `@yolk-sdk/agent/voice`
  - `@yolk-sdk/agent/voice/browser`
  - `@yolk-sdk/agent/voice/react`
- `@yolk-sdk/mcp` is a sibling MCP package, not part of agent core.
- MCP APIs use explicit subpaths:
  - `@yolk-sdk/mcp/client`
  - `@yolk-sdk/mcp/client/node`
  - `@yolk-sdk/mcp/core`
  - `@yolk-sdk/mcp/protocol`
  - `@yolk-sdk/mcp/server`
  - `@yolk-sdk/mcp/server/node`
- `@yolk-sdk/knowledge` owns knowledge document/file/context/search contracts. Public subpaths: `./documents`, `./files`, `./store`, `./context`, `./chunking`, `./embeddings`, `./extraction`, `./ingestion`, `./search`, `./summarization`, `./errors`, and `./agent`.
- `@yolk-sdk/connectors` is a sibling connector package. Public subpaths: `./agent`, `./afloat`, `./dropbox`, `./email`, `./figma`, `./google`, `./linkedin-search`, `./microsoft`, `./notion`, `./r2-storage`, `./telegram`, and `./todoist`.
- `@yolk-sdk/sandbox` owns sandbox execution plane contracts; `./agent` exports the agent tool, `./vercel` exports Vercel provider code, and `./testing` exports fakes/state-store layers.
- `@yolk-sdk/vercel-workflows` owns Vercel Workflow orchestration contracts; root and `./workflow` export orchestration APIs, `./effect` exports host-side Effect wrappers, and hosts own concrete Workflow directives.
- OpenAI/Codex, Vercel AI Gateway, Anthropic/Claude, and xAI/Grok provider mechanics live under `@yolk-sdk/agent/providers/*`; Codex, Claude, and Grok also expose best-effort subscription-allowance snapshots from private provider endpoints.
- Package roots stay tiny; prefer subpath imports for feature APIs.

## Physical Layout

- Keep repo package shape aligned with public package shape.
- Agent internals live under `packages/agent/src/*`, not separate workspace packages.
- MCP internals live under `packages/mcp/src/*`, not separate workspace packages.
- Sandbox internals live under `packages/sandbox/src/*`, not separate workspace packages.
- Vercel Workflow internals live under `packages/vercel-workflows/src/*`, not app code.
- Area tests mirror source layout:
  - `packages/agent/test/{protocol,loop,runtime,client,compaction,tools,react,oauth,providers,skillset,voice,property}`
  - `packages/mcp/test/{client,server}`
  - `packages/sandbox/test/{core,agent,vercel}.test.ts`
  - `packages/vercel-workflows/test`

## Dependency Direction

```txt
examples/next, examples/next/e2e, cloudflare/agent -> @yolk-sdk/* public subpaths
@yolk-sdk/knowledge -> gpt-tokenizer + @yolk-sdk/agent/protocol + @yolk-sdk/agent/tools + @yolk-sdk/agent/loop only for agent adapter
@yolk-sdk/mcp -> official @modelcontextprotocol v2 packages + Effect + @yolk-sdk/agent/protocol only for tool/content adapters; @effect/platform-node stays behind Node subpaths
@yolk-sdk/connectors -> @yolk-sdk/agent/{protocol,loop,tools} only in ./agent; no app/storage/auth/UI policy
@yolk-sdk/sandbox root -> Effect only; ./agent -> sandbox core + @yolk-sdk/agent/{tools,protocol,loop}; ./vercel -> sandbox core/state + Effect + @vercel/sandbox via VercelSandboxClient/layer
@yolk-sdk/vercel-workflows -> workflow runtime APIs + generic durable stream helpers + Effect Workflow client/layer; no @yolk-sdk/agent/protocol or app/auth/provider/tool/storage policy
@yolk-sdk/agent/client -> @yolk-sdk/agent/protocol + Effect HTTP/Stream + runtime-only browser WebSocket/Blob/File/FileReader APIs
@yolk-sdk/agent/react -> @yolk-sdk/agent/client + @yolk-sdk/agent/protocol + Effect + React peer
@yolk-sdk/agent/compaction -> @yolk-sdk/agent/{loop,protocol} + Effect
@yolk-sdk/agent/providers/* -> @yolk-sdk/agent/oauth + @yolk-sdk/agent/{loop,protocol} + Effect; openai/realtime + openai/speech may also use @yolk-sdk/agent/voice contracts
@yolk-sdk/agent/voice -> @yolk-sdk/agent/{loop,protocol}
@yolk-sdk/agent/voice/browser -> voice core + browser WebRTC globals (lazy, behind a runtime seam)
@yolk-sdk/agent/voice/react -> voice core + voice/browser + React peer
@yolk-sdk/agent core -> no @yolk-sdk/knowledge, @yolk-sdk/mcp, app, Next, provider SDKs
```

## Tree-Shaking Constraints

- ESM only: package manifests use `"type": "module"`.
- Every publishable package declares `"sideEffects": false`.
- Use explicit `exports`; avoid broad root barrels for feature APIs.
- No top-level env reads, service construction, SDK clients, or network calls in packages.
- Import types as types; ESLint enforces `@typescript-eslint/consistent-type-imports`.
- Keep Node-specific APIs behind Node subpaths (`@yolk-sdk/mcp/client/node`, `@yolk-sdk/mcp/server/node`).
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
- Boundary script prevents example app, Cloudflare, and `examples/next/e2e` code from importing retired internal package names.
- Boundary script prevents retired package directories from reappearing.
- Boundary script prevents root `@yolk-sdk/agent` and `@yolk-sdk/mcp` imports in example app, Cloudflare, and `examples/next/e2e` code; use explicit subpaths.
- Boundary script prevents agent core subpaths from importing knowledge, MCP, retired package names, `@yolk-sdk/agent/react`, Next, React, or Node builtins. `@yolk-sdk/agent/react` and `@yolk-sdk/agent/voice/react` are the only React-using subpaths.
- Boundary script prevents knowledge from importing MCP/React/Next/Node.
- Boundary script prevents sandbox core from importing agent deps and `@vercel/sandbox` outside `packages/sandbox/src/vercel`.
- Export smoke script verifies explicit exports, ESM, `sideEffects: false`, and tiny agent/MCP roots.
- Vercel Workflow durable event helpers stay generic over JSON-serializable events; do not import `@yolk-sdk/agent/protocol` there.

## When Adding A Package API

1. Add the source under the package that owns the public namespace.
2. Add an explicit subpath export in `package.json`.
3. Add tests under the matching `test/*` area.
4. Update `packages/AGENTS.md` and the package-local `AGENTS.md` if the boundary changes.
5. Run `pnpm packages:check`, `pnpm tsc`, `pnpm lint`, and `pnpm test:run`.
