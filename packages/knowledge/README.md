# @yolk-sdk/knowledge

Domain-free knowledge record, artifact, representation, search, provenance, link, store, and context contracts.

## Install

```bash
pnpm add @yolk-sdk/knowledge@canary @yolk-sdk/agent@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Subpaths

| Subpath | Purpose |
| --- | --- |
| `@yolk-sdk/knowledge` | Root context/store/artifact/error helpers |
| `@yolk-sdk/knowledge/records` | Knowledge record schemas and roles |
| `@yolk-sdk/knowledge/artifacts` | Artifact catalog and blob-store contract |
| `@yolk-sdk/knowledge/representations` | Agent-readable/searchable representations |
| `@yolk-sdk/knowledge/chunking` | Search chunker contracts and defaults |
| `@yolk-sdk/knowledge/embeddings` | Embedder contract and vector types |
| `@yolk-sdk/knowledge/errors` | Shared knowledge error types |
| `@yolk-sdk/knowledge/extraction` | Loaded source/extractor contract |
| `@yolk-sdk/knowledge/ingestion` | Generic search ingestion pipeline |
| `@yolk-sdk/knowledge/search` | Search interface, hybrid search, context packing |
| `@yolk-sdk/knowledge/documents` | Collection, document, chunk, and search scope schemas |
| `@yolk-sdk/knowledge/search-store` | Collection/document/chunk/search lifecycle store |
| `@yolk-sdk/knowledge/vector-store` | Compatibility aliases for vector search/store types |
| `@yolk-sdk/knowledge/summarization` | Optional title/summary service contract |
| `@yolk-sdk/knowledge/provenance` | Source/provenance metadata |
| `@yolk-sdk/knowledge/links` | Typed links between records |
| `@yolk-sdk/knowledge/store` | Knowledge store lifecycle contract |
| `@yolk-sdk/knowledge/context` | Context assembly helpers |
| `@yolk-sdk/knowledge/agent` | Agent-facing helper contracts |

## Imports

```ts
import { buildKnowledgeContext, KnowledgeStore } from '@yolk-sdk/knowledge'
import type { KnowledgeRecord } from '@yolk-sdk/knowledge/records'
import { KnowledgeArtifactStore } from '@yolk-sdk/knowledge/artifacts'
import { makeDefaultKnowledgeChunker } from '@yolk-sdk/knowledge/chunking'
import { searchKnowledge } from '@yolk-sdk/knowledge/search'
```

## Migration

Search APIs use canonical search naming. Removed retrieval APIs are intentionally not backward-compatible.

| Removed | Use |
| --- | --- |
| Retrieval subpath | `@yolk-sdk/knowledge/search` |
| `KnowledgeRetriever` | `KnowledgeSearcher` |
| `retrieve(input)` | `search(input)` |
| `KnowledgeRetrievalError` | `KnowledgeSearchError` |

## Glossary

| Term | Meaning |
| --- | --- |
| Knowledge record | Stable logical thing an agent can know about. Domain-free; hosts decide product meaning. |
| Artifact | Stored source/blob attached to knowledge, such as a file or captured output. |
| Representation | Agent-readable or searchable form of knowledge, usually text plus metadata. |
| Provenance | Source metadata explaining where knowledge came from and how it was produced. |
| Link | Typed relationship between knowledge records. |
| Context | Model-ready knowledge selected for a run. Built from host policy. |
| Context policy | Host intent for use: `pinned`, `routable`, `searchable`, or `archived`. |
| Search index | Searchable corpus built from source documents, chunks, embeddings, and metadata. |
| Collection | Named searchable document group with shared embedding and chunking config. |
| Document | Source item tracked through search ingestion: pending, processing, ready, or error. |
| Source | Document origin: file ref, URL, or raw text. |
| Chunk | Searchable slice of a document with position and token count. |
| Embedding | Numeric vector for semantic search. Hosts provide the embedding provider. |
| Chunker | Service that splits extracted text into chunks. |
| Extractor | Service that loads source content into text/title/summary/metadata. |
| Ingestion | Pipeline that extracts, chunks, embeds, stores chunks, and marks document status. |
| Search | Query-time search over search chunks, optionally packed into context text. |
| Hybrid search | Search mode that fuses vector and text search rankings. |
| Search scope | Caller-provided collection or collections to search. Package does not interpret tenant semantics. |
| Search index store | Persistence contract for collections, documents, chunks, status, and search. |
| Vector store | Compatibility naming over search-store chunk search contracts. |
| Knowledge store | Persistence contract for non-index knowledge records and context assembly. |
| Artifact store | Persistence contract for artifact bytes/metadata. |
| Host | App using the package; owns auth, DB, object storage, providers, permissions, and policy. |

## Context policy

| Policy | Meaning |
| --- | --- |
| `pinned` | Host may inject into model startup context |
| `routable` | Host may use for routing/dispatch decisions |
| `searchable` | Host may expose through search tools |
| `archived` | Retained but normally omitted from active context/search |

## Host responsibilities

- Own users, teams, permissions, routing, and product policy.
- Implement `KnowledgeStore` and `KnowledgeArtifactStore` with app storage.
- Own concrete extraction, embeddings, search ingestion, R2/S3 layout, and DB schema.
- Decide which knowledge is pinned, searchable, routable, or archived.

## Boundaries

- No app auth, DB drivers, object storage SDKs, React, Next.js, or provider SDKs.
- Search/chunking APIs are exposed as flat knowledge subpaths; concrete stores and providers remain app-owned.
- Package owns semantics and contracts only.
