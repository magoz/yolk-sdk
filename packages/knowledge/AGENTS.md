# Knowledge Core

`@yolk/knowledge` is the domain-free knowledge substrate package. It models agent-readable knowledge objects, artifacts, representations, provenance, links, store contracts, and context assembly.

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

## Subpaths

| Subpath | Role |
| --- | --- |
| `@yolk/knowledge/objects` | Knowledge object schemas and roles |
| `@yolk/knowledge/artifacts` | Artifact catalog and blob-store contract |
| `@yolk/knowledge/representations` | Agent-readable/indexable representations |
| `@yolk/knowledge/provenance` | Source/provenance metadata |
| `@yolk/knowledge/links` | Typed links between objects |
| `@yolk/knowledge/store` | Knowledge store lifecycle contract |
| `@yolk/knowledge/context` | Pinned context assembly helpers |
| `@yolk/knowledge/agent` | Agent-facing helper contracts |

## Rules

- Use Effect Schema at public boundaries.
- Reject empty ids/titles/content refs and invalid numeric counts.
- Keep root exports explicit; do not use broad `export *` barrels.
- Keep package APIs generic; host apps own all policy and IO.
