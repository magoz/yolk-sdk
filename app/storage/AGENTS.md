# Storage UI

User-facing source ingestion and index status UI.

## Current scope

- `/storage` is dynamic/session-gated.
- V1 supports pasted text sources.
- Mutations use server actions in `lib/core/storage/*-action.ts`.
- Ingestion runs synchronously through `@yolk/rag` + `AppRagLayer`; future background queues should preserve the same document status lifecycle.

## Boundaries

- UI says Storage; package/API concepts may say RAG.
- Keep source ownership/permissions in app/domain code, not package contracts.
- CRUD stays in server actions, not API routes.
