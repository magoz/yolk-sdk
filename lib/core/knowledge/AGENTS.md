# Knowledge Domain

App-owned knowledge use-cases and agent context helpers.

## Role

- Compose `@yolk/knowledge` contracts with app services, auth, and policy.
- Keep reusable models in `packages/knowledge`.
- Keep DB/R2 concrete adapters in `lib/services/knowledge`.

## Current scope

- Manual text and file knowledge creation; file text extraction reuses `FileExtractor`.
- Representation indexing uses `RagChunker` + `RagEmbedder` and writes `knowledgeChunk` rows.
- Hybrid vector + FTS search filters to authenticated user, ready objects, non-archival policy.
- Pinned knowledge context loading for text agents; unavailable context logs warning and proceeds.
- Delete removes owned R2 artifacts before deleting DB rows.
- User-owned v0: scope id maps to authenticated `userId`.

## Context policy

- `pinned`: injected into startup context.
- `routable`: reserved for routing/dispatch semantics.
- `searchable`: searchable via `search_knowledge`.
- `archival`: retained but excluded from active search/context.

## Boundaries

- Domain helpers return Effect values; do not run effects inside helpers.
- No provider SDKs or raw env access here.
- Provide `AppRagLayer`, `DrizzleKnowledgeStoreLayer`, and `R2KnowledgeArtifactStoreLayer` at action/route boundaries as needed.
- UI/server actions belong in separate `*-action.ts` files when added.
