# App Agent Wiring

App-owned provider/runtime glue over the domain-free `packages/*` agent stack.

## Current Mode

- Text-only `/agent` UI and `/api/agent` route
- No tools: `NoToolExecutorLayer` rejects accidental tool execution
- No durable transcript: `StatelessSessionStoreLayer` loads empty, save is no-op
- Route streams NDJSON token events to browser, including in-band `AgentError` failures

## Current Provider

Hardcoded in `app/api/agent/route.ts`:

| Env | Values | Notes |
| --- | --- | --- |
| `AGENT_SYSTEM_PROMPT` | string | Optional override |

Provider is Codex OAuth, model is `gpt-5.4`. Use `makeAgentRuntimeLayer(providerLayer)` to inject the provider; keep provider choice at app boundary.

## OpenAI API-Key Provider

- File: `providers/openai-provider.ts`
- Not wired to `/api/agent` while provider/model are hardcoded
- Uses `https://api.openai.com/v1/chat/completions`
- Requires `OPENAI_API_KEY`
- Supports text + image user input; no audio

## OpenAI Codex OAuth Provider

- File: `providers/openai-codex-provider.ts`
- Used for ChatGPT Plus/Pro/Max subscription access
- Does **not** use `OPENAI_API_KEY`
- Requires per-user Codex OAuth token from `lib/core/agent/openai-codex-auth.ts`
- Tokens stored in Better Auth `account` table with `providerId = 'openai-codex'`

Codex backend quirks:

- Endpoint: `https://chatgpt.com/backend-api/codex/responses`
- Request must set `store: false`
- Request must set `stream: true`
- Do not send `max_output_tokens`
- Send `originator: opencode`
- Send `ChatGPT-Account-Id` when token has account id
- Response may be SSE even with `content-type: text/plain`; detect by raw `event:`/`data:` body

## Tests

- Provider tests: `providers/*-provider.test.ts`
- Route encoding/schema tests: `route-handler.test.ts`
- Keep regression tests for provider quirks close to provider implementation.
