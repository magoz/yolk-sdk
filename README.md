# Yolk

Reusable agent stack. Domain-free below the app layer.

## Stack

| Category  | Technology                               |
| --------- | ---------------------------------------- |
| App       | Next.js 16 App Router                    |
| Language  | TypeScript 5                             |
| Effects   | Effect-TS                                |
| Database  | PostgreSQL via Drizzle ORM + @effect/sql |
| Auth      | better-auth email OTP                    |
| Email     | Resend                                   |
| Styling   | Tailwind CSS 4                           |
| Telemetry | Sentry + OpenTelemetry + PostHog         |
| Tests     | Vitest + Playwright                      |

## Packages

Public packages use the `@yolk-sdk/*` scope and release in lockstep.

| Package | Role |
| --- | --- |
| `@yolk-sdk/agent` | Protocol, loop, runtime, client, and tool primitives |
| `@yolk-sdk/react` | Headless React chat hook/state helpers |
| `@yolk-sdk/mcp` | MCP client/server/protocol adapters |
| `@yolk-sdk/rag` | Retrieval, ingestion, chunking, and store contracts |
| `@yolk-sdk/knowledge` | Knowledge object/artifact/provenance/context contracts |
| `@yolk-sdk/oauth` | Provider-neutral OAuth credential contracts |
| `@yolk-sdk/openai` | OpenAI/Codex auth constants and broker helpers |
| `@yolk-sdk/anthropic` | Anthropic Claude OAuth constants and broker helpers |
| `@yolk-sdk/vercel-workflows-runtime` | Vercel Workflow agent loop contract |
| `@yolk-sdk/skillset` | Portable skill/command parsing and catalogs |
| `@yolk-sdk/voice-runtime` | Realtime voice tool-call bridge |

Canary install example:

```bash
pnpm add @yolk-sdk/agent@canary
```

Dependency rule:

See `packages/AGENTS.md` and `patterns/PACKAGE_DISTRIBUTION.md` for package boundaries, release policy, and public subpaths.

No users, teams, orgs, projects, billing, or product permissions below app.

## Setup

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

## Agent smoke test

Current agent mode is intentionally minimal:

- runtime chooser at `/agent`
- text + mic voice mode in `/agent/next` and `/agent/cloudflare`
- text web tools: `web_fetch`, `web_search`
- `/agent/next`: no durable persistence; browser sends full protocol transcript each turn
- `/agent/cloudflare`: Worker/Durable Object WS runtime with append-log storage
- streaming NDJSON token events
- in-band `AgentError` events for stream failures
- stop/cancel aborts active response streams
- `/api/agent` runs stateless text exchanges from submitted messages

Text web tools:

- `web_fetch`: fetches a specific public `http(s)` URL; markdown/text/html output; no cookies, JS, search, or logged-in browsing
- `web_search`: calls Exa/Parallel MCP directly; no Yolk proxy; optional `EXA_API_KEY`, `PARALLEL_API_KEY`, `YOLK_WEBSEARCH_PROVIDER=exa|parallel`

Provider/model are hardcoded for now:

```txt
provider: OpenAI Codex OAuth
model: gpt-5.4
```

Optional prompt override:

```txt
AGENT_SYSTEM_PROMPT="You are Yolk assistant. Be concise."
```

Connect OpenAI Codex from an agent runtime page. This uses ChatGPT Plus/Pro/Max OAuth device flow and the Codex backend, not an OpenAI API key. Ask prompts like `summarize https://example.com` or `what is magoz.com about?` to test web tools.

Future: provider selection will become configurable again. The API-key OpenAI provider remains as tested scaffold, but `/api/agent` is Codex-only for now.

## Voice mode smoke test

The mic button in each agent runtime page uses GPT-Realtime-2 over WebRTC:

- browser: mic, model audio, Realtime data channel
- server: SDP exchange, `OPENAI_API_KEY`
- completed speech transcripts append to the shared chat transcript

Set `OPENAI_API_KEY`, sign in, open `/agent/next`, tap the mic, and ask a conversational prompt.

Then:

1. `pnpm dev`
2. sign in
3. open `/agent/next`
4. send a prompt

## Checks

```bash
pnpm check
pnpm test:run
```

See `ARCHITECTURE.md` and `AGENT_LOOP.md` for package design.
