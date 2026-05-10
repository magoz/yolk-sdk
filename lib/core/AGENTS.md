# Core Domain

Domain actions and pure Effect functions. App routes/pages call here; services remain infrastructure in `lib/services/*`.

## Structure

| Path | Role |
| --- | --- |
| `agent/*-action.ts` | OpenAI Codex connect/disconnect server actions |
| `agent/openai-codex-auth.ts` | Codex token persistence + refresh helpers |
| `errors/index.ts` | Shared domain errors |

## Server Actions

- One action per `*-action.ts` file with `'use server'`.
- Return explicit result ADTs (`Success`/`Error`/domain states), not thrown UI errors.
- Call `await cookies()` before `NextEffect.runPromise()` when action must be dynamic/session-bound.
- Use `NextEffect.runPromise()` + `AppLayer` + `Effect.scoped`.
- Add `Effect.withSpan(...)` and annotate current span with useful ids.
- `UnauthenticatedError` redirects to `/login` via `NextEffect.redirect()`.
- Report unexpected errors at the action boundary, then return safe UI messages.
- Revalidate affected pages (`revalidatePath('/agent')`) only after successful mutation.

## Domain Functions

- Return Effect values; do not run effects inside helpers.
- Pull infrastructure through services (`Db`, `OpenAiCodexOAuth`, etc.).
- Keep provider/OAuth API calls in services; core composes persistence and policy.
- Store Codex OAuth tokens in Better Auth `account` rows with `providerId = 'openai-codex'`.
- Refresh Codex tokens in `getValidOpenAiCodexToken()` and persist refreshed token before returning.

## Errors

- Shared domain errors live in `errors/index.ts`.
- Domain-owned errors may live beside the domain; service integration errors stay with the service.
- Prefer discriminated results at UI boundaries; use tagged errors inside Effect pipelines.

## Anti-Patterns

- Multiple actions in one file.
- CRUD mutation in `app/api` instead of a server action.
- Raw `process.env`, external HTTP, or provider SDK calls in core domain helpers.
- `Effect.runPromise()` inside reusable domain functions.
