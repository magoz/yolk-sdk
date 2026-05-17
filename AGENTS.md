# PROJECT KNOWLEDGE BASE

Next.js 16 App Router app with Effect-TS services, Drizzle ORM (PostgreSQL/Neon), better-auth, Tailwind CSS 4, and `packages/*` reusable agent stack.

## CRITICAL RULES

- **Use `pnpm` exclusively** - not npm or yarn
- **Run `pnpm tsc` before finishing** - ensure types pass
- **Run `pnpm lint` to check for errors** - fix any issues
- **Run `pnpm packages:check` when touching `packages/*`** - verify package types
- **Run `pnpm cloudflare:check` when touching `cloudflare/*`** - verify Cloudflare app types
- **Run `pnpm test:run` to verify tests pass** - fix failures before committing
- **Agent tools must be runtime-portable** - no Node-only imports/deps in `lib/agents/tools/*`; use Effect APIs (`Config`, `HttpClient`, Schema) and Worker-safe adapters

### Effect-TS Rules (Enforced by ESLint)

| Rule                                            | Description                                               |
| ----------------------------------------------- | --------------------------------------------------------- |
| `local/no-disable-validation`                   | NEVER use `{ disableValidation: true }`                   |
| `local/no-catch-all-cause`                      | NEVER use `Effect.catchCause` - catches defects           |
| `local/no-schema-from-self`                     | NEVER use `*FromSelf` schemas (use standard variants)     |
| `local/no-schema-decode-sync`                   | NEVER use sync decode/encode (throws exceptions)          |
| `local/prefer-option-from-nullable`             | Use Effect nullish helpers instead of ternary             |
| `@typescript-eslint/no-explicit-any`            | NEVER use `any` type                                      |
| `@typescript-eslint/consistent-type-assertions` | NEVER use `as` type casts                                 |
| `local/no-node-deps-in-agent-tools`             | NEVER import Node-only deps or raw `fetch()` in app tools |

See `patterns/EFFECT_BEST_PRACTICES.md` for detailed explanations and alternatives.

## PATTERNS

**Before implementing any feature, consult `patterns/README.md`.**

- **Patterns describe intent; code describes reality.** Check the codebase first before assuming something is/isn't implemented.
- **Use patterns as guidance.** Follow patterns, types, and architecture defined in relevant files.

## ENV BOUNDARIES

- Effect app/service code uses `Config.*` (`yield* Config.*` inside `Effect.gen`; map config errors around the whole block).
- Direct `process.env` is allowed only in sync framework/config boundaries: root configs, `lib/dotenv.ts`, Sentry/instrumentation files, Playwright setup/fixtures env handoff, and sync SDK callbacks like `TelemetryLayer`.
- Never add direct `dotenv.config()` calls outside `lib/dotenv.ts`; import the centralized module from root configs.

## CAPABILITIES

| Capability         | Service                                                  | Details                                                                                                                            |
| ------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Authentication     | Auth                                                     | Sign up, sign in, sign out, sessions, OTP email flow                                                                               |
| Database           | Db                                                       | PostgreSQL via Effect PgDrizzle; Auth adapter uses Neon HTTP                                                                       |
| Email sending      | Email                                                    | Transactional email via Resend                                                                                                     |
| Observability      | Telemetry                                                | OpenTelemetry spans + Sentry error tracking                                                                                        |
| UI components      | shadcn/ui                                                | Base UI primitives (not Radix), see `components/ui/`                                                                               |
| Storage/RAG        | `/storage` + `@yolk/rag` + `lib/services/rag`            | Text/file source ingestion, hybrid vector+keyword retrieval, pgvector chunks, OpenAI embeddings; app owns auth/R2/DB adapters       |
| Agent stack        | packages                                                 | `@yolk/agent` subpaths, `@yolk/mcp`, `@yolk/rag`, Workflow runtime, voice-runtime, React hooks                                      |
| Text agent         | app/agent + app/api/agent + lib/agents                   | `/agent/next` + `/api/agent`; text+image chat UI → protocol transcript + model picker (`gpt-5.4`, Claude Sonnet 4.6)                |
| Voice agent        | app/agent + app/api/agent/realtime + lib/agents/realtime | Mic mode inside agent runtime pages + Realtime WebRTC routes; `gpt-realtime-2` + `gpt-realtime-whisper` default + `OPENAI_API_KEY` |
| Web/tools          | lib/agents/tools                                         | `web_fetch` public URL fetch + `web_search` direct Exa/Parallel MCP search + `just_bash` virtual shell + `skill` + remote MCP tools |
| OpenAI Codex OAuth | OpenAiCodexOAuth                                         | ChatGPT subscription device flow + token refresh                                                                                   |
| Anthropic OAuth    | AnthropicClaudeOAuth                                     | Claude subscription OAuth code+PKCE flow + token refresh                                                                           |
| Cloudflare agent   | Alchemy                                                  | `cloudflare/agent`; Worker + Durable Object session runtime for `/agent/cloudflare`; Next brokers tokens + Codex HTTP stream proxy |

