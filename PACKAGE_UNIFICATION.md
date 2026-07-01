# Package Unification Notes

Historical package-count reduction notes. Current package shape lives in `packages/AGENTS.md` and `patterns/PACKAGE_ARCHITECTURE.md`.

## Motivation

The pre-unification public surface was too fragmented for consumers.

- Consumers must install many `@yolk-sdk/*` packages even though versions are lockstep.
- Lockstep releases remove most independent-versioning benefits.
- Docs/examples repeat the same install/version guidance across packages.
- Common agent-adjacent APIs feel like one SDK: protocol, loop, client, compaction, providers, OAuth, React, skills, voice.
- We still need boundaries for optional product areas and runtime/platform constraints.

Goal: make the default install obvious while keeping tree-shaking, runtime portability, and host-owned policy intact.

## Pre-unification public packages

Previously published together:

- `@yolk-sdk/agent`
- `@yolk-sdk/react`
- `@yolk-sdk/mcp`
- `@yolk-sdk/knowledge`
- `@yolk-sdk/connectors`
- `@yolk-sdk/oauth`
- `@yolk-sdk/openai`
- `@yolk-sdk/anthropic`
- `@yolk-sdk/skillset`
- `@yolk-sdk/voice-runtime`
- `@yolk-sdk/vercel-workflows`

Prior consolidation already happened: old planned packages such as `@yolk-sdk/protocol`, `@yolk-sdk/agent-loop`, `@yolk-sdk/agent-runtime`, `@yolk-sdk/client`, and `@yolk-sdk/tool-registry` were folded into `@yolk-sdk/agent/*` subpaths. Boundary scripts now reject those retired packages/imports.

## Reference repo lessons

### Effect

Effect mostly mirrors publishable packages in workspace package roots.

- Public packages live under package roots and publish unbundled dist.
- Internal modules are hidden by explicit exports/null exports, not by many unpublished packages.
- Platform/runtime implementations are separate public packages (`@effect/platform-node`, `@effect/platform-browser`, `@effect/platform-bun`).
- Provider/driver packages are separate when they add concrete deps or runtime constraints (`@effect/sql-pg`, `@effect/ai-openai`, etc.).

Implication: Yolk should prefer real source directories + explicit subpaths inside public packages. Keep separate packages for platform/runtime or heavy integration deps.

### AI SDK

AI SDK has a public root `ai` package, but providers remain separate packages.

- Root `ai` is a facade/core package, not a monolith with all providers.
- Provider packages such as OpenAI/Anthropic remain independently installed.
- Packages generally publish from package roots; examples/tools stay private.

Implication: if a provider brings optional deps or separate release cadence, keep it separate. Yolk provider packages currently have minimal deps and lockstep versions, so folding them into `@yolk-sdk/agent/providers/*` is still reasonable.

### MCP SDK

MCP SDK uses a hidden private core package plus public client/server packages.

- Private core is curated through public surfaces.
- Client/server packages keep root barrels clean from Node-only transport code.
- Stdio/runtime-specific APIs live behind explicit subpaths.

Implication: hidden internal packages can work, but require strong smoke tests and curated exports. For Yolk, keeping `@yolk-sdk/mcp` separate is simpler than splitting MCP across agent/runtime packages.

### opencode / executor

These repos use private internal packages and explicit publish scripts/allowlists.

- Workspace shape can differ from npm shape.
- Publish scripts rewrite/strip private deps and smoke-test packed packages for leaks.
- This is more tooling-heavy than Yolk's current Effect-style package publish flow.

Implication: Yolk can use hidden internal packages only if we add explicit publish allowlists and private-package leak checks. Otherwise, keep repo package shape aligned with published package shape.

## Key package-boundary principles

- npm package count is less important than module graph isolation.
- Subpaths are the public API boundary.
- Root exports stay tiny.
- ESM + `sideEffects: false` + no top-level effects keep tree-shaking viable.
- Platform-specific code must live behind explicit subpaths or separate packages.
- Host-owned auth, storage, routes, prompts, provider choice, and product policy stay out of packages.
- Concrete extractors/provider/file-parser deps stay app-owned unless a stable reusable need appears.

