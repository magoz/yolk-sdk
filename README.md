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

## Checks

```bash
pnpm check
pnpm test:run
```

See `ARCHITECTURE.md` and `AGENT_LOOP.md` for package design.
