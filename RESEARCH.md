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

## Knowledge Store Candidates

### Candidate 1: Cloudflare Artifacts

**Status:** Evaluated, viable but repo-as-primitive has limitations.

Git-compatible versioned file storage. Managed, durable, REST API + Git protocol.

**Pros:**
- Just files, no schema
- Git semantics (versioning, history, branching, forking)
- Durable (replicated across data centers)
- Pi works with files natively (`git clone` → `read`/`write`/`edit` → `git push`)
- REST API for repo/token management from server
- Namespaces for per-team isolation
- Git notes for agent metadata

**Cons:**
- **Repo is all-or-nothing** — clone everything, even if agent needs 3 files
- **Concurrent writes** — multiple agents writing to same repo = merge conflicts
- **No semantic search** — need separate embedding index (Cloudflare Vectorize or pgvector)
- **No automatic memory extraction** — files are just files, no intelligence on top
- **No user profiles** — would need to maintain profile documents manually
- Scale: large knowledge bases mean slow clones

**Best for:** Projects where Git semantics (versioning, branching, diffing) are important. Less ideal as a "world model" for an org.

**Links:**
- [Cloudflare Artifacts docs](https://developers.cloudflare.com/artifacts/)
- [REST API](https://developers.cloudflare.com/artifacts/api/rest-api/)
- [Best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/)

---

### Candidate 2: Supermemory

**Status:** Strong candidate. Best conceptual fit for the "world model."

Hosted memory/context engine. Not just storage — extracts facts, builds profiles, handles contradictions, auto-forgets expired info. #1 on LongMemEval, LoCoMo, ConvoMem benchmarks.

**Core API:**
```
POST /v3/documents          → add content (text, URL, file)
POST /v3/search             → hybrid search (RAG + memory)
GET  /v3/profiles           → auto-maintained user profile (~50ms)
POST /v3/documents/upload   → upload files (PDF, images, video, code)
```

**Key features:**
- **Memory engine** — extracts facts from content, tracks updates, resolves contradictions, auto-forgets expired info
- **User profiles** — auto-maintained static facts + dynamic context per user. One API call, ~50ms.
- **Hybrid search** — RAG + memory in single query. Knowledge base + personalized context together.
- **Container tags** — organize by org, project, user. Scope searches. Merge containers.
- **Knowledge graph** — entity relationships, spatial coordinates, graph viewport
- **Connectors** — Gmail, Google Drive, Notion, OneDrive, GitHub, S3, Web Crawler (auto-sync with webhooks)
- **Multi-modal** — PDFs, images (OCR), videos (transcription), code (AST-aware chunking)
- **SMFS** — Supermemory Filesystem. Mounts as filesystem in containers. Agent reads/writes with standard file tools. Supports Vercel, E2B, Daytona, Cloudflare.

**SMFS (Supermemory Filesystem):**

The killer feature for Yolk. Mounts Supermemory as a filesystem in the sandbox:
```
Vercel Sandbox
└── /workspace/              ← SMFS mount
    ├── about/company.md     ← Pi's read/write/edit work directly
    ├── people/alice.md      ← facts auto-extracted into memories
    └── research/q3.md       ← semantically searchable immediately
```

Pi's native file tools work without custom tools. No sync layer needed.

Also available as a bash tool wrapper for serverless (`@supermemory/bash`).

**User profiles solve "the system knows the user":**
```typescript
const { profile } = await client.profile({ containerTag: 'user-alice' })
// profile.static  → ["Head of Product", "Prefers async"]
// profile.dynamic → ["Working on Q3 pricing", "Meeting Thursday"]
```

Inject into Pi system prompt. Agent knows who it's talking to. Gets smarter over time.

**Container tag structure for orgs:**
```
containerTag: "org-acme"              ← org-wide knowledge
containerTag: "org-acme.project-q3"   ← project-scoped
containerTag: "org-acme.user-alice"   ← Alice's context
```

**Complementary with VLTRA integrations (not replacement):**

| Supermemory (remember) | Yolk integrations (act) |
|---|---|
| Gmail → indexes into memory | Gmail → draft, send |
| Notion → syncs into memory | Notion → create page, update |
| Drive → syncs into memory | Calendar → CRUD events |
| Web → crawls into memory | Telegram → send messages |

**Pricing:**
- Free: 1M tokens/mo, 10K searches
- Pro: $19/mo, 3M tokens, 100K searches
- Scale: $399/mo, 80M tokens, 20M searches
- Enterprise: custom, unlimited
- Overage: $0.01/1K tokens, $0.10/1K queries

**Concerns:**
- SMFS maturity — new, need to verify Vercel Sandbox compatibility
- Vendor lock-in — all knowledge in hosted service
- Pricing at scale — model usage for multi-agent orgs
- Connector overlap — two systems touching Gmail/Notion
- Latency — SMFS operations go through API vs local filesystem

**SDK:**
```typescript
import Supermemory from 'supermemory'
const client = new Supermemory()

// Store
await client.add({
  content: 'Market analysis shows 30% growth in Q3',
  containerTag: 'org-acme.project-q3',
})

// Search
const results = await client.search.memories({
  q: 'Q3 market trends',
  containerTag: 'org-acme',
  searchMode: 'hybrid',
})

// Profile
const { profile } = await client.profile({ containerTag: 'org-acme.user-alice' })
```

**Framework integrations:** Vercel AI SDK, LangChain, LangGraph, OpenAI Agents SDK, Mastra, n8n

**Links:**
- [supermemory.ai](https://supermemory.ai)
- [Docs](https://docs.supermemory.ai)
- [GitHub](https://github.com/supermemoryai/supermemory)
- [SMFS docs](https://supermemory.ai/docs/smfs/overview)
- [Pricing](https://supermemory.ai/pricing)
- [API reference](https://docs.supermemory.ai/api-reference)

---

### Candidate 4: Cloudflare Project Think (@cloudflare/think)

**Status:** Strong candidate. Could replace BOTH Pi AND Vercel Sandbox.

Announced April 15, 2026. Next-gen Agents SDK from Cloudflare. An opinionated base class + standalone primitives for building long-running, durable AI agents on Cloudflare infrastructure.

**Blog post:** https://blog.cloudflare.com/project-think/
**Docs:** https://github.com/cloudflare/agents/blob/main/docs/think/index.md
**Example:** https://github.com/cloudflare/agents/tree/main/examples/assistant

**What it provides (all built-in):**

| Feature | Details |
|---|---|
| Agent runtime | Agentic loop: streamText → tool calls → iterate → persist |
| Streaming | WebSocket, token-by-token to any client |
| React client | `useAgentChat()` — drop-in chat UI hook |
| Sessions | Tree-structured messages, forking, compaction, FTS5 search |
| Persistent memory | Context blocks — structured system prompt sections the model reads/updates, survives hibernation |
| Durable filesystem | Workspace (SQLite + R2) — read, write, edit, search, grep, diff via `@cloudflare/shell` |
| Zero idle cost | Durable Objects hibernate — $0 when agent isn't active |
| Crash recovery | Fibers — checkpointing, automatic keepalive, recovery |
| Sub-agents | Facets — isolated child agents with own SQLite + typed RPC |
| Code execution | Dynamic Workers — sandboxed V8 isolates, ms startup, capability-based security |
| npm at runtime | `@cloudflare/worker-bundler` — LLM writes `import { z } from "zod"` and it works |
| Browser | Headless Chrome via Browser Run |
| Full sandbox | Cloudflare Sandbox — git, compilers, test runners (Tier 4) |
| Self-authored extensions | Agent writes its own TypeScript tools at runtime |
| Scheduling | DO Alarms + Fibers for proactive agents |

**The execution ladder (agent escalates as needed):**

```
Tier 0: Workspace      — durable virtual filesystem (SQLite + R2). @cloudflare/shell
Tier 1: Dynamic Worker  — sandboxed JS execution, no network. @cloudflare/codemode
Tier 2: + npm           — runtime package resolution. @cloudflare/worker-bundler
Tier 3: + Browser       — headless Chrome. Browser Run
Tier 4: + Sandbox       — full OS (git, npm test, cargo build). Cloudflare Sandbox
```

Key: "Agent should be useful at Tier 0 alone. Each tier is additive."

**Minimal example:**
```typescript
import { Think } from "@cloudflare/think"
import { createWorkersAI } from "workers-ai-provider"

export class MyAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.5")
  }
}
```

That gives you: streaming, persistence, abort/cancel, error handling, resumable streams, workspace filesystem.

**React client:**
```typescript
const agent = useAgent({ agent: "MyAgent" })
const { messages, sendMessage, status } = useAgentChat({ agent })
```

**Persistent memory (context blocks):**
```typescript
configureSession(session: Session) {
  return session
    .withContext("soul", {
      provider: { get: async () => "You are a helpful assistant." }
    })
    .withContext("memory", {
      description: "Important facts learned during conversation.",
      maxTokens: 2000
    })
    .withCachedPrompt()
}
```

Model sees context blocks in system prompt, can update them via `set_context` tool. Persists across hibernation. Non-destructive compaction for long conversations.

**Sub-agents:**
```typescript
const researcher = await this.subAgent(ResearchAgent, "research")
const reviewer = await this.subAgent(ReviewAgent, "review")
const [research, review] = await Promise.all([
  researcher.search(task),
  reviewer.analyze(task)
])
```

Each child gets own SQLite, conversation tree, memory, tools, model.

**Why this could replace Pi + Vercel Sandbox:**

| Aspect | Pi + Vercel Sandbox | Cloudflare Think |
|---|---|---|
| Agent runtime | Pi SDK in sandbox process | Think on Durable Objects |
| Cost when idle | Sandbox costs (even paused) | Zero (hibernated) |
| Persistence | Must manage (sandbox FS, ephemeral) | Built-in (SQLite + R2, durable) |
| Streaming to browser | Must build WebSocket bridge | Built-in WebSocket |
| Sessions | Must manage persistence | Built-in tree-structured + FTS5 |
| Memory | Must build | Context blocks built-in |
| Crash recovery | Must handle | Fibers + checkpointing |
| Sub-agents | Must build | Facets built-in |
| Workspace/Files | Sandbox FS (lost on destroy) | Durable FS (survives restarts) |
| React client | Must build | `useAgentChat()` built-in |
| Search | Must build | FTS5 built-in |
| Extensions | Pi extensions (TS in sandbox) | Self-authored (Dynamic Workers) |
| Scheduling | QStash (external) | DO Alarms (built-in) |

**The Workspace IS the knowledge store.** Tier 0 gives you a durable virtual filesystem backed by SQLite + R2. Files survive restarts, hibernation, deploys. Read, write, edit, search, grep, diff — all built in via `@cloudflare/shell`. No separate knowledge store needed.

**What you'd give up vs Pi:**
- Pi's 15+ provider support (Think uses AI Gateway or BYOM)
- Pi's extension ecosystem / packages
- Pi's AGENTS.md / skills conventions
- Pi's community
- Vercel Sandbox (move to Cloudflare Sandbox)
- Effect-TS on the server? (Think is Cloudflare Workers, not Next.js — though your control plane could still be Next.js + Effect)

**What you'd gain:**
- Zero idle cost (huge at scale — Block's "one agent per customer")
- Built-in everything (streaming, sessions, memory, filesystem, search, scheduling)
- Durable by default (crash recovery, hibernation, persistent state)
- Sub-agents with typed RPC
- Self-authored extensions
- Cloudflare's global network
- The execution ladder (escalate from workspace to full sandbox as needed)

**Architecture with Think:**
```
┌────────────────────────────┐
│ Next.js (Effect-TS)        │  ← control plane (auth, teams, integrations, OAuth)
│ ├── Auth, Teams, Settings  │
│ ├── Integration OAuth      │
│ └── Yolk API               │
└────────────┬───────────────┘
             │ routes to
             ▼
┌────────────────────────────┐
│ Cloudflare Think Agent     │  ← per-user or per-task Durable Object
│ ├── Workspace (Tier 0)     │  ← durable filesystem = knowledge store
│ ├── Context blocks         │  ← persistent memory
│ ├── Sessions (tree)        │  ← conversation history + FTS5
│ ├── Custom tools           │  ← integrations (Gmail, Calendar, Notion via your API)
│ ├── Sub-agents             │  ← specialized child agents
│ └── WebSocket → browser    │  ← built-in streaming
└────────────────────────────┘
```

**Concerns:**
- Project Think is "preview" / experimental — APIs may change
- Cloudflare lock-in (deeper than Vercel)
- Think vs Pi: Think is younger, less proven, no community yet
- Two platforms: Next.js on Vercel (control plane) + Think on Cloudflare (agents)
- Need to verify: can Think agents call external APIs (your Next.js server) for integration tools?

**Pricing:**
- Durable Objects: $0.15/million requests, $0.001/GB-hour storage
- Workers AI: pay-per-token or free tier
- R2: $0.015/GB-month
- Zero when hibernated

**Links:**
- [Blog post](https://blog.cloudflare.com/project-think/)
- [Docs](https://github.com/cloudflare/agents/blob/main/docs/think/index.md)
- [Example](https://github.com/cloudflare/agents/tree/main/examples/assistant)
- [Agents SDK](https://developers.cloudflare.com/agents/)
- [@cloudflare/shell](https://www.npmjs.com/package/@cloudflare/shell)
- [@cloudflare/codemode](https://github.com/cloudflare/agents/tree/main/packages/codemode)

---

### Candidate 3: QMD (tobi/qmd)

**Status:** Evaluated, not a good fit. Saved for reference.

Local-first search engine by Tobi Lütke. BM25 + vector + LLM re-ranking, all on-device via GGUF models (node-llama-cpp). Zero API calls.

**What it does:** Indexes files on a filesystem, provides hybrid search. CLI + SDK + MCP server.

**What it doesn't do:** Storage, persistence, memory extraction, user profiles, connectors. It's a search layer, not a knowledge store.

**Why not a fit:**
- Doesn't solve persistence (where files live)
- GGUF models need ~2GB download per sandbox spawn
- Index must be rebuilt each sandbox spawn (not persistent)
- Solves search but Yolk needs storage + search + memory
- Supermemory covers search AND storage AND intelligence

**Could complement other storage** as a local search accelerator, but adds complexity without solving the core problem.

**Links:**
- [GitHub](https://github.com/tobi/qmd)
- SDK: `@tobilu/qmd` — `createStore()` for Node.js embedding

---

## Architecture Decision: Custom Effect-TS Harness on Cloudflare Agent SDK

**Status:** Leading candidate. Best fit for Yolk's constraints.

### The Insight

Pi is a great harness. Think is great infrastructure. But:
- Pi's extension system exists because Pi is a general-purpose tool for anyone. Yolk is our product — we control the agent behavior directly. Extensions are indirection we don't need.
- Think's `Think` class is an opinionated loop using Vercel AI SDK. We don't need their opinions — we have our own.
- Both add abstraction layers between us and the agent behavior.

**Build the harness in Effect-TS. Run it on Cloudflare's Agent SDK infrastructure.**

Take the best patterns from Pi and OpenCode. Skip the parts designed for extensibility. Own the core loop.

### Why this is smart

1. **Zero wasted abstraction.** No extension system, no TUI, no SDK adaptation layer. Just our code.
2. **Effect-TS is a genuine advantage** over Pi's plain TypeScript — typed errors, structured concurrency, service composition, streams.
3. **We control the protocol.** Events, streaming format, tool call shape — all designed for our React UI, not adapted from someone else's.
4. **Cloudflare handles the hard infra.** Durability, hibernation, scaling, WebSocket — we don't build these.
5. **The harness is the smallest part.** The core loop is ~200 lines. Everything else is tools, context assembly, and UI — which we're building custom anyway.
6. **We already have the expertise.** VLTRA's Effect services, OpenCode integration, sandbox management — this is evolution, not greenfield.

### What we take from Pi (patterns, not code)

| Pi pattern | Our implementation |
|---|---|
| Context injection before each LLM call | Function call in our loop — no event system needed |
| Tool interception (before/after execution) | Wrap the execute step directly |
| File mutation queue (per-file serialization) | Effect Semaphore (~50 lines) |
| Adaptive system prompt (based on active tools) | Template that varies by tool configuration |
| Mutable tool_call inputs (chained transforms) | Pipeline of transforms before execution |
| Streaming events to client | Effect Stream over WebSocket |
| AGENTS.md convention | Load from workspace as context |
| Skills (on-demand context) | Inject relevant context when task matches |

### What we DON'T need from Pi

- Extension system (30+ events, plugin loading, hot-reload) — we own the code
- TUI / terminal UI — we're building a web UI
- RPC mode / stdin-stdout protocol — we use WebSocket
- Custom provider registration — we configure providers directly
- Package system (npm/git skill distribution) — not a platform for third parties
- Session tree with branching/forking — flat sessions for v1, add tree later
- Compaction — manage context window size directly for v1

### The core loop in Effect

```typescript
const agentLoop = (messages: AgentMessage[], tools: ToolSet, systemPrompt: string) =>
  Effect.gen(function* () {
    while (true) {
      // 1. Assemble context (inject knowledge, user profile, etc.)
      const context = yield* assembleContext(messages, systemPrompt)

      // 2. Stream LLM response (broadcast tokens to WebSocket)
      const response = yield* streamLLM(context, tools)

      // 3. No tool calls? Done.
      if (!response.toolCalls.length) return response

      // 4. Execute tools (parallel with per-file serialization)
      const results = yield* executeTools(response.toolCalls)

      // 5. Append and loop
      messages.push(response.message, ...results)
    }
  })
```

### Why Effect is better than Pi's plain TypeScript for this

```typescript
// Typed errors — know exactly what can fail
class LLMError extends Data.TaggedError('LLMError')<{ message: string }> {}
class ToolError extends Data.TaggedError('ToolError')<{ tool: string; cause: unknown }> {}

// Structured concurrency — parallel tools with abort
const executeTools = (calls: ToolCall[]) =>
  Effect.forEach(calls, executeOneTool, { concurrency: 'unbounded' })

// Streaming — LLM tokens as Effect Stream
const streamLLM = (context: Context) =>
  Stream.fromAsyncIterable(provider.stream(context))
    .pipe(Stream.tap(event => broadcast(event)))

// Service layer — swap providers, tools, storage via layers
class AgentLoop extends Effect.Service<AgentLoop>()('AgentLoop', {
  effect: Effect.gen(function* () {
    const llm = yield* LLMProvider
    const tools = yield* ToolRegistry
    const storage = yield* SessionStorage
    // ...
  })
}) {}
```

### Running on Cloudflare Agent SDK (not Think)

Use the `Agent` base class directly, not `Think`:

```typescript
import { Agent } from 'agents'

export class YolkAgent extends Agent<Env> {
  // Effect-based harness runs inside a Durable Object

  async onMessage(connection, message) {
    const result = await Effect.runPromise(
      agentLoop(message, this.tools, this.systemPrompt).pipe(
        Effect.provide(this.layers)
      )
    )
  }
}
```

**What Cloudflare gives us (infrastructure):**
- Durable Objects — per-agent actor, SQLite, hibernation, zero-idle-cost
- Workspace (`@cloudflare/shell`) — durable filesystem for knowledge
- WebSocket — built into DO, streaming to browser
- DO Alarms — scheduling (replaces QStash)
- Dynamic Workers — sandboxed code execution if needed
- R2 — object storage for large files

**What we build (harness):**
- Agent loop (Effect-TS)
- Context assembly (system prompt + knowledge + user profile + history)
- Tool execution (with interception, per-file serialization)
- LLM streaming (Effect Stream → WebSocket)
- Session persistence (DO SQLite)
- React chat UI

### Full architecture

```
┌──────────────────────────────┐
│ Next.js + Effect (Vercel)     │  ← control plane
│ Auth, teams, integrations     │
│ OAuth flows, settings         │
│ Integration API (Gmail,       │
│   Calendar, Notion, etc.)     │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ Cloudflare Agent SDK          │  ← infrastructure
│ Durable Objects + Workspace   │
│                               │
│ ┌───────────────────────────┐│
│ │ YolkAgent extends Agent   ││  ← OUR harness (Effect-TS)
│ │                           ││
│ │ Effect agent loop:        ││
│ │ ├── assembleContext()     ││  (inject knowledge, profile, history)
│ │ ├── streamLLM()           ││  (stream tokens, broadcast events)
│ │ ├── executeTools()        ││  (parallel + per-file serialization)
│ │ ├── persistSession()      ││  (DO SQLite)
│ │ └── broadcastEvents()     ││  (WebSocket → browser)
│ │                           ││
│ │ Workspace = knowledge     ││  (durable filesystem)
│ │ SQLite = sessions/state   ││  (conversation history)
│ │ WebSocket = streaming     ││  (real-time to React UI)
│ │ Tools = integration calls ││  (call Next.js API for Gmail, etc.)
│ └───────────────────────────┘│
└──────────────────────────────┘
               │ WebSocket
               ▼
┌──────────────────────────────┐
│ React UI (our design)         │  ← our chat interface
│ WebSocket → event stream      │
│ Custom components             │
│ Base UI + Tailwind            │
└──────────────────────────────┘
```

### v1 scope for the harness

| Component | Effort | Priority |
|---|---|---|
| Basic loop (stream → tools → loop) | 1 week | Must have |
| Context injection seam | Trivial | Must have |
| Tool interception (before/after) | Trivial | Must have |
| LLM streaming over WebSocket | 1 week | Must have |
| Flat session persistence (DO SQLite) | 1 week | Must have |
| Integration tools (Gmail, Calendar, Notion) | Port from VLTRA | Must have |
| File mutation queue | ~50 lines | Nice to have |
| Adaptive system prompt | Medium | Nice to have |
| Tree sessions | Harder | v2 |
| Compaction | Harder | v2 |

**Estimated total: 3-4 weeks** for a working agent with streaming, tools, and persistence.

### Risks

- **Edge cases** Pi already handles: streaming error recovery, token counting, model-specific quirks, context window overflow. Solvable with Effect's error model but need to discover them.
- **Cloudflare Agent SDK maturity** — Project Think is preview. The lower-level `Agent` base class is more stable but still evolving.
- **Two platforms** — Next.js on Vercel (control plane) + Agent SDK on Cloudflare (agents). Two deploys, two runtimes. Clean separation but operational complexity.
- **Effect in Cloudflare Workers** — need to verify Effect-TS works in Workers runtime (V8 isolate, not Node.js). Likely fine but untested.

### Open questions

1. Does Effect-TS run in Cloudflare Workers? (V8 isolate, no Node.js APIs)
2. Can a Durable Object make HTTP calls to our Next.js API? (for integration tools)
3. How does Workspace (`@cloudflare/shell`) work programmatically? (SDK surface for read/write/search)
4. What's the WebSocket protocol for the Agent base class? (message format, connection lifecycle)
5. How do we handle auth between browser → Cloudflare DO → Next.js API? (token chain)

---

## Supermemory Deep Dive (Build vs Buy)

**Status:** Not viable for self-hosting. Engine is entirely proprietary.

### What's open source (just clients)

- `apps/web` — consumer web app frontend (Next.js)
- `apps/mcp` — MCP server (Cloudflare Worker, calls API)
- `apps/browser-extension` — Chrome extension
- `packages/memory-graph` — React Canvas 2D graph visualization (display only)
- `packages/tools` — framework integrations (AI SDK, Mastra, etc.)
- `packages/validation` — Zod schemas

### What's proprietary (the entire engine)

- API backend (Hono on Cloudflare Workers)
- Memory extraction pipeline
- Relationship discovery (updates/extends/derives)
- Contradiction resolution
- User profile generation
- Embedding pipeline
- Database schema (Postgres via Hyperdrive)
- Ingestion workflows (Cloudflare Workflows)
- Connector sync engine
- Automatic forgetting logic
- SMFS binary (compiled, closed-source)

### Under the hood

| Layer | Technology |
|---|---|
| Compute | Cloudflare Workers |
| Database | PostgreSQL via Cloudflare Hyperdrive |
| Vectors | Cloudflare AI (embeddings) |
| Cache | Cloudflare KV |
| Async | Cloudflare Workflows (`IngestContentWorkflow`) |
| Auth | better-auth |
| ORM | Drizzle |

### The "intelligence" is LLM prompt engineering

Not custom ML. The pipeline:
- Extract facts from text → structured output LLM call
- Compare new fact vs existing → embedding similarity + LLM judgment
- Detect contradictions → LLM with temporal reasoning
- Build user profiles → periodic LLM summarization
- Auto-forget → parse temporal markers + expiry timestamps

### Build cost for equivalent

| Component | Effort |
|---|---|
| Memory extraction (LLM fact extraction) | 1-2 weeks |
| Relationship discovery (updates/extends) | 1-2 weeks |
| Contradiction resolution + forgetting | 1 week |
| User profiles (auto-maintained) | 1 week |
| Hybrid search (embeddings + keyword) | 1-2 weeks |
| Content extraction (PDF, images, etc.) | 2-4 weeks |

**Total: ~2-3 months.** But for v1, the Workspace filesystem + basic search may be enough. Memory intelligence can be added later.

### Verdict

Don't use Supermemory as a dependency for a core feature. The concepts are good — implement them ourselves on Cloudflare's primitives (Workspace + Vectorize + Workers AI) when needed.

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