## WHERE TO LOOK

| Task                 | Location                                       | Notes                                                                              |
| -------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| Add app page/UI      | `app/`                                         | See `app/AGENTS.md` + EFFECT_PAGES                                                 |
| Add server action    | `lib/core/[domain]/*-action.ts`                | One action per file, see `lib/core/AGENTS.md`                                      |
| Add domain function  | `lib/core/[domain]/*.ts`                       | Pure Effect functions, see EFFECT_DOMAIN_FUNCTIONS                                 |
| Add new service      | `lib/services/[name]/`                         | Follow `lib/services/AGENTS.md` pattern                                            |
| Add dynamic page     | `app/*/page.tsx`                               | See EFFECT_PAGES for Suspense pattern                                              |
| Add API route        | `app/api/[route]/route.ts`                     | HTTP boundaries only; see `app/api/AGENTS.md`                                      |
| Add UI component     | `components/ui/`                               | Uses Base UI, not Radix                                                            |
| Add tests            | `*.test.ts` beside source or `packages/*/test` | Use @effect/vitest; package tests in package dirs                                  |
| Add E2E tests        | `e2e/`                                         | Playwright tests, fixtures, `.env.test`; see `e2e/AGENTS.md`                       |
| Database schema      | `lib/services/db/schema.ts`                    | Drizzle ORM                                                                        |
| Add storage/RAG app adapter | `lib/services/rag/`                       | App-owned `RagStore`, extractor, embedder layers over `@yolk/rag` contracts        |
| Add storage feature  | `lib/core/storage/`, `app/storage/`             | Server actions + `/storage` UI for source ingestion                                |
| Auth flow            | `app/(auth)/`                                  | better-auth + OTP email                                                            |
| Service dependencies | `lib/layers.ts`                                | AppLayer merges all services                                                       |
| Error types          | `lib/core/errors/index.ts`                     | Shared domain errors                                                               |
| URL state (filters)  | `app/*/search-params.ts`                       | nuqs/server imports only, see NUQS pattern                                         |
| Code style & naming  | `patterns/TYPESCRIPT_CONVENTIONS.md`           | Prettier, kebab-case, file naming                                                  |
| Dev/ops scripts      | `scripts/`                                     | Node CLI boundary; see `scripts/AGENTS.md`                                         |
| Agent providers      | `lib/agents/AGENTS.md`                         | Runtime layer, provider modes, Codex quirks                                        |
| Agent chat UI        | `app/agent/AGENTS.md`                          | Headless chat hook/items, composer, console chrome                                 |
| Add agent tool       | `lib/agents/tools/`                            | App `ToolModule`s; route/runtime adapters select modules via `resolveAgentToolSet` |
| Agent auth actions   | `lib/core/agent/*-action.ts`                   | OpenAI Codex + Anthropic Claude connect/disconnect actions                          |
| Agent MCP config     | `.yolk/mcp.json` or `.opencode/mcp.json`       | Remote MCP server configs passed to Next/Cloudflare tools                          |
| Reusable agent stack | `packages/AGENTS.md`                           | Package boundaries and naming                                                      |
| Cloudflare agent app | `cloudflare/agent/AGENTS.md`                   | Alchemy Worker/DO deployment and Cloudflare-specific adapter                       |
| Local lint rule      | `eslint-local-rules/`                          | See `eslint-local-rules/AGENTS.md`                                                 |
| Agent loop design    | `AGENT_LOOP.md`                                | Stateless loop details and decisions                                               |

