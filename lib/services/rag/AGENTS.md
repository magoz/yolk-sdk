# App RAG Adapters

App-owned concrete adapters for the domain-free `@yolk/rag` package.

## Role

- `DrizzleRagStoreLayer`: implements `RagStore` over app Drizzle schema + pgvector.
- `TextRagExtractorLayer`: string-only extractor for V1 `/storage` text sources.
- `OpenAiRagEmbedderLayer`: OpenAI embeddings via Effect `HttpClient` and `OPENAI_API_KEY`.
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
