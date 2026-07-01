# Knowledge Domain

App-owned knowledge use-cases and agent context helpers.

## Role

- Compose `@yolk-sdk/knowledge` contracts with app services, auth, and policy.
- Keep reusable models in `packages/knowledge`.
- Keep DB/R2 concrete adapters in `examples/next/lib/services/knowledge`.

## Current scope

- Manual text and file knowledge creation; file text extraction reuses `FileExtractor`.
- File upload is presigned R2 PUT + finalize action; finalize clones downloaded bytes before extraction because PDF parsing may detach ArrayBuffers.
- `listUserKnowledgeDocuments` returns document summaries for agent discovery before search/traversal.
- Search ingestion uses `KnowledgeChunker` + `KnowledgeEmbedder` and writes chunk rows.
- Hybrid vector + FTS search filters to authenticated user, ready documents, active availability.
- `getKnowledgeContext` traverses a chunk window around a search citation/document position for “show more/continue” flows.
- Pinned knowledge context loading for text agents; unavailable context logs warning and proceeds.
- Delete removes owned R2 files before deleting DB rows.
- User-owned v0: scope id maps to authenticated `userId`.

## Availability

- `pinned`: injected into startup context.
- `searchable`: searchable via `search_knowledge`.
- `archived`: retained but excluded from active search/context.

## Boundaries

- Domain helpers return Effect values; do not run effects inside helpers.
- No provider SDKs or raw env access here.
- Provide `AppKnowledgeSearchLayer`, `DrizzleKnowledgeStoreLayer`, and R2 layers at action/route boundaries as needed.
- Preserve original file bytes separately from extractor input; never reuse extractor-mutated buffers for metadata/indexing.
- UI/server actions belong in separate `*-action.ts` files when added.
