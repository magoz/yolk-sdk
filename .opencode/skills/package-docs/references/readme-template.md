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
- `tools`

Mention host-owned providers, persistence, tools, context compaction, and policy.

### React

Document hook state/actions, render model, custom transport, and no UI/styling/auth.

Include `react` in install command.

### MCP

Document remote client, local stdio client, `client/node` Node-only boundary, server primitives, and HTTPS policy.

### Knowledge

Document records, artifacts, representations, provenance, links, context policy, collection/document/chunk/search contracts, ingestion, context packing, and host-owned adapters/stores/permissions.

### OAuth/provider packages

Document broker/credential-source flow and host-owned token storage. Never imply package stores secrets.

### Vercel Workflows Runtime

State root export is intentionally empty. Import from `@yolk-sdk/vercel-workflows-runtime/workflow`.

### Skillset

Document skill markdown, command markdown, render/parse APIs, manifests, and merge priority.

### Voice Runtime

Document normalized voice tool request, JSON output envelope, and provider adapter responsibilities.

## Style

- Concise, public-facing.
- Prefer tables for subpaths and responsibilities.
- Examples must compile conceptually and use existing exported names.
- Say “host owns …” instead of describing app internals.
- Mention canary instability once near install.