## CODE MAP

| Symbol                           | Type     | Location                                               | Role                                                                                 |
| -------------------------------- | -------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `AppLayer`                       | Layer    | `lib/layers.ts`                                        | Merged service layer for Effect pipelines                                            |
| `NextEffect.runPromise`          | Function | `lib/next-effect/index.ts`                             | Handles redirects + notFound outside Effect context                                  |
| `NextEffect.redirect`            | Function | `lib/next-effect/index.ts`                             | Redirect intent (use inside Effect pipelines)                                        |
| `NextEffect.notFound`            | Function | `lib/next-effect/index.ts`                             | NotFound intent (use inside Effect pipelines)                                        |
| `NextEffect.isNavigationError`   | Function | `lib/next-effect/index.ts`                             | Re-fail redirect/notFound inside catch-all handlers                                  |
| `Auth`                           | Service  | `lib/services/auth/live-layer.ts`                      | Authentication (sign in/up/out, sessions)                                            |
| `Db`                             | Service  | `lib/services/db/live-layer.ts`                        | Database (returns Drizzle client)                                                    |
| `Email`                          | Service  | `lib/services/email/live-layer.ts`                     | Resend email sending                                                                 |
| `FileExtractor`                  | Service  | `lib/services/file-extractor/live-layer.ts`            | Uploaded file text extraction for Storage ingestion                                   |
| `OpenAiCodexOAuth`               | Service  | `lib/services/openai-codex-oauth/live-layer.ts`        | Codex OAuth device flow + refresh                                                    |
| `AnthropicClaudeOAuth`           | Service  | `lib/services/anthropic-oauth/live-layer.ts`           | Claude OAuth code exchange + refresh                                                 |
| `TelemetryLayer`                 | Layer    | `lib/services/telemetry/live-layer.ts`                 | OpenTelemetry + Sentry span/log processing                                           |
| `reportError`                    | Function | `lib/services/telemetry/report-error.ts`               | Log error + Sentry capture (boundaries only)                                         |
| `reportWarning`                  | Function | `lib/services/telemetry/report-warning.ts`             | Log warning + Sentry warning (degraded paths)                                        |
| `AppRagLayer`                    | Layer    | `lib/services/rag/live-layer.ts`                       | App adapters for `@yolk/rag`: Drizzle store, text extractor, OpenAI embedder         |
| `createTextStorageObject`        | Function | `lib/core/storage/create-text-storage-object.ts`       | Creates text `storageObject` and indexes it through package RAG ingestion            |
| `getUserStorage`                 | Function | `lib/core/storage/get-user-storage.ts`                 | Lists user storage sources with document index status                                |
| `makeAgentRuntimeLayer`          | Function | `lib/agents/runtime-layer.ts`                          | Provides provider + default loop deps with no tools                                  |
| `makeAgentRuntimeLayerWithTools` | Function | `lib/agents/runtime-layer.ts`                          | Provides provider + app tool executor for agent routes                               |
| `agentTextCapabilities`          | Const    | `lib/agents/text-agent-config.ts`                      | Text agent input/tool capability source of truth                                     |
| `agentTextModelOptions`          | Const    | `lib/agents/text-agent-config.ts`                      | Text model picker options and provider routing source of truth                       |
| `resolveAgentToolSet`            | Function | `lib/agents/tools/resolve-toolset.ts`                  | Resolves caller-provided app tool modules                                            |
| `loadProjectMcpServers`          | Function | `lib/agents/mcp/file-source.ts`                        | Loads remote MCP configs from `.yolk/mcp.json` / `.opencode/mcp.json`                |
| `makeTextToolModules`            | Function | `lib/agents/tools/registry.ts`                         | Adds runtime-portable text tools plus caller-provided remote MCP tools               |
| `nodeTextToolModules`            | Const    | `lib/agents/tools/registry.ts`                         | Runtime-portable text route tool modules                                             |
| `nodeVoiceToolModules`           | Const    | `lib/agents/tools/registry.ts`                         | Runtime-portable Realtime voice tool modules                                         |
| `run`                            | Function | `packages/agent/src/loop/run.ts`                       | Stateless LLM/tool loop                                                              |
| `runVercelAgentWorkflow`         | Function | `packages/vercel-workflows-runtime/src/workflow-loop.ts` | Vercel Workflow durable model/tool step loop contract                                |
| `runRuntime`                     | Function | `packages/agent/src/runtime/run-runtime.ts`            | Stateless or append-backed runtime over agent loop                                   |
| `SessionEventStore`              | Service  | `packages/agent/src/runtime/session-event-store.ts`    | Append-only runtime event storage contract                                           |
| `AgentTranscript`                | Type     | `packages/agent/src/client/state.ts`                   | Non-empty client-owned protocol transcript                                           |
| `AgentToolRun`                   | Type     | `packages/agent/src/client/state.ts`                   | Client-side rich tool lifecycle state                                                |
| `reduceAgentChatState`           | Function | `packages/react/src/chat-core.ts`                      | Pure reducer for chat actions/events                                                 |
| `AgentChatAction`                | Type     | `packages/react/src/chat-core.ts`                      | Headless chat reducer action model                                                   |
| `AgentChatSessionEvent`          | Schema   | `packages/react/src/chat-session-events.ts`            | UI/session edit event model                                                          |
| `AgentChatMessage`               | Type     | `packages/react/src/chat-messages.ts`                  | Headless React chat parts source of truth                                            |
| `toAgentMessages`                | Function | `packages/react/src/chat-messages.ts`                  | Converts chat parts to protocol transcript                                           |
| `eventId`                        | Field    | `packages/agent/src/protocol/event.ts`                 | Optional stream event id; client/react reducers de-dupe duplicate replay             |
| `listMcpTools`                   | Function | `packages/mcp/src/client/client.ts`                    | Resolves configured MCP server tools                                                 |
| `makeMcpToolServer`              | Function | `packages/mcp/src/server/server.ts`                    | Creates tool-only MCP JSON-RPC server                                                |
| `Api`                            | Worker   | `cloudflare/agent/src/api.ts`                          | Cloudflare Worker exposing `/health`, `/connect/:sessionId`, `/bootstrap/:sessionId` |
| `YolkAgent`                      | DO       | `cloudflare/agent/src/yolk-agent.ts`                   | Durable Object running agent runtime + append-log persistence                        |
| `makeCloudflareTextToolModules`  | Function | `cloudflare/agent/src/tool-modules.ts`                 | Cloudflare text toolset shim over shared app text modules                            |
| `codex-responses`                | Route    | `app/api/internal/cloudflare/codex-responses/route.ts` | Internal Worker-to-Next streaming proxy for ChatGPT Codex responses                  |

