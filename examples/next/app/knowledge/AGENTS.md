# Knowledge UI

User-facing knowledge document management UI.

## Current scope

- `/knowledge` is dynamic/session-gated.
- V0 supports manual text and file knowledge documents.
- Pinned documents are injected into text agent startup context.
- Searchable documents are available through the `search_knowledge` agent tool.
- `/knowledge` also exposes direct UI search through `searchUserKnowledgeAction`.
- Original files can be downloaded through the authenticated file route.
- File upload uses server-action presigned R2 PUT URLs, then a finalize action stores file metadata and indexes bytes; no `FormData` upload through Next.
- Knowledge mutations use server actions in `examples/next/lib/core/knowledge/*-action.ts`.

## Boundaries

- UI says Knowledge.
- `/storage` remains separate; do not merge storage sources into this UI.
- Package concepts live in `@yolk-sdk/knowledge`; app owns user auth and persistence.
- CRUD stays in server actions, not API routes.
