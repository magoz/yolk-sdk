# App knowledge search Adapters

App-owned concrete adapters for the domain-free knowledge search contracts.

## Role

- `DrizzleSearchIndexStoreLayer`: implements `SearchIndexStore` over app Drizzle schema, pgvector, and Postgres full-text search.
- `TextKnowledgeExtractorLayer`: string-only extractor for V1 `/storage` text sources; preserves metadata title.
- `OpenAiKnowledgeEmbedderLayer`: OpenAI embeddings via Effect `HttpClient` and `OPENAI_API_KEY`.
- `OpenAiKnowledgeDocumentSummarizerLayer`: OpenAI chat completion title + summary generation via Effect `HttpClient` and `OPENAI_API_KEY`.
- `AppKnowledgeSearchLayer`: composed layer for storage/knowledge search ingestion and search boundaries.

## Boundaries

- Keep product ownership in app DB rows (`storageObject.userId`, `knowledgeCollection.userId`).
- Keep package contracts domain-free: no users/orgs/R2/provider SDKs in `packages/knowledge`.
- Do not add `AppKnowledgeSearchLayer` to global `AppLayer`; it should be provided only where knowledge search work runs.
- Use Effect `HttpClient`; no raw `fetch` or provider SDKs.

## Source model

- `storageObject` owns raw source refs/content.
- `knowledgeDocument` owns search lifecycle and status.
- Text ingestion passes `storageObjectId` through package metadata so `DrizzleSearchIndexStoreLayer` can bind rows.

## Store adapter

- `DrizzleSearchIndexStoreLayer` is the app boundary for pgvector search; keep SQL/Drizzle details out of `@yolk-sdk/knowledge`.
- Public `SearchIndexStore` methods in `DrizzleSearchIndexStoreLayer` use `SearchIndexStore.*` spans so package ingestion/search traces include concrete DB work.
- Preserve package `SearchIndexStoreError` values when mapping store failures; avoid double-wrapping typed not-found errors.
- `searchChunks` filters ready documents only and uses pgvector cosine distance.
- `searchChunksByText` filters ready documents only and uses Postgres full-text search over chunk content.
- `searchKnowledge` defaults to hybrid search: vector and text candidate searches are fused with reciprocal rank fusion before context expansion.
- `getContextChunks` expands adjacent chunks by `(scopeId, documentId, position)`.

## Tests

- `live-layer.test.ts` covers set/doc/chunk lifecycle, vector search, keyword search, context expansion, delete cleanup.
- DB adapter tests run when `.env.test` provides `DATABASE_URL`; otherwise they skip.