## REFERENCE REPOS

| Repo          | Location          | Notes                                                         |
| ------------- | ----------------- | ------------------------------------------------------------- |
| `effect-smol` | `.repos/effect`   | Effect v4 source/docs; source for current Effect API shifts   |
| `pi-mono`     | `.repos/pi`       | Pi monorepo; agent/product architecture reference             |
| `opencode`    | `.repos/opencode` | Opencode fork; Codex/OpenAI agent protocol/provider reference |
| `t3code`      | `.repos/t3code`   | Agent chat/product UI reference                               |
| `ai-sdk`      | `.repos/ai`       | Vercel AI SDK reference; UIMessage parts/tool lifecycle model |
| `kody`        | `.repos/kody`     | MCP/tool orchestration inspiration                            |
| `flue`        | `.repos/flue`     | MCP/server-tool integration inspiration                       |
| `mcp-sdk`     | `.repos/mcp-sdk`  | Model Context Protocol TypeScript SDK/protocol reference      |
| `clanka`      | `.repos/clanka`   | Effect-native agent/tools; Codex auth, MCP, semantic search   |

- Repos are shallow clones, gitignored. Run `pnpm clone-repos` to fetch.
- Effect-family package versions are pinned via `pnpm-workspace.yaml` catalog; `pi`/`opencode`/`t3code`/`ai`/`kody`/`flue`/`mcp-sdk`/`clanka` track branches.
- Keep `.repos/**` out of app typecheck/lint/test scope.

## ANTI-PATTERNS (THIS PROJECT)

