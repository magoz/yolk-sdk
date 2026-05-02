# Yolk — Research Notes

## Vision

Build the **intelligence layer** for organizations. Inspired by [Block's "From Hierarchy to Intelligence"](https://block.xyz/inside/from-hierarchy-to-intelligence).

Block's thesis: hierarchy exists to route information. AI replaces the routing. A "world model" (company + customer) gives everyone at the edge the context they need without waiting for info to travel up/down a chain of command.

Yolk is the platform that makes this real for companies that aren't Block.

### Block's Four Components → Yolk Equivalents

| Block concept | Yolk equivalent |
|---|---|
| **Capabilities** (atomic financial primitives) | Integrations: Gmail, Calendar, Notion, Todoist, LinkedIn, Telegram, R2, etc. |
| **World model** (company + customer) | Knowledge store — flat files in Cloudflare Artifacts, versioned, per-team |
| **Intelligence layer** (composes capabilities) | Pi agents with access to world model + capabilities |
| **Interfaces** (delivery surfaces) | Web app, scheduled agents, notifications |

### Three Roles (from Block)

- **ICs** — deep specialists building capabilities. World model provides context.
- **DRIs** — own cross-cutting problems with full authority. Agent assists.
- **Player-coaches** — build + develop people. No status meetings; system handles alignment.

---

## Agent Runtime: Pi

[pi.dev](https://pi.dev) — minimal terminal coding agent harness by Mario Zechner (Earendil Inc.).

### Pi Monorepo Structure

Source: `~/dev/docs/pi-mono`

```
pi-mono/
├── packages/ai/            # Provider abstraction (streaming, models, costs)
├── packages/agent/         # Core agent loop — runs ANYWHERE (browser, server, sandbox)
│   └── src/
│       ├── agent.ts        # Agent class: state, subscribe, prompt, abort, steer, followUp
│       ├── agent-loop.ts   # Low-level loop: stream → tool execution → steering
│       ├── proxy.ts        # streamProxy() — proxy LLM calls through a server
│       └── types.ts        # StreamFn, AgentTool, AgentState, AgentEvent, etc.
├── packages/coding-agent/  # Terminal CLI (extensions, skills, sessions, RPC, SDK)
│   └── src/
│       ├── core/
│       │   └── sdk.ts      # createAgentSession() — main factory
│       ├── modes/
│       │   ├── rpc/        # JSON-RPC over stdin/stdout
│       │   ├── interactive/ # TUI mode
│       │   └── print/      # One-shot mode
│       └── cli.ts
├── packages/tui/           # Terminal UI components
└── packages/web-ui/        # Browser UI (Lit + Tailwind)
    └── src/
        ├── ChatPanel.ts    # High-level chat component
        ├── components/
        │   ├── AgentInterface.ts  # Core chat: messages, input, streaming
        │   ├── Messages.ts        # Message rendering
        │   └── SandboxedIframe.ts # Artifact sandboxing
        ├── storage/        # IndexedDB backend
        └── tools/          # JS REPL, artifacts, document extraction
```

### Pi vs OpenCode Comparison

| Aspect | OpenCode | Pi |
|---|---|---|
| MCP | Built-in, central to VLTRA | None by design — skills + CLI tools |
| Web UI | Built-in web server (iframe) | No built-in server; web-ui package runs Agent in-browser |
| Extensibility | Plugins (JS modules, auth hooks) | Extensions (TypeScript, full lifecycle events) |
| SDK | HTTP server + API | Rich Node.js SDK (`createAgentSession`) |
| RPC | JSON over HTTP | JSON over stdin/stdout |
| Sessions | Flat list | Tree-structured (branching, forking) |
| Skills | SKILL.md | SKILL.md (same convention) |
| Context | AGENTS.md | AGENTS.md (same convention) |
| Providers | Anthropic/OpenAI via plugins | 15+ built-in, custom via extensions |

### Pi Has No HTTP/WebSocket Server

Pi's three modes:
1. **Interactive** — TUI
2. **Print/JSON** — one-shot
3. **RPC** — JSONL over stdin/stdout (designed for `spawn()` with piped stdio)

The web-ui package runs `Agent` in the browser — not connected to a remote agent. `ChatPanel.setAgent(agent)` takes a local `Agent` instance.

### Best Approach: Pi SDK + Custom HTTP Server in Sandbox

```
Browser ←→ SSE/WebSocket ←→ Next.js API Route ←→ Sandbox HTTP Server ←→ Pi SDK (in-process)
                             (Effect service)     (thin Node server)    (createAgentSession)
```

1. Small HTTP/WS server runs inside Vercel Sandbox using Pi SDK
2. Server uses `createAgentSession()` to create Pi session
3. Server subscribes to `session.subscribe()` — forwards events as SSE/WebSocket
4. Browser connects via WebSocket, receives streaming events, renders in React UI
5. User input → WebSocket → server → `session.prompt(message)`

This is similar to VLTRA's opencode server pattern but simpler — Pi SDK is a library call, not an external process.

#### Why Not RPC Mode?

RPC mode communicates via stdin/stdout pipes. Vercel Sandbox's `exec` API returns `{ exitCode, stdout, stderr }` — no streaming pipe access. You'd need a bridge process, adding unnecessary complexity.

#### Why Not Browser-Only Agent?

Pi's power comes from filesystem tools (`read`, `write`, `edit`, `bash`). Running Agent in browser means no filesystem. The sandbox gives Pi a real execution environment.

### Pi SDK Key APIs

```typescript
import { createAgentSession, SessionManager, AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent'

// Create session
const { session } = await createAgentSession({
  cwd: '/workspace',
  sessionManager: SessionManager.create('/workspace'),  // persists to disk
  customTools: [myTool1, myTool2],
  authStorage,
  modelRegistry,
})

// Subscribe to events
session.subscribe((event) => {
  // event.type: 'agent_start' | 'agent_end' | 'turn_start' | 'turn_end'
  //           | 'message_start' | 'message_update' | 'message_end'
  //           | 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end'
  //           | 'queue_update' | 'compaction_start' | 'compaction_end'
})

// Send prompt
await session.prompt('Do something')

// Control
await session.abort()
session.steer('Change direction')
session.followUp('After you finish, also do X')
```

**Custom tools:**
```typescript
import { defineTool } from '@mariozechner/pi-coding-agent'
import { Type } from 'typebox'

const myTool = defineTool({
  name: 'my_tool',
  label: 'My Tool',
  description: 'Does something',
  parameters: Type.Object({
    input: Type.String({ description: 'Input value' }),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: 'text', text: `Result: ${params.input}` }],
    details: {},
  }),
})
```

**Auth:** `AuthStorage.setRuntimeApiKey('anthropic', key)` — no plugin patching needed.

**Extensions:** Full lifecycle hooks — `before_agent_start`, `tool_call`, `tool_result`, `context`, `session_start`, etc.

**Sessions:** Tree-structured. `SessionManager.create(cwd)` persists to disk (survives sandbox pause/resume). `SessionManager.inMemory()` for ephemeral.

### Pi Extension System (Relevant Hooks)

```typescript
// Inject context before each turn (RAG-like)
pi.on('before_agent_start', async (event, ctx) => {
  return {
    message: { customType: 'context', content: relevantDocs, display: false },
    systemPrompt: event.systemPrompt + '\nAdditional instructions...',
  }
})

// Intercept/modify tool calls
pi.on('tool_call', async (event, ctx) => {
  if (event.toolName === 'bash' && event.input.command.includes('rm -rf')) {
    return { block: true, reason: 'Blocked dangerous command' }
  }
})

// React to tool results (sync files to storage)
pi.on('tool_result', async (event, ctx) => {
  if (['write', 'edit'].includes(event.toolName)) {
    await syncToArtifacts(event.input.path)
  }
})

// Modify context window before LLM call
pi.on('context', async (event, ctx) => {
  return { messages: filterOrAugmentMessages(event.messages) }
})
```

---

## Knowledge Store: Cloudflare Artifacts

[Cloudflare Artifacts docs](https://developers.cloudflare.com/artifacts/)

Versioned file storage that speaks Git. Create repos programmatically, clone/push with standard Git, durable by default.

### Why Artifacts

- **Just files** — no schema, no database, no rigid taxonomy
- **Git-compatible** — standard `git clone`/`push`/`pull`. Pi works with files natively.
- **Durable** — replicated across data centers + object storage
- **Versioned** — full Git history (who changed what, when)
- **Isolation** — one repo per project/session/task
- **Fork** — start projects from a reviewed baseline template
- **Git notes** — attach agent metadata (prompts, model output) to commits without changing files
- **REST API** — create/list/delete repos, manage tokens from server
- **Token-scoped access** — read/write tokens per repo, short-lived, server-minted
- **Namespaces** — top-level isolation per team

### Architecture

```
Cloudflare Artifacts
└── Namespace: team-{teamId}
    ├── Repo: project-{projectId}        ← project knowledge base
    │   ├── AGENTS.md                     ← loaded by Pi automatically
    │   ├── about/
    │   │   ├── company.md
    │   │   └── products.md
    │   ├── research/
    │   │   └── market-analysis.md
    │   └── decisions/
    │       └── pricing.md
    │
    └── Repo: template-business           ← baseline for new projects
        ├── AGENTS.md
        └── about/
            └── (starter structure)
```

### Sandbox ↔ Artifacts Flow

```
Sandbox spawn:
  1. Server creates short-lived write token via Artifacts REST API
  2. Sandbox runs: git clone {remote} /workspace
  3. Pi starts, loads AGENTS.md from /workspace naturally

Agent writes files:
  1. Pi's write/edit tool modifies files on sandbox filesystem
  2. Pi extension (tool_result hook) auto-commits + pushes to Artifacts

Sandbox destroyed:
  Everything already in Artifacts. Nothing lost.

Next spawn:
  Clone again. Continue where left off.
```

### Auto-Sync Extension

```typescript
pi.on('tool_result', async (event, ctx) => {
  if (['write', 'edit'].includes(event.toolName) && !event.isError) {
    await exec('git add -A && git commit -m "agent: update" && git push', ctx.cwd)
  }
})

// Session metadata via git notes
pi.on('agent_end', async (event, ctx) => {
  const summary = event.messages.map(m => m.role).join(', ')
  await exec(`git notes append -m "session: ${sessionId}" HEAD`, ctx.cwd)
})
```

### Artifacts REST API (Server-Side)

```typescript
// Base URL
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/artifacts/namespaces/${namespace}`

// Create repo
POST /repos  { name, description?, default_branch? }
→ { id, name, remote, token }

// Fork from template
POST /repos/:name/fork  { name, description? }
→ { id, name, remote, token, objects }

// Create scoped token
POST /tokens  { repo, scope: 'read' | 'write', ttl }
→ { id, plaintext, scope, expires_at }

// List repos
GET /repos?limit=&cursor=&search=&sort=&direction=

// Delete repo
DELETE /repos/:name
```

### Semantic Search (Future)

Git doesn't do semantic search. Options for later:
- **v1**: Pi has `grep` + `read`. For small knowledge bases, enough.
- **v2**: Cloudflare Vectorize (native to Cloudflare) or pgvector in existing Postgres.
- Pi extension adds a `knowledge_search` custom tool backed by embedding index.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                          Browser                             │
│  Next.js app (React)                                         │
│  ├── App chrome (teams, projects, settings, sidebar)         │
│  ├── Session page: WebSocket → Pi event stream → React UI    │
│  └── Knowledge browser (browse/edit files from Artifacts)    │
└──────────────────────┬──────────────────────────────────────┘
                       │ WebSocket / SSE
           ┌───────────┴───────────┐
           │                       │
           ▼                       ▼
┌──────────────────┐    ┌──────────────────────────────────────┐
│  Next.js Server   │    │          Vercel Sandbox               │
│  (Effect-TS)      │    │                                       │
│                   │    │  Thin HTTP/WS server (Effect)          │
│  ├── Auth         │    │  ├── Pi SDK (createAgentSession)       │
│  ├── Teams        │    │  ├── Extensions                        │
│  ├── Artifacts    │    │  │   ├── auto-sync (commit+push)       │
│  │   management   │    │  │   ├── auth (API key injection)      │
│  ├── Integration  │    │  │   └── context (RAG from knowledge)  │
│  │   OAuth        │    │  ├── Skills (SKILL.md)                 │
│  ├── Secrets      │    │  ├── AGENTS.md (from Artifacts repo)   │
│  ├── Scheduling   │    │  └── Custom tools:                     │
│  │   (QStash)     │    │      ├── gmail_* (via server API)      │
│  └── Activity     │    │      ├── calendar_* (via server API)   │
│                   │    │      ├── notion_* (via server API)      │
│                   │    │      ├── todoist_* (via server API)     │
│                   │    │      ├── telegram_* (via server API)    │
│                   │    │      ├── linkedin_* (via server API)    │
│                   │    │      └── schedule_* (via server API)    │
│                   │    │                                        │
└──────────────────┘    └────────────────┬───────────────────────┘
                                         │ git clone / push
                                         ▼
                        ┌──────────────────────────────────────┐
                        │        Cloudflare Artifacts           │
                        │                                       │
                        │  Namespace: team-{teamId}             │
                        │  └── Repo: project-{projectId}        │
                        │      ├── AGENTS.md                    │
                        │      ├── about/                       │
                        │      ├── research/                    │
                        │      └── decisions/                   │
                        └──────────────────────────────────────┘
```

### What Carries Over from VLTRA

| Component | Status |
|---|---|
| Auth (better-auth + OTP) | As-is |
| Teams / members / invitations | As-is |
| Integration OAuth (Google, Notion, Figma, LinkedIn, Telegram, Todoist) | As-is |
| Encryption service (AES-256-GCM) | As-is |
| QStash scheduling (recurring + one-time) | As-is |
| Activity / Telegram notifications | As-is |
| Effect-TS service architecture | As-is |
| Drizzle ORM + Postgres (Neon) | As-is (minus git-related tables) |
| Vercel Sandbox service | Adapted (Pi instead of OpenCode) |
| UI components (Base UI + Tailwind) | App chrome reused; session UI rebuilt |
| Settings (key-value) | As-is |

### What's Eliminated

| VLTRA component | Status |
|---|---|
| vltra-cli (Effect CLI for sandbox execution) | Gone |
| OpenCode server management + health checks | Gone — Pi SDK is in-process |
| Auth plugins (vltra-auth.mjs, vltra-codex-auth.mjs) | Gone — `AuthStorage.setRuntimeApiKey()` |
| MCP gateway (JSON-RPC transport) | Gone — Pi custom tools call server API directly |
| iframe URL construction | Gone — WebSocket event stream |
| PRD loop orchestration | Gone — no PRDs |
| PRD state machine (draft → creating → generating → loop) | Gone |
| PRD webhooks (md_ready, json_ready, loop.*) | Gone |
| GitHub service (repo creation, PRs, branches) | Gone — Artifacts REST API |
| opencode.json config generation | Gone — Pi configured via SDK |
| vltra-cli build step | Gone — Pi extensions are just TypeScript |
| Branch management | Gone |
| PR creation/merge | Gone |
| `repoOwner`/`repoName` on project table | Replaced with `artifactsRepoId`/`artifactsRemote` |

### What's New

| Component | Description |
|---|---|
| Cloudflare Artifacts service (Effect) | REST API client: create/fork/delete repos, manage tokens |
| Pi sandbox server | Thin HTTP/WS server in sandbox using Pi SDK |
| Pi extensions (auto-sync, auth, context) | TypeScript modules for Artifacts sync, API key injection, RAG |
| Knowledge browser UI | React UI to browse/edit files from Artifacts |
| Session UI (React) | Custom React components consuming Pi event stream via WebSocket |

---

## Session & Sandbox Model

### Key Decisions

- **No git dependency on GitHub** — Cloudflare Artifacts replaces GitHub repos
- **No PRDs** — sessions are the primary interaction unit
- **Multi-user awareness** — agent knows which user it's acting for
- **Per-project knowledge** — Artifacts repo per project, shared across sessions

### Open Questions

- **One sandbox per project (shared)?** Or one sandbox per session (isolated)? VLTRA business projects share a sandbox. Could do the same.
- **User identity in sandbox** — pass user ID to Pi session, inject into system prompt or extension context. Agent can distinguish who it's talking to.
- **Scheduled agents** — run server-side using Pi SDK directly (no browser, no sandbox needed for lightweight tasks). Or spawn sandbox for heavier tasks.

---

## Pi Web UI Research

### packages/web-ui Components

Built with [mini-lit](https://github.com/badlogic/mini-lit) (Lit web components) + Tailwind CSS v4.

**Key components:**
- `ChatPanel` — top-level: wraps AgentInterface + ArtifactsPanel
- `AgentInterface` — chat UI: message list, input, streaming, model selector
- `MessageList` — renders message history
- `StreamingMessageContainer` — live streaming display
- `SandboxedIframe` — sandboxed artifact execution
- `ArtifactsPanel` — HTML/SVG/Markdown artifact display
- `ModelSelector` — provider/model picker dialog
- `SessionListDialog` — session history browser

**Storage layer:**
- `IndexedDBStorageBackend` — browser persistence
- `SettingsStore`, `ProviderKeysStore`, `SessionsStore`, `CustomProvidersStore`

**Key exports:**
- `ChatPanel`, `AgentInterface` — UI components
- `AppStorage`, `setAppStorage` — storage setup
- `registerToolRenderer`, `registerMessageRenderer` — custom rendering
- `createJavaScriptReplTool`, `createExtractDocumentTool` — built-in tools
- `defaultConvertToLlm` — message format conversion
- `loadAttachment` — file attachment handling

**The web-ui is purely a view layer.** It takes an `Agent` instance that runs in the same JS context. Cannot connect to a remote agent. For Yolk, the session UI will be built in React, consuming Pi events via WebSocket from the sandbox.

---

## Technology Stack

| Layer | Technology |
|---|---|
| Framework | Next.js (App Router) |
| Language | TypeScript |
| Service layer | Effect-TS |
| Database | Postgres (Neon) + Drizzle ORM |
| Auth | better-auth + OTP email |
| Knowledge store | Cloudflare Artifacts (Git-compatible) |
| Agent runtime | Pi SDK (`@mariozechner/pi-coding-agent`) in Vercel Sandbox |
| Agent ↔ browser | WebSocket / SSE (Effect-based) |
| Scheduling | QStash (Upstash) |
| Styling | Tailwind CSS v4 |
| UI primitives | Base UI (`@base-ui/react`) |
| Semantic search | Cloudflare Vectorize or pgvector (future) |
| Package manager | pnpm |

---

## References

- [Block: From Hierarchy to Intelligence](https://block.xyz/inside/from-hierarchy-to-intelligence)
- [Pi coding agent](https://pi.dev) — [docs](https://pi.dev/docs/latest) — [GitHub](https://github.com/badlogic/pi-mono)
- [Pi SDK docs](https://pi.dev/docs/latest/sdk)
- [Pi RPC docs](https://pi.dev/docs/latest/rpc)
- [Pi Extensions docs](https://pi.dev/docs/latest/extensions)
- [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
- [Cloudflare Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/)
- [Cloudflare Artifacts best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/)
- [VLTRA codebase](~/dev/core-projects/clients/vltra) — source for reusable infrastructure
- [Pi mono local](~/dev/docs/pi-mono) — full source for reference
