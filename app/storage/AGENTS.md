# Storage UI

User-facing source ingestion, index status, and retrieval inspection UI.

## Current scope

- `/storage` is dynamic/session-gated.
- V1 supports pasted text sources and file uploads for text, markdown, CSV, JSON, PDF, DOCX, XLSX, and PPTX.
- V1 includes a retrieval test form that calls the same hybrid storage search path as the text agent.
- Retrieval test results link back to matching source cards when storage provenance metadata is available.
- Retrieval test stays disabled until at least one source is indexed and ready.
- Source create/delete mutations use server actions in `lib/core/storage/*-action.ts`.
- Ingestion runs synchronously through `@yolk/rag` + `AppRagLayer`; future background queues should preserve the same document status lifecycle.

## Boundaries

- UI says Storage; package/API concepts may say RAG.
- Keep source ownership/permissions in app/domain code, not package contracts.
- CRUD stays in server actions, not API routes.
