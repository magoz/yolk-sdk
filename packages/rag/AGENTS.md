# RAG Core

`@yolk/rag` is the domain-free knowledge retrieval package. It is separate from `@yolk/agent`; agents consume RAG through tool boundaries.

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
| `@yolk/rag/documents` | Documents, chunks, metadata |
| `@yolk/rag/chunking` | Generic chunker interfaces/helpers |
| `@yolk/rag/embeddings` | Embedder interface and vector types |
| `@yolk/rag/errors` | Tagged package errors |
| `@yolk/rag/extraction` | Loaded source + extractor service contract |
| `@yolk/rag/store` | `RagStore` set/document/chunk/search lifecycle contract |
| `@yolk/rag/vector-store` | Legacy vector-store aliases over `RagStore` names |
| `@yolk/rag/retrieval` | Retriever interface and context packing |
| `@yolk/rag/ingestion` | Generic ingestion pipeline |
| `@yolk/rag/agent` | Agent tool adapter helpers |

## Contracts

- `RagStore` is one lifecycle contract: sets, documents, chunk replacement, vector search, context chunks.
- Ingestion is a sync Effect program over `RagStore | RagExtractor | RagChunker | RagEmbedder`; hosts choose queues/workflows.
- Default chunker is sentence/token, no overlap; retrieval uses `contextChunks` for adjacent content.
- Agent helper requires host-provided scope resolver; package never decides searchable sets.