## Tree-shaking and size conclusions

A single package does not inherently bloat app bundles if imports stay subpath-first:

```ts
import { runRuntime } from '@yolk-sdk/agent/runtime'
import { useAgentChat } from '@yolk-sdk/agent/react'
import { makeOpenAiProviderLayer } from '@yolk-sdk/agent/providers/openai'
```

The real risks are:

- install dependency pollution, not only bundle size;
- platform leakage into browser/Worker builds;
- broad root barrels pulling unrelated graphs;
- optional peer/dependency friction;
- fuzzier docs if one package appears to own app policy.

Known dependency/runtime pressure points:

- `react`: peer dependency; should be optional if folded into agent.
- `@effect/platform-node`: MCP local stdio/node convenience only.
- `workflow`: Vercel Workflow runtime only.
- `gpt-tokenizer`: knowledge chunking/search only.
- file parsers/extractors: currently app-owned; should not enter core agent.

## Implemented direction

Reduce from 11 public packages to this smaller set:

```txt
@yolk-sdk/agent
@yolk-sdk/mcp
@yolk-sdk/knowledge
@yolk-sdk/connectors
@yolk-sdk/vercel-workflows
```

Future platform packages may be separate and explicit:

```txt
@yolk-sdk/cloudflare-runtime
@yolk-sdk/node-runtime
```

Do not create an umbrella `@yolk-sdk/runtimes` package for now. It conflicts mentally with `@yolk-sdk/agent/runtime`, which is generic session orchestration, not deployment runtime code.

## Target package roles

### `@yolk-sdk/agent`

Main default SDK package for building agent applications.

Keep existing core subpaths:

```txt
@yolk-sdk/agent/protocol
@yolk-sdk/agent/loop
@yolk-sdk/agent/loop/testing
@yolk-sdk/agent/runtime
@yolk-sdk/agent/client
@yolk-sdk/agent/tools
```

Fold these packages into agent subpaths:

```txt
@yolk-sdk/agent/react
@yolk-sdk/agent/oauth
@yolk-sdk/agent/providers/openai
@yolk-sdk/agent/providers/anthropic
@yolk-sdk/agent/skillset
@yolk-sdk/agent/voice
```

Rationale:

- These are agent-adjacent and commonly used with core agent APIs.
- They are small or dependency-light, except React peer.
- Separate npm packages add more friction than isolation value.
- Provider packages already depend on agent + OAuth and are lockstep.

React note: React is not used by the agent loop; React uses agent client/protocol. Still, `@yolk-sdk/agent/react` is consumer-friendly if React remains an optional peer.

### `@yolk-sdk/mcp`

Keep separate.

Rationale:

- MCP is its own external protocol boundary, not an agent core concept.
- Current subpaths are clear enough:
  - `@yolk-sdk/mcp/client`
  - `@yolk-sdk/mcp/client/node`
  - `@yolk-sdk/mcp/server`
  - `@yolk-sdk/mcp/protocol`
- Avoid confusing splits such as `agent/mcp` plus `runtimes/node/mcp`.
- Speldosa uses `@yolk-sdk/mcp/client` for Figma remote MCP dynamic tool discovery/execution.
- If `@effect/platform-node` dependency becomes a problem, revisit optional peer or node-only package later.

MCP is not a connector. Connectors may expose MCP metadata, but MCP owns protocol transport/tool discovery.

### `@yolk-sdk/knowledge`

Keep separate.

Rationale:

- Optional RAG/knowledge substrate, not required for basic agents.
- Distinct concepts: documents, files, chunks, embeddings, search, pinned context, and availability.
- Has tokenizer weight.
- Extractors, provider adapters, object storage, DB, permissions, and file parsing remain host/app-owned.

