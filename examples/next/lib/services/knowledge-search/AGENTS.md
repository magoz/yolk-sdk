# App knowledge search Adapters

App-owned concrete adapters for the domain-free knowledge search contracts.

## Role

- `DrizzleSearchIndexStoreLayer`: implements `SearchIndexStore` over app Drizzle schema, pgvector, and Postgres full-text search.
- `TextKnowledgeExtractorLayer`: string extractor for normalized storage ingestion content: manual text plus extracted files; preserves metadata title.
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
- Reconstruct package sources with `knowledgeSourceFromStorageRow` in `storage-source.ts` (used by `DrizzleSearchIndexStoreLayer`). The row type is `Pick` of the actual Drizzle `storageObject` select, not a shadow Schema enum.
- **File identity is opaque `storageObject.id`.** Current ingest (`createFileStorageObject`) does not write `r2Key` and passes `KnowledgeFileSource.make({ ref: object.id, ... })`. Null `r2Key` is valid. A legacy `r2Key` must not replace id. Do not fabricate a URL from id, and do not treat R2 keys as File refs.
- **Url identity is the stored `url` column.** Missing/empty url fails as `SearchIndexStoreError`. Never substitute storage id or `r2Key` for a missing URL.
- Opaque locators (`id`, url) are not trimmed. Surrounding whitespace fails rather than mutating identity.
- Optional File `name` / `mediaType` and Text `label` come from filename/mediaType display metadata: use an absent optional value when the column is null or blank (after trim for those display strings only); constructor inputs may contain `undefined` keys. Do not pass empty strings.
- Invalid rows fail the store Effect (`getDocument` / search). Matching rows are not dropped.
- Persisted collection/document ids are Effect-decoded into `KnowledgeScopeId` /
  `KnowledgeDocumentId` in `indexed-rows.ts` before constructing package models.
- jsonb `metadata` is `$type<unknown>()` and decoded/encoded with `persisted-json-object` at store and app CRUD boundaries. Invalid metadata fails `SearchIndexStoreError` / `AppSearchIndexStoreError`; hits are not omitted and `{}` is not substituted. Open keys such as `storageObjectId` and `title` are preserved.
- This adapter policy is app-owned. Package `KnowledgeFileSource.ref` remains an opaque string; hosts still must not invent locators to satisfy `.make`.

## Store adapter

- `DrizzleSearchIndexStoreLayer` is the app boundary for pgvector search; keep SQL/Drizzle details out of `@yolk-sdk/knowledge`.
- Public `SearchIndexStore` methods in `DrizzleSearchIndexStoreLayer` use `SearchIndexStore.*` spans so package ingestion/search traces include concrete DB work.
- Preserve package `SearchIndexStoreError` values when mapping store failures; avoid double-wrapping typed not-found errors.
- `searchChunks` filters ready documents only and uses pgvector cosine distance.
- `searchChunksByText` filters ready documents only and uses Postgres full-text search over chunk content.
- `searchKnowledge` defaults to hybrid search: vector and text candidate searches are fused with reciprocal rank fusion before context expansion.
- `getContextChunks` expands adjacent chunks by `(scopeId, documentId, position)`.

## Tests

- Always-on `live-layer.test.ts` reconstruction cases cover File identity (including null and legacy `r2Key`), URL validation, optional display metadata, and jsonb metadata decode failures without a database.
- Its DB suite covers set/doc/chunk lifecycle, vector search, keyword search, context expansion, delete cleanup.
- DB adapter tests run when `.env.test` provides `DATABASE_URL`; otherwise they skip.