| Pattern                                              | Correct Approach                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| API routes for CRUD operations                       | Server actions (`lib/core/[domain]/*-action.ts`)                                                  |
| Streaming files through server                       | Signed direct uploads (R2/S3); add file service first                                             |
| Raw `process.env` in Effect app/service code         | `yield* Config.*`; direct env only in documented sync boundaries                                  |
| `router.push()` for logout                           | `window.location.href = '/'` (layout cache issue)                                                 |
| Barrel files (`index.ts` re-exports)                 | Import from `live-layer.ts` directly                                                              |
| `Effect.runPromise()` in pages                       | `NextEffect.runPromise()` (handles redirects)                                                     |
| Catch-all swallowing `NextEffect.redirect/notFound`  | Re-fail `NextEffect.isNavigationError(error)` before reporting                                    |
| Layer `dependencies` option                          | `Layer.provide()` externally                                                                      |
| Multiple services per directory                      | One service per directory                                                                         |
| Multiple actions per file                            | One action per file ending in `-action.ts`                                                        |
| `useState` for shareable UI state                    | nuqs URL state (`app/*/search-params.ts`)                                                         |
| Import `parseAs*` from `nuqs`                        | Import from `nuqs/server` in search-params.ts                                                     |
| Direct data fetch in page component                  | Suspense + Content pattern (see EFFECT_PAGES)                                                     |
| Ad hoc nested async components                       | Use EFFECT_PAGES Shell + independent streaming sections pattern                                   |
| Static protected/session-gated pages                 | Add `export const dynamic = 'force-dynamic'` or use dynamic APIs like `cookies()`                 |
| `matchEffect` for error handling                     | `catchTag` chains + `Effect.catch` catch-all                                                      |
| `Config.string('X').pipe(Effect.mapError(...))`      | Yield Config directly, map errors on whole block                                                  |
| `ServiceMap.Service<Self>()(id, { make })`           | `Context.Service<Self>()(id, { make })` — `ServiceMap` renamed to `Context` in Effect v4          |
| `Logger.pretty`                                      | `Logger.layer([Logger.consolePretty()])` — `Logger.pretty` removed in v4                          |
| `@effect/platform-node` for Db service               | `PgDrizzle.make()` from `drizzle-orm/effect-postgres` — handles connection internally             |
| `drizzle(client, { schema })` in Db service          | `PgDrizzle.make({ relations })`; Auth intentionally uses Neon HTTP better-auth adapter            |
| `Schema.TaggedError`                                 | `Schema.TaggedErrorClass` — renamed in v4. Or use `Data.TaggedError` for simpler errors           |
| `Either.isRight(r)` / `r.right`                      | `Result.isSuccess(r)` / `r.success` — `Either` renamed to `Result` in v4                          |
| `Effect.catchAll(handler)`                           | `Effect.catch(handler)` — v4 rename                                                               |
| `FiberRef.unsafeMake` / `FiberRef.get`               | `Context.Reference` + `References.*` — `FiberRef` removed in v4                                   |
| `dotenv.config({ path: '.env.local' })` in a module  | `import '@/lib/dotenv'` — centralized, respects `NODE_ENV=test` → `.env.test`                     |
| Raw `fetch` in Effect services/providers             | Effect `HttpClient`; provide `FetchHttpClient.layer`; tests inject `HttpClient` layer             |
| Raw `JSON.parse/stringify` in production Effect code | `Schema.UnknownFromJsonString` + Effect encode/decode; direct JSON is fine in tests               |
| Fake/display-only reasoning                          | Only show provider-supplied reasoning summaries (`LLMReasoningDelta` / assistant reasoning parts) |
| Node-only imports in `lib/agents/tools/*`            | Runtime-portable Effect tool modules; isolate platform deps outside app tools                     |

## NOTES