Do not move app-local PDF/DOCX/XLSX/PPTX/etc. extraction dependencies into this package.

### `@yolk-sdk/connectors`

Keep separate.

Rationale:

- Vendor/action/credential catalog can grow without bloating core agent.
- Distinct mental model: connector definitions, integrations, credential slots, action execution.
- Hosts own credentials, OAuth callbacks, authorization, auditing, and lifecycle.

Example relationship with MCP:

```ts
import { figmaMcpServerUrl, figmaOAuthSlotId } from '@yolk-sdk/connectors/figma'
import { listRemoteMcpServerTools } from '@yolk-sdk/mcp/client'
```

### `@yolk-sdk/vercel-workflows`

Keep separate.

Rationale:

- Platform-specific Vercel Workflow semantics.
- Depends on `workflow`.
- Different runtime model than generic `@yolk-sdk/agent/runtime`.
- Follows common ecosystem pattern: core package + explicit platform package.

Potential future rename is possible, but not required now.

## Naming clarification: `agent/runtime`

`@yolk-sdk/agent/runtime` is generic session orchestration over the agent loop.

It provides:

- transcript mode;
- append-backed durable run mode;
- HITL response resume mode;
- `SessionEventStore` contract;
- append-log event schemas and replay helpers.

It does not provide:

- Vercel Workflow code;
- Cloudflare Durable Object code;
- Node stdio/process code;
- database implementation;
- HTTP/WebSocket routes;
- auth/tenant policy.

Platform runtimes should stay separate named packages when they become publishable.

## Proposed import migration

| Current | Target |
| --- | --- |
| `@yolk-sdk/react` | `@yolk-sdk/agent/react` |
| `@yolk-sdk/oauth` | `@yolk-sdk/agent/oauth` |
| `@yolk-sdk/openai` | `@yolk-sdk/agent/providers/openai` |
| `@yolk-sdk/openai/codex` | `@yolk-sdk/agent/providers/openai/codex` |
| `@yolk-sdk/openai/codex-provider` | `@yolk-sdk/agent/providers/openai/codex-provider` |
| `@yolk-sdk/openai/provider` | `@yolk-sdk/agent/providers/openai/provider` |
| `@yolk-sdk/anthropic` | `@yolk-sdk/agent/providers/anthropic` |
| `@yolk-sdk/anthropic/claude` | `@yolk-sdk/agent/providers/anthropic/claude` |
| `@yolk-sdk/anthropic/claude-provider` | `@yolk-sdk/agent/providers/anthropic/claude-provider` |
| `@yolk-sdk/skillset` | `@yolk-sdk/agent/skillset` |
| `@yolk-sdk/voice-runtime` | `@yolk-sdk/agent/voice` |

Unchanged:

- `@yolk-sdk/agent/*` existing core subpaths
- `@yolk-sdk/mcp/*`
- `@yolk-sdk/knowledge/*`
- `@yolk-sdk/connectors/*`
- `@yolk-sdk/vercel-workflows/*`

## Migration approach

1. Move folded package source into `packages/agent/src/*`.
2. Update internal consumers (`examples/next`, `cloudflare/agent`) to new imports.
3. Update package architecture/distribution docs and package READMEs.
4. Update package boundary/export/smoke scripts.
5. Remove folded workspace packages.
6. Speldosa updates imports using the migration table above.

No compatibility packages are planned. Re-export packages would still require publishing, so they would not solve final package count.

Long term, source of truth should mirror the final published package set unless we deliberately adopt executor-style publish tooling. Hidden internal packages add build/release complexity and private-package leak risk.

## Open decisions

- Should folded compatibility packages publish for one canary, many canaries, or until 1.0?
- Should `react` become optional peer on `@yolk-sdk/agent` immediately?
- Should `effect` remain dependency or become peer before stable?
- Should `@effect/platform-node` in `@yolk-sdk/mcp` become optional/peer?
- What is the breaking-release point for stopping old package publishes?
