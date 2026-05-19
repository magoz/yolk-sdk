# Knowledge Core

`@yolk-sdk/knowledge` is the domain-free knowledge substrate package. It models agent-readable knowledge objects, artifacts, representations, provenance, links, store contracts, and context assembly.

## Role

- Define knowledge object, artifact, representation, provenance, link, and context primitives.
- Provide store contracts for app-owned Postgres/R2 adapters.
- Provide pure context assembly helpers for pinned/routable knowledge.
- Expose optional agent helper types without owning app tool policy.

## Boundaries

- No app users, orgs, permissions, product routes, R2/S3 layouts, auth, or DB schema.
- No provider SDKs, database drivers, Cloudflare bindings, React, Next.js, or Node-only imports.
- Concrete stores, artifact storage, extraction, embeddings, and permissions belong in app services.
- `KnowledgeScope` is caller-provided routing metadata only; package never interprets user/workspace/project semantics.
- Package owns semantics (roles, context policy, provenance, links), not retrieval/indexing implementation.

## Context policy semantics

- `pinned`: host may inject into model startup context.
- `routable`: host may use for dispatch/resolver maps.
- `searchable`: host may expose through retrieval tools.
- `archival`: retained but normally omitted from active context/search.

## Subpaths

| Subpath | Role |
| --- | --- |
| `@yolk-sdk/knowledge/objects` | Knowledge object schemas and roles |
| `@yolk-sdk/knowledge/artifacts` | Artifact catalog and blob-store contract |
| `@yolk-sdk/knowledge/representations` | Agent-readable/indexable representations |
| `@yolk-sdk/knowledge/provenance` | Source/provenance metadata |
| `@yolk-sdk/knowledge/links` | Typed links between objects |
| `@yolk-sdk/knowledge/store` | Knowledge store lifecycle contract |
| `@yolk-sdk/knowledge/context` | Pinned context assembly helpers |
| `@yolk-sdk/knowledge/agent` | Agent-facing helper contracts |

## Rules

- Use Effect Schema at public boundaries.
- Reject empty ids/titles/content refs and invalid numeric counts.
- Keep root exports explicit; do not use broad `export *` barrels.
- Keep package APIs generic; host apps own all policy and IO.
