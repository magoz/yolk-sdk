# RAG Core

`@yolk-sdk/rag` is the domain-free knowledge retrieval package. It is separate from `@yolk-sdk/agent`; agents consume RAG through tool boundaries.

## Role

- Define document, chunk, embedding, vector-store, ingestion, and retrieval primitives.
- Provide dependency-light chunking and pipeline helpers.
- Expose optional agent tool adapters without making RAG part of agent core.
- `RagSet` is package-level namespace/config only; no app `kind`, `ownerId`, or permissions.

## Boundaries

- No app users, orgs, permissions, product source sync, R2/S3 layouts, or auth.
- No provider SDKs, database drivers, Cloudflare bindings, React, Next.js, or Node-only imports.
- Concrete embedders/vector stores belong in adapter packages or app services.
- Package architecture constraints live in `patterns/PACKAGE_ARCHITECTURE.md`.

## Subpaths

| Subpath | Role |
| --- | --- |
| `@yolk-sdk/rag/documents` | Documents, chunks, metadata |
| `@yolk-sdk/rag/chunking` | Generic chunker interfaces/helpers |
| `@yolk-sdk/rag/embeddings` | Embedder interface and vector types |
| `@yolk-sdk/rag/errors` | Tagged package errors |
| `@yolk-sdk/rag/extraction` | Loaded source + extractor service contract |
| `@yolk-sdk/rag/store` | `RagStore` set/document/chunk/search lifecycle contract |
| `@yolk-sdk/rag/vector-store` | Legacy vector-store aliases over `RagStore` names |
| `@yolk-sdk/rag/retrieval` | Retriever interface and context packing |
| `@yolk-sdk/rag/ingestion` | Generic ingestion pipeline |
| `@yolk-sdk/rag/summarization` | Optional document title/summary service contract |
| `@yolk-sdk/rag/agent` | Agent tool adapter helpers |

## Contracts

- `RagStore` is one lifecycle contract: sets, documents, chunk replacement, vector search, context chunks.
- Ingestion is a sync Effect program over `RagStore | RagExtractor | RagChunker | RagEmbedder | RagSummarizer`; hosts choose queues/workflows.
- Default chunker is sentence/token, no overlap; retrieval defaults to hybrid vector + keyword search and uses `contextChunks` for adjacent content.
- Hybrid retrieval fuses `searchChunks` and `searchChunksByText` with reciprocal rank fusion; see `HYBRID_RETRIEVAL.md`.
- Agent helper requires host-provided scope resolver; package never decides searchable sets.

## Effect Patterns

- Public boundary schemas reject empty ids/content and invalid numeric counts.
- Ingestion/retrieval map service failures into stage-tagged package errors while preserving `cause`.
- Agent tool params decode with Effect Schema and reject blank queries at the tool boundary.
- Keep root exports explicit; do not use broad `export *` barrels.

## Tests

- Cover schema boundary validation, chunking validation, ingestion success/failure, hybrid retrieval fusion, retrieval validation/context packing, and agent tool adapter validation.
