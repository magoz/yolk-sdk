# Storage UI

User-facing file ingestion and source management UI.

## Current scope

- `/storage` is dynamic/session-gated.
- V1 supports multi-file drag/drop uploads for text, markdown, CSV, JSON, PDF, DOCX, XLSX, and PPTX.
- Ingested sources render as a compact list; details/preview stay collapsed by default.
- File upload uses server-action presigned R2 PUT URLs, then a finalize action indexes bytes; no `FormData` upload through Next.
- Source create/delete mutations use server actions in `examples/next/lib/core/storage/*-action.ts`.
- Ingestion runs synchronously through `@yolk-sdk/knowledge/ingestion` + `AppKnowledgeSearchLayer`; future background queues should preserve the same document status lifecycle.

## Boundaries

- UI says Storage; package/API concepts may say knowledge search.
- Keep source ownership/permissions in app/domain code, not package contracts.
- CRUD stays in server actions, not API routes.
