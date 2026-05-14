# Core Domain

Domain actions and Effect functions. App routes/pages call here; services remain infrastructure in `lib/services/*`.

## Structure

| Path                         | Role                                           |
| ---------------------------- | ---------------------------------------------- |
| `agent/*-action.ts`          | Provider connect/disconnect server actions     |
| `agent/openai-codex-auth.ts` | Codex token persistence + refresh helpers      |
| `agent/anthropic-claude-auth.ts` | Claude token persistence + refresh helpers |
| `agent/anthropic-claude-oauth-cookie.ts` | Claude PKCE verifier cookie name; keep constants out of `'use server'` files |
| `agent/AGENTS.md`            | Agent OAuth storage/action contracts           |
| `errors/index.ts`            | Shared domain errors                           |

## Server Actions

- One action per `*-action.ts` file with `'use server'`.
- Return explicit result ADTs (`Success`/`Error`/domain states), not thrown UI errors.
- Call `await cookies()` before `NextEffect.runPromise()` when action must be dynamic/session-bound.
- Use `NextEffect.runPromise()` + `AppLayer` + `Effect.scoped`.
- Add `Effect.withSpan(...)` and annotate current span with useful ids.
- `UnauthenticatedError` redirects to `/login` via `NextEffect.redirect()`.
- Catch expected auth/domain errors before generic reporting where possible; return safe UI messages.
- Revalidate affected pages (`revalidatePath('/agent')`) only after successful mutation.

## Domain Functions

- Return Effect values; do not run effects inside helpers.
- Pull infrastructure through services (`Db`, `OpenAiCodexOAuth`, etc.).
- Keep provider/OAuth API calls in services; core composes persistence and policy.
- Store provider OAuth tokens in Better Auth `account` rows with provider ids (`openai-codex`, `anthropic-claude`).
- Refresh tokens in `getValid*Token()` helpers and persist refreshed token before returning.
- `'use server'` files may export only async functions; move shared constants/types to non-server modules.

## Errors

- Shared domain errors live in `errors/index.ts`.
- Domain-owned errors may live beside the domain; service integration errors stay with the service.
- Prefer discriminated results at UI boundaries; use tagged errors inside Effect pipelines.

## Anti-Patterns

- Multiple actions in one file.
- CRUD mutation in `app/api` instead of a server action.
- Raw `process.env`, external HTTP, or provider SDK calls in core domain helpers.
- `Effect.runPromise()` inside reusable domain functions.
