# Agent Domain

Domain functions and server actions for provider OAuth, skills/commands, and connectors.

## Storage

- Tokens live in Better Auth `account` rows.
- Provider ids: `openai-codex`, `anthropic-claude`.
- OpenAI `accountId` stores ChatGPT account id when available.
- Cloudflare token bridge returns access/account/expiry only; refresh tokens stay in Next/Postgres.
- Telegram connector credentials live in `agentConnector`, not Better Auth accounts.
- Agent skills/commands live in `agentSkill`/`agentCommand`; `*WithCommand` helpers keep paired writes transactional.

## Token helpers

- `getValidOpenAiCodexToken()` refreshes expired Codex tokens and persists refreshed state before returning.
- `getValidAnthropicClaudeToken()` refreshes expired Claude tokens and persists refreshed state before returning.
- Core composes persistence and OAuth services; provider HTTP exchange logic stays in `examples/next/lib/services/*-oauth`.
- Runtime adapters convert returned app token shapes to `@yolk-sdk/agent/oauth` `OAuthAccessToken`; core still owns refresh tokens.

## Server actions

- One action per `*-action.ts` file with `'use server'`.
- Redirect unauthenticated users via `NextEffect.redirect('/login')`.
- Revalidate `/agent` only after successful connect/disconnect mutation.
- Return explicit ADTs for UI state; do not leak provider error details.
- Skills, commands, and Telegram connector mutations share the same action/result discipline.

## Anthropic PKCE

- Verifier/state cookie names/constants live in non-`'use server'` module.
- Keep code verifier/state validation before token exchange.

## Anti-patterns

- Do not read raw env or call vendor HTTP directly here.
- Do not store refresh tokens in Cloudflare bootstrap responses.
