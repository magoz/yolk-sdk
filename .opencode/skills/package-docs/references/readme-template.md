# Package README Template

Use this structure for public `packages/*/README.md` files.

## Standard outline

```md
# @yolk-sdk/<name>

One sentence: what this package provides.

## Install

```bash
pnpm add @yolk-sdk/<name>@canary [related @yolk-sdk deps] effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Subpaths

| Subpath | Purpose |
| --- | --- |
| `@yolk-sdk/<name>/foo` | ... |

## Imports

```ts
import { thing } from '@yolk-sdk/<name>'
```

## Example

```ts
// Minimal, real API only.
```

## Host responsibilities

- Auth/policy/storage/provider wiring that stays outside package.

## Boundaries

- No app/product/framework concepts owned here.
```

## Package-specific notes

### Agent

Document explicit subpaths:

- `protocol`
- `loop`
- `loop/testing`
- `runtime`
- `client`
- `compaction`
- `tools`
- `react`
- `oauth`
- `providers/openai`
- `providers/openai/codex`
- `providers/openai/codex-provider`
- `providers/openai/provider`
- `providers/anthropic`
- `providers/anthropic/claude`
- `providers/anthropic/claude-provider`
- `skillset`
- `voice`

Mention host-owned providers, persistence, tools, context compaction, token storage, UI/styling, and policy.

`react` docs should cover hook state/actions, render model, custom transport, optional React peer, and no UI/styling/auth.

`oauth` and `providers/*` docs should cover broker/credential-source flow and host-owned token storage. Never imply package stores secrets.

`skillset` docs should cover skill markdown, command markdown, render/parse APIs, manifests, and merge priority.

`voice` docs should cover normalized voice tool request, JSON output envelope, and provider adapter responsibilities.

### MCP

Document remote client, local stdio client, `client/node` Node-only boundary, server primitives, and HTTPS policy.

### Knowledge

Document documents, files, chunks, scopes, availability/status semantics, pinned context, search contracts, ingestion, lookup/manage tools, and host-owned adapters/stores/permissions.

### Sandbox

Document execution-plane service, source/lifecycle ADTs, `sandbox` agent tool, testing fakes, Vercel adapter, and host-owned state store/secrets/cleanup/policy.

### Vercel Workflows

Import Vercel Workflow APIs from `@yolk-sdk/vercel-workflows`.

## Style

- Concise, public-facing.
- Prefer tables for subpaths and responsibilities.
- Examples must compile conceptually and use existing exported names.
- Say “host owns …” instead of describing app internals.
- Mention canary instability once near install.
