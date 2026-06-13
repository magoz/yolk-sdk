# Core Domain

Domain actions and Effect functions. App routes/pages call here; services remain infrastructure in `examples/next/lib/services/*`.

## Structure

| Path                         | Role                                           |
| ---------------------------- | ---------------------------------------------- |
| `agent/*-action.ts`          | Provider OAuth, skill/command, connector server actions |
| `agent/openai-codex-auth.ts` | Codex token persistence + refresh helpers      |
| `agent/anthropic-claude-auth.ts` | Claude token persistence + refresh helpers |
| `agent/agent-skill.ts`      | User-owned DB skill CRUD and validation        |
| `agent/agent-command.ts`    | User-owned DB command CRUD and validation      |
| `agent/anthropic-claude-oauth-cookie.ts` | Claude PKCE verifier/state cookie names; keep constants out of `'use server'` files |
| `agent/AGENTS.md`            | Agent OAuth, skill/command, connector contracts |
| `knowledge/*`                | `/knowledge` domain functions/actions; file/text records + search/context policy |
| `storage/*`                  | `/storage` domain functions/actions; source ingestion + knowledge search ingestion |
| `errors/index.ts`            | Shared domain errors                           |

## Server Actions

See `examples/next/patterns/EFFECT_SERVER_ACTIONS.md` for the canonical Next boundary pattern.

- One action per `*-action.ts` file with `'use server'`.
- Return explicit result ADTs (`Success`/`Error`/domain states), not thrown UI errors.
- Call `await cookies()` before `NextEffect.runPromise()` when action must be dynamic/session-bound.
- Use `NextEffect.runPromise()` + `AppLayer` + `Effect.scoped`.
- Add `Effect.withSpan(...)` and annotate current span with useful ids.
- `UnauthenticatedError` redirects to `/login` via `NextEffect.redirect()`.
- Catch expected auth/domain errors before generic reporting where possible; return safe UI messages.
- Put `Effect.map` / `Effect.as({ _tag: 'Success' })` before expected `catchTag`s so handled error ADTs are not remapped to success.
- Revalidate affected pages (`revalidatePath('/agent')`) only after successful mutation.
- Client components call result-returning server actions directly from event handlers in `startTransition(async () => ...)`; do not pass them to `<form action>` / `formAction` unless the action is redirect-only.

## Domain Functions

- Return Effect values; do not run effects inside helpers.
- Pull infrastructure through services (`Db`, `OpenAiCodexOAuth`, etc.).
- Storage/knowledge search domain functions use app-owned `AppKnowledgeSearchLayer` at boundaries; `@yolk-sdk/knowledge/*` owns pipeline contracts only.
- Keep provider/OAuth API calls in services; core composes persistence and policy.
- Store provider OAuth tokens in Better Auth `account` rows with provider ids (`openai-codex`, `anthropic-claude`).
- Store user-configured connector credentials in `agentConnector`, not Better Auth `account` rows.
- Store user-authored agent skills in `agentSkill`; runtime loaders convert enabled rows into `SkillsetManifest` data.
- Store user-authored slash commands in `agentCommand`; runtime loaders convert enabled rows into `SkillsetManifest` commands.
- When creating/updating a skill with a matching command, use the transactional `*WithCommand` helpers so skill and command writes cannot partially succeed.
- Refresh tokens in `getValid*Token()` helpers and persist refreshed token before returning.
- `'use server'` files may export only async functions; move shared constants/types to non-server modules.

## Errors

- Shared domain errors live in `errors/index.ts`.
- Domain-owned errors may live beside the domain; service integration errors stay with the service.
- Empty DB write results are typed `PersistenceError` failures, not defects.
- Prefer discriminated results at UI boundaries; use tagged errors inside Effect pipelines.

## Anti-Patterns

- Multiple actions in one file.
- CRUD mutation in `examples/next/app/api` instead of a server action.
- Raw `process.env`, external HTTP, or provider SDK calls in core domain helpers.
- `Effect.runPromise()` inside reusable domain functions.
