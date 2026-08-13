# Yolk

Reusable agent stack. Domain-free below the app layer.

## Private app/example stack

| Category  | Technology                               |
| --------- | ---------------------------------------- |
| Example   | Next.js 16 App Router                    |
| Docs      | Fumadocs + Next.js                       |
| Language  | TypeScript 5                             |
| Effects   | Effect-TS                                |
| Database  | PostgreSQL via Drizzle ORM + @effect/sql |
| Auth      | better-auth email OTP                    |
| Email     | Resend                                   |
| Styling   | Tailwind CSS 4                           |
| Telemetry | OpenTelemetry + PostHog                  |
| Tests     | Vitest + Playwright                      |

## Packages

Public packages use the `@yolk-sdk/*` scope and release in lockstep.

The Next.js app in `examples/next` is a dogfood/reference app for the SDK.

| Package                      | Role                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@yolk-sdk/agent`            | Agent protocol, loop, runtime, client, compaction, tools, React, providers, OAuth, skillset, and voice |
| `@yolk-sdk/mcp`              | MCP v2 client/server/protocol APIs, Effect/Yolk adapters, and legacy compatibility                     |
| `@yolk-sdk/knowledge`        | Knowledge document/source/file/context, ingestion, hybrid search, and lookup/manage tool helpers       |
| `@yolk-sdk/connectors`       | Effect-native connector, integration, credential, and action primitives                                |
| `@yolk-sdk/sandbox`          | Sandbox execution plane, agent tool, Vercel adapter, and testing fakes                                 |
| `@yolk-sdk/vercel-workflows` | Workflow loop contract, durable stream helpers, and Effect host wrappers                               |

Docs site source lives in `apps/docs` and uses Fumadocs to explain the public SDK package set.

Canary install example:

```bash
pnpm add @yolk-sdk/agent@canary
```

Dependency rule:

See `packages/AGENTS.md` and `patterns/PACKAGE_ARCHITECTURE.md` for package boundaries/public subpaths, and `patterns/PACKAGE_DISTRIBUTION.md` for release policy.

No users, teams, orgs, projects, billing, or product permissions below app.

Release note: GitHub Actions publishes through npm trusted publishing. Provenance is disabled while this repo is private because npm only supports GitHub Actions provenance for public source repositories. If the repo becomes public, remove `NPM_CONFIG_PROVENANCE: false` and `--provenance=false` from `.github/workflows/publish.yml` to re-enable provenance attestations.

## Setup

```bash
pnpm install
cp examples/next/.env.example examples/next/.env.local
pnpm dev
```

## Example app smoke test

Current `examples/next` agent surfaces:

- runtime chooser at `/agent`
- text + image/PDF + mic voice mode in `/agent/next`, `/agent/cloudflare`, and `/agent/workflow`
- text tools: web fetch/search, knowledge/storage search, skill, virtual bash, optional remote MCP, optional Telegram, HITL question, subagents
- `/agent/next`: no durable persistence; browser sends full protocol transcript each turn
- `/agent/cloudflare`: Worker/Durable Object WS runtime with append-log storage
- `/agent/workflow`: Vercel Workflow durable run stream
- streaming NDJSON token events, including `AgentRetry`
- in-band `AgentError` events for stream failures with safe provider metadata
- tool execution failures surface as `ToolExecutionError` plus failed `ToolResult`, not terminal `AgentError`
- stop/cancel aborts active response streams; terminal protocol events drain HTTP bodies to EOF
- `/api/agent` runs stateless text exchanges from submitted messages

Text web tools:

- `web_fetch`: fetches a specific public `http(s)` URL; markdown/text/html output; no cookies, JS, search, or logged-in browsing
- `web_search`: calls Exa/Parallel MCP directly; no Yolk proxy; optional `EXA_API_KEY`, `PARALLEL_API_KEY`, `YOLK_WEBSEARCH_PROVIDER=exa|parallel`

Text model defaults:

```txt
default provider: OpenAI Codex OAuth
default model: gpt-5.5
available text models: gpt-5.5, claude-sonnet-4-6
gpt-5.5 max output tokens: 128000
claude-sonnet-4-6 max output tokens: 64000
```

Optional prompt override:

```txt
AGENT_SYSTEM_PROMPT="You are Yolk assistant. Be concise."
```

Connect OpenAI Codex or Anthropic Claude from an agent runtime page. These use subscription OAuth flows, not provider API keys. Ask prompts like `summarize https://example.com` or `what is magoz.com about?` to test web tools.

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

See `packages/AGENTS.md` and `patterns/PACKAGE_ARCHITECTURE.md` for package design.
