# @yolk-sdk/knowledge

Domain-free knowledge object, artifact, representation, provenance, link, store, and context contracts.

## Install

```bash
pnpm add @yolk-sdk/knowledge@canary @yolk-sdk/agent@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Subpaths

| Subpath | Purpose |
| --- | --- |
| `@yolk-sdk/knowledge/objects` | Knowledge object schemas and roles |
| `@yolk-sdk/knowledge/artifacts` | Artifact catalog and blob-store contract |
| `@yolk-sdk/knowledge/representations` | Agent-readable/indexable representations |
| `@yolk-sdk/knowledge/provenance` | Source/provenance metadata |
| `@yolk-sdk/knowledge/links` | Typed links between objects |
| `@yolk-sdk/knowledge/store` | Knowledge store lifecycle contract |
| `@yolk-sdk/knowledge/context` | Context assembly helpers |
| `@yolk-sdk/knowledge/agent` | Agent-facing helper contracts |

## Imports

```ts
import { buildKnowledgeContext, KnowledgeStore } from '@yolk-sdk/knowledge'
import { KnowledgeObject } from '@yolk-sdk/knowledge/objects'
import { KnowledgeArtifactStore } from '@yolk-sdk/knowledge/artifacts'
```

## Context policy

| Policy | Meaning |
| --- | --- |
| `pinned` | Host may inject into model startup context |
| `routable` | Host may use for routing/dispatch decisions |
| `searchable` | Host may expose through retrieval tools |
| `archival` | Retained but normally omitted from active context/search |

## Host responsibilities

- Own users, teams, permissions, routing, and product policy.
- Implement `KnowledgeStore` and `KnowledgeArtifactStore` with app storage.
- Own extraction, embeddings, indexing, R2/S3 layout, and DB schema.
- Decide which knowledge is pinned, searchable, routable, or archival.

## Boundaries

- No app auth, DB drivers, object storage SDKs, React, Next.js, or provider SDKs.
- No retrieval implementation; use `@yolk-sdk/rag` or app adapters for indexing/search.
- Package owns semantics and contracts only.
