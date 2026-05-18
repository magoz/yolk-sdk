# Knowledge UI

User-facing knowledge object management UI.

## Current scope

- `/knowledge` is dynamic/session-gated.
- V0 supports manual text and file knowledge objects.
- Pinned objects are injected into text agent startup context.
- Knowledge mutations use server actions in `lib/core/knowledge/*-action.ts`.

## Boundaries

- UI says Knowledge.
- Package concepts live in `@yolk/knowledge`; app owns user auth and persistence.
- CRUD stays in server actions, not API routes.
