# Package Architecture

Rules for `packages/*` public shape, import boundaries, and tree-shaking.

## Public Shape

The lists below cover feature/API subpaths. Every public package also exports `./package.json` for
metadata.

- `@yolk-sdk/agent` is the main agent package.
- Agent APIs use explicit subpaths:
  - `@yolk-sdk/agent/protocol`
  - `@yolk-sdk/agent/loop`
  - `@yolk-sdk/agent/loop/testing`
  - `@yolk-sdk/agent/runtime`
  - `@yolk-sdk/agent/client`
  - `@yolk-sdk/agent/compaction`
  - `@yolk-sdk/agent/classification`
  - `@yolk-sdk/agent/tools`
  - `@yolk-sdk/agent/react`
  - `@yolk-sdk/agent/oauth`
  - `@yolk-sdk/agent/providers/openai`
  - `@yolk-sdk/agent/providers/openai/codex`
  - `@yolk-sdk/agent/providers/openai/conformance`
  - `@yolk-sdk/agent/providers/openai/codex-usage`
  - `@yolk-sdk/agent/providers/openai/codex-provider`
  - `@yolk-sdk/agent/providers/openai/provider`
  - `@yolk-sdk/agent/providers/openai/realtime`
  - `@yolk-sdk/agent/providers/openai/speech`
  - `@yolk-sdk/agent/providers/vercel/ai-gateway-provider`
  - `@yolk-sdk/agent/providers/vercel/ai-gateway-classifier`
  - `@yolk-sdk/agent/providers/vercel/conformance`
  - `@yolk-sdk/agent/providers/opencode/go-provider`
  - `@yolk-sdk/agent/providers/opencode/usage`
  - `@yolk-sdk/agent/providers/opencode/conformance`
  - `@yolk-sdk/agent/providers/anthropic`
  - `@yolk-sdk/agent/providers/anthropic/claude`
  - `@yolk-sdk/agent/providers/anthropic/usage`
  - `@yolk-sdk/agent/providers/anthropic/claude-provider`
  - `@yolk-sdk/agent/providers/anthropic/conformance`
  - `@yolk-sdk/agent/providers/xai`
  - `@yolk-sdk/agent/providers/xai/grok`
  - `@yolk-sdk/agent/providers/xai/grok-provider`
  - `@yolk-sdk/agent/providers/xai/usage`
  - `@yolk-sdk/agent/providers/xai/conformance`
  - `@yolk-sdk/agent/providers/subscription-usage`
  - `@yolk-sdk/agent/skillset`
  - `@yolk-sdk/agent/voice`
  - `@yolk-sdk/agent/voice/browser`
  - `@yolk-sdk/agent/voice/react`
- `@yolk-sdk/mcp` is a sibling MCP package, not part of agent core.
- MCP APIs use explicit subpaths:
  - `@yolk-sdk/mcp/client`
  - `@yolk-sdk/mcp/client/node`
  - `@yolk-sdk/mcp/conformance` (experimental: the generic MCP conformance cases, target, seeds, observing `HttpClient`, era filter, and synthetic fixtures)
  - `@yolk-sdk/mcp/core`
  - `@yolk-sdk/mcp/protocol`
  - `@yolk-sdk/mcp/server`
  - `@yolk-sdk/mcp/server/node`
