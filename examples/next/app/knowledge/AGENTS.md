# Knowledge UI

User-facing knowledge record management UI.

## Current scope

- `/knowledge` is dynamic/session-gated.
- V0 supports manual text and file knowledge records.
- Pinned records are injected into text agent startup context.
- Searchable/routable records are available through the `search_knowledge` agent tool.
- Original file artifacts can be downloaded through the authenticated artifact route.
- Knowledge mutations use server actions in `examples/next/lib/core/knowledge/*-action.ts`.

## Boundaries

- UI says Knowledge.
- `/storage` remains separate; do not merge storage sources into this UI.
- Package concepts live in `@yolk-sdk/knowledge`; app owns user auth and persistence.
- CRUD stays in server actions, not API routes.
