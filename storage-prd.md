# Yolk Storage PRD

## Goal

Add app-owned `/storage` as the product surface for files, text, URLs, and future knowledge sources. Every supported source can be indexed through `@yolk/rag` and searched by UI or agent tools.

## Principles

- Product language is Storage.
- RAG implementation remains behind package contracts.
- App owns auth, ownership, R2, DB schema, UI, and concrete layers.
- Package owns chunking, ingestion, retrieval, and service contracts.
- Source lifecycle and index lifecycle stay separate.

## V1 Scope

- Store source metadata.
- Create user-scoped `RagSet`s.
- Ingest text/markdown content first.
- Persist documents/chunks in Postgres/pgvector.
- Provide app `RagStore` adapter.
- Provide app `RagEmbedder` adapter.
- Provide app extractor/source-loader adapter.
- Add minimal `/storage` list/search/ingest UI later.
- Add `search_storage` agent tool later.

## Non-Goals

- No public file sharing.
- No folder hierarchy.
- No OCR.
- No PDF/DOCX parser in first app slice.
- No queue/workflow in first slice; ingestion remains callable synchronously but lifecycle is queue-ready.
- No package ownership/auth concepts.

## Data Model

```txt
storageObject
  id
  userId
  sourceType: file | url | text
  r2Key?
  url?
  textContent?
  filename?
  mediaType?
  byteSize?
  contentHash?
  createdAt
  updatedAt

ragSet
  id
  userId
  label?
  embeddingModel
  embeddingDimensions
  chunkingStrategy
  chunkMaxTokens
  createdAt
  updatedAt

ragDocument
  id
  ragSetId
  storageObjectId
  sourceType
  status: pending | processing | ready | error
  title?
  summary?
  errorMessage?
  contentHash?
  tokenCount?
  chunkCount?
  createdAt
  updatedAt

ragChunk
  id
  ragSetId
  documentId
  content
  embedding vector(1536)
  position
  tokenCount
  createdAt
```

## Boundaries

### App owns

- `storageObject` ownership and source bytes/refs.
- `ragSet.userId` and permissions.
- Concrete `RagStore` with Drizzle + pgvector.
- Concrete `RagEmbedder` using app-approved provider config.
- Concrete `RagExtractor` and source loading.
- Server actions and UI.

### Package owns

- `RagSet`, `RagDocument`, `RagChunk` contracts.
- `RagStore`, `RagExtractor`, `RagChunker`, `RagEmbedder` service contracts.
- Ingestion and retrieval pipelines.
- Generic agent helper.

## Ingestion Flow

```txt
1. User creates storageObject.
2. App resolves user's default ragSet.
3. App builds LoadedRagSource from storageObject.
4. App runs @yolk/rag ingestRagDocument with app layers.
5. DrizzleRagStore persists status/chunks.
6. UI reads status from app tables.
```

## Retrieval Flow

```txt
1. App checks session/ownership.
2. App maps request to allowed ragSet ids.
3. retrieveRag embeds query.
4. DrizzleRagStore runs vector search scoped by ragSet.
5. Optional contextChunks fetch adjacent chunks.
```

## Implementation Phases

1. DB schema + relations.
2. Drizzle `RagStore` adapter.
3. OpenAI `RagEmbedder` adapter.
4. Text/markdown `RagExtractor` adapter.
5. Core domain functions/actions.
6. Minimal `/storage` UI.
7. `search_storage` agent tool.

## Open Decisions

- R2 upload API shape.
- First non-text file parsers.
- Background ingestion runtime.