- `@yolk-sdk/knowledge` owns knowledge document/file/context/search contracts. Public subpaths: `./documents`, `./files`, `./store`, `./context`, `./chunking`, `./embeddings`, `./extraction`, `./ingestion`, `./search`, `./summarization`, `./errors`, and `./agent`.
- `@yolk-sdk/connectors` is a sibling connector package. Public subpaths: `./agent`, `./afloat`, `./afloat/conformance`, `./conformance`, `./dropbox`, `./dropbox/conformance`, `./email`, `./email/conformance`, `./figma`, `./fortnox`, `./fortnox/conformance`, `./github`, `./github/conformance`, `./google`, `./google/conformance`, `./linkedin-search`, `./linkedin-search/conformance`, `./microsoft`, `./microsoft/conformance`, `./notion`, `./notion/conformance`, `./r2-storage`, `./r2-storage/conformance`, `./telegram`, `./telegram/conformance`, `./todoist`, and `./todoist/conformance`. `./conformance` (experimental) holds conformance/testing-only Effect `HttpClient` bridges to the connector HTTP ports (string, binary read, and binary write with upload sessions) plus a static credential resolver and the `ConformanceCleanupReporter` reference; it is not a production adapter.
- `@yolk-sdk/sandbox` owns sandbox execution plane contracts; `./agent` exports the agent tool, `./vercel` exports Vercel provider code, and `./testing` exports fakes/state-store layers.
- `@yolk-sdk/codemode` owns code mode (ADR 0002): the root exports `makeCodeModeTool`, the `CodeModeExecutor` interface, catalog rendering and discovery helpers, result bounding, `codeModeStoreFromToolResults`, and `makeClassifierTool`; `./node` exports the Node-only pi executor (`makePiCodeModeExecutor`).
- `@yolk-sdk/vercel-workflows` owns Vercel Workflow orchestration contracts; root and `./workflow` export orchestration APIs, `./effect` exports host-side Effect wrappers, `./testing` exports the `TestWorkflowWorld` behavioral emulator, and hosts own concrete Workflow directives.
- `@yolk-sdk/harness` owns run lifecycle (coordinator, store, inbox, driver, outcome). Public subpaths: `./coordinator`, `./store`, `./inbox`, `./driver`, `./driver/memory`, `./driver/durable-object`, and `./outcome`. It does not replace `@yolk-sdk/agent/loop`.
- `@yolk-sdk/conformance` (experimental) owns wire fixtures, port fixtures (`PortFixture`: one recorded call through a host port that is not HTTP), offline fail-closed replay, wire faults, recording over a host-provided `HttpClient`, conformance case definitions, and the safety-gated case runner. Public subpaths: `./fixture`, `./replay`, `./record`, `./case`, and `./runner`; there is no root export. It performs no network I/O itself.
- `@yolk-sdk/emulators` (experimental) owns emulators for outside services and the `HttpClient` routing to them. Public subpaths: `./router` (Effect `EmulatedHttpClient` / `InProcessHttpClient` layers), `./gateway` (Vercel AI Gateway fetch-handler emulator, including the fixture-only classifier `/v1/evaluate` route, and their route evidence manifests), `./openai` (OpenAI Chat Completions fetch-handler emulator and its manifest; both share the internal `chat-completions.ts` core), `./anthropic` (Anthropic Messages fetch-handler emulator and its manifest, on the internal `messages.ts` core), `./codex` and `./xai` (ChatGPT Codex and xAI Grok CLI proxy Responses fetch-handler emulators and their manifests, on the internal `responses.ts` core), `./opencode` (OpenCode Go fetch-handler emulator for chat, Messages, Responses, and usage, and its manifest, on the internal fixture-only `fixture-route.ts` core that also serves the Anthropic, Codex, and Grok subscription-usage routes; every model and fixture-route fetch-handler emulator shares the internal `emulator-kernel.ts`; the stateful emulators do not), `./email` (a fixture-driven fake `EmailClient` backend exposed as a plain-JSON `call`, with its seed, faults, ledger, and manifest; no socket, TLS, MIME, or mail library), `./r2` (a fixture-driven fake `R2Presigner` and `R2ObjectClient` backend exposed as a plain-JSON `call(port, method, request)`, with its seed, faults, ledger, and manifest; no SigV4 signer or S3 client), `./node` (loopback server; Node subpath), `./fortnox` (experimental stateful Fortnox emulator on the upstream `@emulators/core` custom runtime; Node subpath), `./microsoft` (experimental stateful Microsoft Graph emulator on the same runtime, including the OneDrive copy monitor URL; Node subpath), `./dropbox` and `./notion` (experimental stateful, fixture-only Dropbox and Notion emulators on the same runtime, sharing the internal `stateful-emulator.ts` wrapper; Node subpaths), `./todoist` and `./telegram` (experimental stateful, fixture-only Todoist API v1 and Telegram Bot API emulators on the same runtime and wrapper, in its resolved mode; Node subpaths), `./github` (experimental stateful, fixture-only GitHub REST emulator on the same runtime and the `stateful-emulator.ts` wrapper in its fail-closed mode; Node subpath), `./google` (experimental stateful, fixture-only Gmail, Calendar, and Drive emulator on the same runtime, on the internal `stateful-emulator.ts` wrapper in its fail-closed mode; Node subpath), `./linkedin-search` (experimental stateful, fixture-only Exa and Enrich Layer emulator on the same runtime and wrapper, in its fail-closed mode with the per-origin bearer digest; Node subpath), and `./mcp` (experimental stateful, fixture-only emulator of the two synthetic MCP servers of `@yolk-sdk/mcp/conformance`, on the same runtime and wrapper, in its fail-closed mode with constant refusals, the bearer digest, JSON-RPC route variants, and truncation faults; Node subpath); there is no root export.
- Provider wire fixtures and conformance cases live under `@yolk-sdk/agent/providers/<vendor>/conformance` (currently `anthropic` (Messages and Claude usage), `openai` (OpenAI chat, Codex Responses, and Codex usage), `opencode` (Go protocols and usage), `vercel`, and `xai` (Grok Responses and usage)), `@yolk-sdk/mcp/conformance` (the generic MCP cases, run through the real `@yolk-sdk/mcp/client`; products supply only targets and seeds), and `@yolk-sdk/connectors/<provider>/conformance` (currently `dropbox`, `email`, `fortnox`, `github`, `google`, `linkedin-search`, `microsoft`, `notion`, `r2-storage`, `telegram`, and `todoist`; `email` and `r2-storage` use port fixtures over host ports (`EmailClient`; `R2Presigner` and `R2ObjectClient`) instead of HTTP wire fixtures); see the conformance import rule under [Dependency Direction](#dependency-direction).
- OpenAI/Codex, Vercel AI Gateway, OpenCode Go, Anthropic/Claude, and xAI/Grok provider mechanics live under `@yolk-sdk/agent/providers/*`; Codex, Claude, Grok, and OpenCode Go also expose best-effort subscription-allowance snapshots from private provider endpoints.
- Package roots stay tiny; prefer subpath imports for feature APIs.

## Physical Layout

- Keep repo package shape aligned with public package shape.
- Agent internals live under `packages/agent/src/*`, not separate workspace packages.
- MCP internals live under `packages/mcp/src/*`, not separate workspace packages.
- Sandbox internals live under `packages/sandbox/src/*`, not separate workspace packages.
- Code mode internals live under `packages/codemode/src/*`, not app code.
- Vercel Workflow internals live under `packages/vercel-workflows/src/*`, not app code.
- Harness internals live under `packages/harness/src/*`, not app code.
- Conformance internals live under `packages/conformance/src/*`, not app code.
- Emulator internals live under `packages/emulators/src/*`, not app code.
- Area tests mirror source layout:
  - `packages/agent/test/{protocol,loop,runtime,client,compaction,tools,react,oauth,providers,skillset,voice,property}`
  - `packages/mcp/test/{client,server,conformance}`
  - `packages/sandbox/test/{core,agent,vercel}.test.ts`
  - `packages/codemode/test`
  - `packages/vercel-workflows/test`
  - `packages/harness/test`
  - `packages/conformance/test`
  - `packages/emulators/test`

## Dependency Direction

```txt
examples/next, examples/next/e2e, cloudflare/agent -> @yolk-sdk/* public subpaths
@yolk-sdk/knowledge -> gpt-tokenizer + @yolk-sdk/agent/protocol + @yolk-sdk/agent/tools + @yolk-sdk/agent/loop only for agent adapter
@yolk-sdk/mcp -> official @modelcontextprotocol v2 packages + Effect + @yolk-sdk/agent/protocol only for tool/content adapters; @effect/platform-node stays behind Node subpaths
@yolk-sdk/connectors -> @yolk-sdk/agent/{protocol,loop,tools} only in ./agent; no app/storage/auth/UI policy
@yolk-sdk/sandbox root -> Effect only; ./agent -> sandbox core + @yolk-sdk/agent/{tools,protocol,loop}; ./vercel -> sandbox core/state + Effect + @vercel/sandbox via VercelSandboxClient/layer
@yolk-sdk/codemode root -> @yolk-sdk/agent/{protocol,loop,tools,classification} + Effect + @earendil-works/pi-codemode/declarations (pure); ./node -> codemode core + @earendil-works/pi-codemode (exact 1.0.0) + node:module; @yolk-sdk/agent never imports code mode
@yolk-sdk/vercel-workflows -> workflow runtime APIs + generic durable stream helpers + Effect Workflow client/layer; no @yolk-sdk/agent/protocol or app/auth/provider/tool/storage policy
@yolk-sdk/harness core -> Effect only; ./outcome -> @yolk-sdk/agent/{protocol,loop,compaction}; no app/auth/UI/product policy
@yolk-sdk/conformance -> Effect only (no @yolk-sdk/*, Node builtins, React, Next); hosts supply the network HttpClient
@yolk-sdk/emulators ./router -> Effect only; ./gateway, ./openai, ./anthropic, ./codex, ./xai, ./opencode -> Web fetch APIs + Effect Schema; ./email, ./r2 -> plain JSON + Effect Schema; ./node -> node:http; never @yolk-sdk/*, React, or Next (wire shapes come from conformance fixtures copied as data, linked by case id)
@yolk-sdk/emulators/{fortnox,microsoft,dropbox,notion,todoist,telegram,github,google,linkedin-search,mcp} -> @emulators/core (exact 0.12.0, Node-only, lazily imported) + Effect Schema; @emulators/core only for stateful connector and MCP emulators
@yolk-sdk/connectors -> never @yolk-sdk/emulators (emulators plug into connector ports structurally)
@yolk-sdk/agent/providers/*/conformance -> @yolk-sdk/conformance/* (see conformance import rule below)
@yolk-sdk/connectors/**/conformance -> @yolk-sdk/conformance/* (see conformance import rule below)
@yolk-sdk/mcp/conformance -> @yolk-sdk/conformance/* + @yolk-sdk/mcp/client + eventsource-parser (the client's own ^3.0.0 range, so one copy resolves; verified in-repo by a parity test) (see conformance import rule below)
@yolk-sdk/agent/client -> @yolk-sdk/agent/protocol + Effect HTTP/Stream + runtime-only browser WebSocket/Blob/File/FileReader APIs
@yolk-sdk/agent/react -> @yolk-sdk/agent/client + @yolk-sdk/agent/protocol + Effect + React peer
@yolk-sdk/agent/compaction -> @yolk-sdk/agent/{loop,protocol} + Effect
@yolk-sdk/agent/classification -> @yolk-sdk/agent/protocol + Effect; never provider code
@yolk-sdk/agent/providers/* -> @yolk-sdk/agent/oauth + @yolk-sdk/agent/{loop,protocol} + Effect; openai/realtime + openai/speech may also use @yolk-sdk/agent/voice contracts; vercel/ai-gateway-classifier implements @yolk-sdk/agent/classification
@yolk-sdk/agent/voice -> @yolk-sdk/agent/{loop,protocol}
@yolk-sdk/agent/voice/browser -> voice core + browser WebRTC globals (lazy, behind a runtime seam)
@yolk-sdk/agent/voice/react -> voice core + voice/browser + React peer
@yolk-sdk/agent core -> no @yolk-sdk/knowledge, @yolk-sdk/mcp, app, Next, provider SDKs
```

Conformance import rule (canonical statement; other docs reference it): in `packages/agent/src`, only code under `providers/*/conformance/` may import `@yolk-sdk/conformance/*` (any subpath); in `packages/connectors/src`, only code under a `conformance/` directory may; in `packages/mcp/src`, only code under `src/conformance/` may. Package tests may import it.

## Tree-Shaking Constraints

- ESM only: package manifests use `"type": "module"`.
- Every publishable package declares `"sideEffects": false`.
- Use explicit `exports`; avoid broad root barrels for feature APIs.
- No top-level env reads, service construction, SDK clients, or network calls in packages.
- Import types as types; Oxlint enforces `typescript/consistent-type-imports`.
- Keep Node-specific APIs behind Node subpaths (`@yolk-sdk/codemode/node`, `@yolk-sdk/mcp/client/node`, `@yolk-sdk/mcp/server/node`, `@yolk-sdk/emulators/node`, `@yolk-sdk/emulators/fortnox`, `@yolk-sdk/emulators/microsoft`, `@yolk-sdk/emulators/dropbox`, `@yolk-sdk/emulators/notion`, `@yolk-sdk/emulators/todoist`, `@yolk-sdk/emulators/telegram`, `@yolk-sdk/emulators/github`, `@yolk-sdk/emulators/google`, `@yolk-sdk/emulators/linkedin-search`, `@yolk-sdk/emulators/mcp`).
- Prefer runtime-portable Effect APIs in package code.

## Workspace Setup

- Shared dependency pins live in `pnpm-workspace.yaml` catalogs; use `catalog:` for Effect-family packages, TypeScript, and Vitest.
- Root `packageManager` pins pnpm for reproducible installs.
- Package tsconfigs extend `packages/tsconfig.base.json`; keep package-local configs to `outDir`, `rootDir`, and include/exclude overrides.
- Keep package dependencies explicit in each package manifest even when versions come from catalogs.
- Internal `@yolk-sdk/*` dependencies use `workspace:^`; Changesets rewrites publish ranges.
- Package-internal relative imports use explicit `.ts` extensions. `packages/tsconfig.base.json` enables `rewriteRelativeImportExtensions` for emit.

## Boundary Enforcement

- `pnpm packages:check` runs package typechecks, `scripts/check-package-boundaries.ts`, `scripts/check-package-exports.ts`, and `scripts/check-emulator-evidence.ts`.
- Boundary script prevents example app, Cloudflare, and `examples/next/e2e` code from importing retired internal package names.
- Boundary script prevents retired package directories from reappearing.
- Boundary script prevents root `@yolk-sdk/agent` and `@yolk-sdk/mcp` imports in example app, Cloudflare, and `examples/next/e2e` code; use explicit subpaths.
- Boundary script prevents agent core subpaths from importing knowledge, MCP, retired package names, `@yolk-sdk/agent/react`, Next, React, or Node builtins, and `@yolk-sdk/agent/classification` from importing provider code. `@yolk-sdk/agent/react` and `@yolk-sdk/agent/voice/react` are the only React-using subpaths.
- Boundary script prevents knowledge from importing MCP/React/Next/Node.
- Boundary script prevents sandbox core from importing agent deps and `@vercel/sandbox` outside `packages/sandbox/src/vercel`.
- Boundary script keeps `@yolk-sdk/codemode` to `@yolk-sdk/agent` among Yolk packages, keeps Node builtins, the pi runtime (`@earendil-works/pi-codemode` root and `/worker`, `quickjs-wasi`), and `@yolk-sdk/codemode/node` out of the code mode core (only `packages/codemode/src/node.ts` may use them), and prevents `@yolk-sdk/agent` from importing code mode.
- Boundary script prevents harness from importing agent/knowledge/MCP/Next/React/Node except `packages/harness/src/outcome.ts`, which may import `@yolk-sdk/agent/{loop,protocol,compaction}`.
- Boundary script prevents conformance from importing other `@yolk-sdk/*` packages, Node builtins, React, or Next.
- Boundary script enforces the conformance import rule from [Dependency Direction](#dependency-direction).
- Boundary script allows `@yolk-sdk/agent` in `packages/connectors/src` only from `src/agent.ts`.
- Boundary script prevents emulators from importing other `@yolk-sdk/*` packages, React, or Next, allows Node builtins and `@emulators/core` only in `packages/emulators/src/node.ts`, `packages/emulators/src/fortnox.ts`, `packages/emulators/src/fortnox/**`, `packages/emulators/src/microsoft.ts`, `packages/emulators/src/microsoft/**`, `packages/emulators/src/dropbox.ts`, `packages/emulators/src/dropbox/**`, `packages/emulators/src/notion.ts`, `packages/emulators/src/notion/**`, `packages/emulators/src/todoist.ts`, `packages/emulators/src/todoist/**`, `packages/emulators/src/telegram.ts`, `packages/emulators/src/telegram/**`, `packages/emulators/src/github.ts`, `packages/emulators/src/github/**`, `packages/emulators/src/google.ts`, `packages/emulators/src/google/**`, `packages/emulators/src/linkedin-search.ts`, `packages/emulators/src/linkedin-search/**`, `packages/emulators/src/mcp.ts`, and `packages/emulators/src/mcp/**`, and prevents connectors from importing `@yolk-sdk/emulators`.
- Evidence script (`scripts/check-emulator-evidence.ts`, `pnpm packages:evidence`) fails emulator route manifests that cite unknown conformance case ids, list a route twice, mark a connector write route without verified evidence (unless a non-expired entry in `scripts/emulator-evidence-pending.json` names it; an expired entry or a malformed pending file fails), mark a verified connector write route with a missing, unreadable, or future `observedAt` or with no cited cases, or mark a route verified when none of its cited cases has a verified fixture; it warns on unverified and stale (over 30 days) evidence, other routes citing no cases, pending routes until their `expires` date, and stale pending entries.
- Export smoke script verifies explicit exports, ESM, `sideEffects: false`, tiny agent/MCP roots, and that `@yolk-sdk/conformance` and `@yolk-sdk/emulators` have no root export.
- Vercel Workflow durable event helpers stay generic over JSON-serializable events; do not import `@yolk-sdk/agent/protocol` there.

## When Adding A Package API

1. Add the source under the package that owns the public namespace.
2. Add an explicit subpath export in `package.json`.
3. Add tests under the matching `test/*` area.
4. Update `packages/AGENTS.md` and the package-local `AGENTS.md` if the boundary changes.
5. Run `pnpm packages:check`, `pnpm tsc`, `pnpm lint`, and `pnpm test:run`.
