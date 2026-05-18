# Knowledge UI

User-facing knowledge object management UI.

## Current scope

- `/knowledge` is dynamic/session-gated.
- V0 supports manual text and file knowledge objects.
- Pinned objects are injected into text agent startup context.
- Searchable/routable objects are available through the `search_knowledge` agent tool.
- Original file artifacts can be downloaded through the authenticated artifact route.
- Knowledge mutations use server actions in `lib/core/knowledge/*-action.ts`.

## Boundaries

- UI says Knowledge.
- `/storage` remains separate; do not merge storage sources into this UI.
- Package concepts live in `@yolk/knowledge`; app owns user auth and persistence.
- CRUD stays in server actions, not API routes.
