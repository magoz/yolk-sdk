# Knowledge Core

`@yolk-sdk/knowledge` is the domain-free knowledge package. It models durable agent-readable documents, sources, optional files/chunks, pinned context, ingestion, hybrid search, and lookup/manage tool factories.

## Role

- Define `KnowledgeDocument`, `KnowledgeSource`, `KnowledgeFile`, `KnowledgeChunk`, indexed/extracted document, status, availability, and search-scope schemas.
- Provide store contracts for app-owned DB/R2 adapters.
- Provide pure pinned context assembly helpers.
- Expose chunking, embedding, extraction, summarization, ingestion, and search helpers.
- Expose `makeKnowledgeLookupTool` and `makeKnowledgeManageTool`; apps own handler policy.

## Boundaries

- No app users, orgs, permissions, product routes, R2/S3 layouts, auth, or DB schema.
- No provider SDKs, database drivers, Cloudflare bindings, React, Next.js, or Node-only imports.
- Concrete stores, file storage, extraction providers, embedding providers, and permissions belong in app services.
- `KnowledgeScope` is caller-provided routing metadata only; package never interprets user/workspace/project semantics.

## Availability semantics

- `pinned`: host may inject into model startup context and search.
- `searchable`: host may expose through search tools.
- `archived`: retained but normally omitted from prompt/search.

Availability is host policy. `buildKnowledgeContext` does not filter its input, and
`searchKnowledge` delegates status/availability filtering to `SearchIndexStore`.

## Status semantics

- `processing`: saved but not ready for prompt/search.
- `ready`: active if availability allows it.
- `error`: saved with an indexing/extraction failure.

`KnowledgeDocument` and `IndexedKnowledgeDocument` are separate contracts. Ingestion updates only
the search-index document through `SearchIndexStore`; hosts coordinate it with `KnowledgeStore`.
`replaceDocumentChunks` atomicity/transactions belong to the host adapter.

## Subpaths

| Subpath                             | Role                                                       |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `@yolk-sdk/knowledge`               | Root context/store/file/error helpers                      |
| `@yolk-sdk/knowledge/documents`     | Document, source, file, chunk, search-scope, status, availability schemas |
| `@yolk-sdk/knowledge/files`         | File blob-store contract                                   |
| `@yolk-sdk/knowledge/store`         | Document store and search-index store contracts            |
| `@yolk-sdk/knowledge/context`       | Pinned context assembly helpers                            |
| `@yolk-sdk/knowledge/chunking`      | Chunker contracts and defaults                             |
| `@yolk-sdk/knowledge/embeddings`    | Embedder contract and vector types                         |
| `@yolk-sdk/knowledge/extraction`    | Loaded source/extractor contract                           |
| `@yolk-sdk/knowledge/ingestion`     | Extract/chunk/embed/index ingestion pipeline                |
| `@yolk-sdk/knowledge/search`        | Vector/text/hybrid search and context packing               |
| `@yolk-sdk/knowledge/summarization` | Optional title/summary service contract                    |
| `@yolk-sdk/knowledge/agent`         | Lookup/manage tool factories                               |
| `@yolk-sdk/knowledge/errors`        | Shared knowledge error types                               |

## Rules

- Use Effect Schema at public boundaries.
- Schema-modeled ids/slugs/titles/purpose/origin/content are non-empty. Use the exported positive
  and non-negative integer schemas where counts are schema-modeled; runtime search/chunking helpers
  validate their own numeric options, while hosts parse typed store inputs at their boundary.
- Keep root exports explicit; do not use broad `export *` barrels.
- Keep package APIs generic; host apps own all policy and IO.
- Do not reintroduce previous graph-model concepts into core knowledge without explicit product need.
