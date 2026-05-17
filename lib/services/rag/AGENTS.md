# App RAG Adapters

App-owned concrete adapters for the domain-free `@yolk/rag` package.

## Role

- `DrizzleRagStoreLayer`: implements `RagStore` over app Drizzle schema, pgvector, and Postgres full-text search.
- `TextRagExtractorLayer`: string-only extractor for V1 `/storage` text sources; derives title/summary via `RagDocumentSummarizer`.
- `OpenAiRagEmbedderLayer`: OpenAI embeddings via Effect `HttpClient` and `OPENAI_API_KEY`.
- `OpenAiRagDocumentSummarizerLayer`: OpenAI chat completion title + summary generation via Effect `HttpClient` and `OPENAI_API_KEY`.
- `AppRagLayer`: composed layer for storage/RAG ingestion and retrieval boundaries.

## Boundaries

- Keep product ownership in app DB rows (`storageObject.userId`, `ragSet.userId`).
- Keep package contracts domain-free: no users/orgs/R2/provider SDKs in `packages/rag`.
- Do not add `AppRagLayer` to global `AppLayer`; it should be provided only where RAG work runs.
- Use Effect `HttpClient`; no raw `fetch` or provider SDKs.

## Source model

- `storageObject` owns raw source refs/content.
- `ragDocument` owns index lifecycle and status.
- Text ingestion passes `storageObjectId` through package metadata so `DrizzleRagStoreLayer` can bind rows.

## Store adapter

- `DrizzleRagStoreLayer` is the app boundary for pgvector search; keep SQL/Drizzle details out of `@yolk/rag`.
- Public `RagStore` methods in `DrizzleRagStoreLayer` use `RagStore.*` spans so package ingestion/retrieval traces include concrete DB work.
- Preserve package `RagStoreError` values when mapping store failures; avoid double-wrapping typed not-found errors.
- `searchChunks` filters ready documents only and uses pgvector cosine distance.
- `searchChunksByText` filters ready documents only and uses Postgres full-text search over chunk content.
- `retrieveRag` defaults to hybrid retrieval: vector and text candidate searches are fused with reciprocal rank fusion before context expansion.
- `getContextChunks` expands adjacent chunks by `(ragSetId, documentId, position)`.

## Tests

- `live-layer.test.ts` covers set/doc/chunk lifecycle, vector search, keyword search, context expansion, delete cleanup.
- DB adapter tests run when `.env.test` provides `DATABASE_URL`; otherwise they skip.