- **No CI/CD configured** - deployment via Vercel auto-deploy
- **React Compiler enabled** - automatic memoization (experimental)
- **PostHog proxied** - requests via `/ph/*` rewrites to bypass ad-blockers
- **Drizzle v1 RC** - using `1.0.0-rc.1` with Effect-native driver (`drizzle-orm/effect-postgres`)
- Effect v4: services use `Context.Service`, errors use `catchTag` chains + `Effect.catch`
- **`@effect/platform-node` removed** - Db uses `PgDrizzle.make()` + `@effect/sql-pg` directly
- **LSP shows stale v3 errors** - always use `pnpm tsc` for accurate type checking
- **NextEffect.runPromise** required because Next.js redirects must be called outside try-catch
- **Root Vitest may discover package tests** - `pnpm test:run` then also runs package tests; update scripts/docs together if this changes
- **Workflow package APIs** - import `@yolk/vercel-workflows-runtime/workflow`; root export intentionally empty
- **Workflow step retries** - opt-in only; default no retry for streamed model/tool chunks
- **Workflow terminal status** - `runVercelAgentWorkflow` returns structured completion/failure/max-turn result
- **Portless local dev** - `pnpm dev` runs `portless run next dev` at named `.localhost` URLs; use `pnpm dev:app` to bypass proxy
- **`packages/harness/` is historical** - not present unless a future real workspace package is added
- **`CLAUDE.md` is a pointer** - `AGENTS.md` is the canonical project knowledge base
- **Alchemy source style uses `.ts` relative imports** - keep explicit extensions for source-exported packages and Cloudflare app code
- **Pinned Worker deploy** - use `pnpm cloudflare-agent:deploy:adopt` to update canonical Worker in non-interactive shells
- **Scripts are Node CLI boundaries** - `scripts/AGENTS.md` documents allowed Node/process/console/raw JSON exceptions

## SUBDIRECTORY DOCS

- `patterns/README.md` - Architecture and convention patterns index
- `patterns/PACKAGE_ARCHITECTURE.md` - Package shape, boundaries, tree-shaking constraints
- `scripts/AGENTS.md` - Node CLI/dev script boundaries
- `app/AGENTS.md` - App Router page/layout/auth/API boundaries
- `app/api/AGENTS.md` - HTTP route handler and Realtime route patterns
- `app/api/agent/AGENTS.md` - Agent text/Workflow/commands/Realtime route contracts
- `app/api/internal/cloudflare/AGENTS.md` - Worker-to-Next token/stream bridge contracts
- `app/agent/AGENTS.md` - Agent chat UI composition and headless boundaries
- `lib/core/AGENTS.md` - Server actions, domain functions, shared errors
- `lib/core/agent/AGENTS.md` - Provider OAuth token storage and action contracts
- `lib/agents/AGENTS.md` - App-owned agent route/provider wiring and Codex quirks
- `lib/agents/providers/AGENTS.md` - Provider adapter quirks and tests
- `lib/agents/tools/AGENTS.md` - Runtime-portable app tool policy
- `lib/agents/workflow-runtime/AGENTS.md` - App Workflow step/writer boundaries
- `lib/agents/realtime/AGENTS.md` - OpenAI Realtime voice adapter rules
- `lib/agents/skillset/AGENTS.md` - App skill/command source adapters
- `lib/agents/mcp/AGENTS.md` - App remote MCP config source
- `lib/services/AGENTS.md` - Effect-TS service architecture, config, observability patterns
- `lib/services/rag/AGENTS.md` - App-owned RAG adapter boundaries
- `packages/AGENTS.md` - Domain-free reusable agent stack boundaries
- `packages/vercel-workflows-runtime/AGENTS.md` - Vercel Workflow runtime contract and retry/status semantics
- `packages/vercel-workflows-runtime/test/AGENTS.md` - Workflow directive/integration test rules
- `packages/agent/AGENTS.md` - Agent package subpaths and boundaries
- `packages/mcp/AGENTS.md` - MCP client/server package boundaries
- `packages/mcp/test/client/AGENTS.md` - MCP client transport test boundaries
- `packages/mcp/test/server/fixtures/AGENTS.md` - MCP server stdio fixture constraints
- `packages/react/AGENTS.md` - Headless React chat hook/state/session events
- `cloudflare/agent/AGENTS.md` - Cloudflare Worker/Durable Object agent app
- `components/ui/AGENTS.md` - UI component install sources and customizations
- `app/storage/AGENTS.md` - Storage route/source ingestion UI boundaries
- `e2e/AGENTS.md` - E2E test patterns, locator priority, streaming guards, auth cookies
- `eslint-local-rules/AGENTS.md` - Custom ESLint rule conventions
