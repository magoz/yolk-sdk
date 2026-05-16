# RAG Package + Storage Vision PRD

## Goal

Define a domain-free `@yolk/rag` package for retrieval, ingestion, chunking, embedding, and search, plus the Yolk app boundary that uses it for user-facing storage.

## Principles

- Effect-first APIs and services.
- Package owns RAG semantics.
- App owns product semantics.
- Package must not know users, orgs, projects, permissions, R2 layouts, routes, or UI.
- Concrete storage, embedding providers, and parser adapters are host-owned layers.

## Package Scope

`@yolk/rag` provides reusable RAG primitives and pipelines:

- `RagSet`
- `RagDocument`
- `RagChunk`
- `RagSource`
- `RagStore`
- `RagExtractor`
- `RagChunker`
- `RagEmbedder`
- ingestion pipeline
- retrieval/search helpers
- optional agent tool adapters

## Package Non-Goals

`@yolk/rag` does not own:

- app ownership (`kind`, `ownerId`, user/org/project ids)
- auth or permissions
- R2/S3 object layout
- upload/download flows
- Next.js routes/actions/UI
- provider SDKs
- database drivers
- queue/workflow implementations
- heavy Node-only extractors in the portable core

## Core Model

```txt
RagSet
  id
  label?
  embeddingConfig
  chunkingConfig
  metadata?

RagDocument
  id
  ragSetId
  source
  status
  title?
  summary?
  contentHash?
  metadata?

RagChunk
  id
  ragSetId
  documentId
  content
  position
  tokenCount
  metadata?
```

`RagSet` is a retrieval/index namespace and configuration boundary. It has no product ownership fields.

## Status Lifecycle

```txt
pending -> processing -> ready
                    \\-> error
```

Statuses:

- `pending`: accepted for future/background ingestion
- `processing`: extraction/chunking/embedding/storage in progress
- `ready`: searchable
- `error`: failed with typed error metadata/message

## Effect Services

### RagStore

One store service owns lifecycle and vector-search contracts.

```ts
RagStore
  upsertSet
  getSet
  upsertDocument
  markDocumentProcessing
  replaceDocumentChunks
  markDocumentReady
  markDocumentError
  deleteDocument
  searchChunks
  getContextChunks
```

Reasoning:

- document readiness depends on chunk persistence
- deletion/reindex needs metadata + vectors together
- app implementations can still compose metadata DB + external vector DB internally

### RagExtractor

Package defines extraction contracts and source shapes.

```txt
RagSource
  File(ref, name?, mediaType?)
  Url(url)
  Text(label?)
```

Package does not load bytes from R2 or fetch private URLs. App turns app-owned sources into loaded extraction inputs.

Portable/basic extractors may live in package. Heavy parsers can live in app adapters or future node-specific subpaths.

### RagChunker

Default strategy:

- sanitize text
- split paragraphs/sentences
- fallback to words
- fallback to encoded tokens
- ordered chunks
- no overlap by default

Chunking config:

```ts
type RagChunkingConfig = {
  readonly strategy: 'sentence-token'
  readonly maxTokens: number
}
```

Default `maxTokens`: `512`.

### RagEmbedder

Package defines provider-neutral embedding service.

```ts
RagEmbedder
  embedTexts
  embedQuery
```

Embedding config:

```ts
type RagEmbeddingConfig = {
  readonly model: string
  readonly dimensions: number
}
```

No provider registry or SDKs in package.

## Ingestion

Package exposes a synchronous Effect program that is async/job-friendly.

```txt
1. upsert/mark document processing
2. extract content
3. chunk
4. embed
5. replace document chunks
6. mark ready
7. on failure, best-effort mark error, then fail original typed error
```

The app decides where ingestion runs:

- server action
- background job
- workflow
- queue consumer
- durable object
- CLI reindex script

The package records enough metadata for idempotency/reindex decisions:

- content hash
- source hash when available
- chunking config/version
- embedding config/version

## Retrieval/Search

V1 search is vector-only.

Input:

```ts
type RagSearchInput = {
  readonly scope: RagSearchScope
  readonly query: string
  readonly limit?: number
  readonly minScore?: number
  readonly contextChunks?: number
}
```

`contextChunks` fetches adjacent chunks at retrieval time rather than storing overlapped chunks.

Future extension points:

- hybrid keyword + vector search
- reranking
- query expansion
- result diversification

These should be hooks/services, not provider-coupled core logic.

## Subpaths

```txt
@yolk/rag
@yolk/rag/documents
@yolk/rag/store
@yolk/rag/extraction
@yolk/rag/chunking
@yolk/rag/embeddings
@yolk/rag/ingestion
@yolk/rag/retrieval
@yolk/rag/agent
```

Root stays small. Feature APIs use explicit subpaths.

## Agent Integration

`@yolk/rag/agent` provides generic helper adapters only.

The app owns:

- which `RagSet`s are searchable
- authorization
- tool name/description
- result formatting
- limits/context policy
- enablement

Example app-level tool: `search_storage`.

## Yolk App Vision

The product-facing concept is `/storage`.

The app owns:

- uploads
- signed R2 URLs
- file/source metadata
- source ownership and permissions
- document status UI
- delete/reindex flows
- search UI
- concrete `RagStore` implementation
- concrete `RagEmbedder` implementation
- concrete extractor adapters

## App Boundary Model

Recommended app model:

```txt
storageObject
  id
  owner scope
  sourceType
  r2Key/url/textRef
  filename/mime/size/hash
  createdAt

ragSet
  id
  label
  embeddingConfig
  chunkingConfig
  createdAt

ragDocument
  id
  ragSetId
  storageObjectId
  status
  title/summary/error
  contentHash
  processedAt

ragChunk
  id
  ragSetId
  documentId
  content
  embedding
  position
  tokenCount
```

The app may simplify initially, but separating `storageObject` from `ragDocument` keeps raw source lifecycle distinct from index lifecycle.

## Decisions

- Package name: `@yolk/rag`
- Product route: `/storage`
- Use `RagSet` in package
- `RagSet` excludes `kind` and `ownerId`
- One `RagStore` service, not split document/vector stores
- Effect-first services and pipelines
- Status includes `pending | processing | ready | error`
- Default chunking: sentence/token, no overlap
- Retrieval supports `contextChunks`
- Search v1: vector only
- Embedding config: model string + dimensions
- Extractor contract in package; heavy concrete extractors outside portable core
- Agent integration via generic helpers; app owns actual tool policy

## Open App Decisions

- Separate `storageObject` vs merge with `ragDocument` for v1.
- Confirm `/storage` final route.
- Choose v1 supported file types.
