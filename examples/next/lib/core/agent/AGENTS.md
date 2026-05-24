# Agent Auth Domain

Domain functions and server actions for provider subscription OAuth state.

## Storage

- Tokens live in Better Auth `account` rows.
- Provider ids: `openai-codex`, `anthropic-claude`.
- OpenAI `accountId` stores ChatGPT account id when available.
- Cloudflare token bridge returns access/account/expiry only; refresh tokens stay in Next/Postgres.

## Token helpers

- `getValidOpenAiCodexToken()` refreshes expired Codex tokens and persists refreshed state before returning.
- `getValidAnthropicClaudeToken()` refreshes expired Claude tokens and persists refreshed state before returning.
- Core composes persistence and OAuth services; provider HTTP exchange logic stays in `examples/next/lib/services/*-oauth`.
- Runtime adapters convert returned app token shapes to `@yolk-sdk/oauth` `OAuthAccessToken`; core still owns refresh tokens.

## Server actions

- One action per `*-action.ts` file with `'use server'`.
- Redirect unauthenticated users via `NextEffect.redirect('/login')`.
- Revalidate `/agent` only after successful connect/disconnect mutation.
- Return explicit ADTs for UI state; do not leak provider error details.

## Anthropic PKCE

- Verifier cookie name/constants live in non-`'use server'` module.
- Keep code verifier/state validation before token exchange.

## Anti-patterns

- Do not read raw env or call vendor HTTP directly here.
- Do not store refresh tokens in Cloudflare bootstrap responses.
