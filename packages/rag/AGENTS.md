# RAG Core

`@yolk/rag` is the domain-free knowledge retrieval package. It is separate from `@yolk/agent`; agents consume RAG through tool boundaries.

## Role

- Define document, chunk, embedding, vector-store, ingestion, and retrieval primitives.
- Provide dependency-light chunking and pipeline helpers.
- Expose optional agent tool adapters without making RAG part of agent core.

## Boundaries

- No app users, orgs, permissions, product source sync, R2/S3 layouts, or auth.
- No provider SDKs, database drivers, Cloudflare bindings, React, Next.js, or Node-only imports.
- Concrete embedders/vector stores belong in adapter packages.

## Subpaths

| Subpath | Role |
| --- | --- |
| `@yolk/rag/documents` | Documents, chunks, metadata |
| `@yolk/rag/chunking` | Generic chunker interfaces/helpers |
| `@yolk/rag/embeddings` | Embedder interface and vector types |
| `@yolk/rag/vector-store` | Vector store interface |
| `@yolk/rag/retrieval` | Retriever interface and context packing |
| `@yolk/rag/ingestion` | Generic ingestion pipeline |
| `@yolk/rag/agent` | Agent tool adapter helpers |
