# Yolk

Reusable agent stack. Domain-free below the app layer.

## Stack

| Category | Technology |
| --- | --- |
| App | Next.js 16 App Router |
| Language | TypeScript 5 |
| Effects | Effect-TS |
| Database | PostgreSQL via Drizzle ORM + @effect/sql |
| Auth | better-auth email OTP |
| Email | Resend |
| Styling | Tailwind CSS 4 |
| Telemetry | Sentry + OpenTelemetry + PostHog |
| Tests | Vitest + Playwright |

## Packages

```txt
packages/
  protocol/       shared schemas, events, wire types
  agent-loop/     pure LLM <> tool loop
  agent-runtime/  reusable session/runtime shell
  client/         browser/client SDK
```

Dependency rule:

```txt
app -> agent-runtime -> agent-loop -> protocol
app -> client -> protocol
```

No users, teams, orgs, projects, billing, or product permissions below app.

## Setup

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

## Text agent smoke test

Current agent mode is intentionally minimal:

- text-only
- calculator tool enabled for tool-call smoke tests
- no durable persistence
- streaming NDJSON token events
- in-band `AgentError` events for stream failures
- stop/cancel aborts active response streams
- each `/api/agent` request runs one stateless exchange from the submitted prompt

Provider/model are hardcoded for now:

```txt
provider: OpenAI Codex OAuth
model: gpt-5.4
```

Optional prompt override:

```txt
AGENT_SYSTEM_PROMPT="You are Yolk assistant. Be concise."
```

Connect OpenAI Codex from `/agent`. This uses ChatGPT Plus/Pro/Max OAuth device flow and the Codex backend, not an OpenAI API key. Ask arithmetic prompts like `what is 19 * 23?` to test the calculator tool.

Future: provider selection will become configurable again. The API-key OpenAI provider remains as tested scaffold, but `/api/agent` is Codex-only for now.

## Voice agent smoke test

`/agent/voice` uses GPT-Realtime-2 over WebRTC:

- browser: mic, model audio, Realtime data channel
- server: SDP exchange, `OPENAI_API_KEY`, tool execution
- shared tool boundary: `ToolDef`/`ToolCall`/`ToolResult` + `ToolExecutor`
- calculator tool enabled for voice-to-action smoke tests

Set `OPENAI_API_KEY`, sign in, open `/agent/voice`, start voice, and ask `what is 19 times 23?`.

Then:

1. `pnpm dev`
2. sign in
3. open `/agent`
4. send a prompt

## Checks

```bash
pnpm check
pnpm test:run
```

See `ARCHITECTURE.md` and `AGENT_LOOP.md` for package design.
