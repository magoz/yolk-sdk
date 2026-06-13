# Agent Package

`@yolk-sdk/agent` is the main package for building and running agents. Root export stays intentionally tiny; use explicit subpaths.

## Subpaths

| Subpath | Source | Role |
| --- | --- | --- |
| `@yolk-sdk/agent/protocol` | `src/protocol` | Agent wire/message/event schemas |
| `@yolk-sdk/agent/loop` | `src/loop` | Stateless LLM/tool loop |
| `@yolk-sdk/agent/loop/testing` | `src/loop/testing` | Loop test helpers |
| `@yolk-sdk/agent/runtime` | `src/runtime` | Generic runtime/session orchestration |
| `@yolk-sdk/agent/client` | `src/client` | Client transport/state helpers |
| `@yolk-sdk/agent/tools` | `src/tools` | Generic tool module registry |
| `@yolk-sdk/agent/react` | `src/react` | Headless React chat hook/state helpers |
| `@yolk-sdk/agent/oauth` | `src/oauth` | Provider-neutral OAuth token contracts |
| `@yolk-sdk/agent/providers/openai` | `src/providers/openai` | OpenAI/Codex OAuth and provider mechanics |
| `@yolk-sdk/agent/providers/openai/codex` | `src/providers/openai/codex.ts` | OpenAI Codex request and auth helpers |
| `@yolk-sdk/agent/providers/openai/codex-provider` | `src/providers/openai/codex-provider.ts` | Codex LLM provider factory |
| `@yolk-sdk/agent/providers/openai/provider` | `src/providers/openai/provider.ts` | OpenAI-compatible LLM provider factory |
| `@yolk-sdk/agent/providers/anthropic` | `src/providers/anthropic` | Anthropic/Claude OAuth and provider mechanics |
| `@yolk-sdk/agent/providers/anthropic/claude` | `src/providers/anthropic/claude.ts` | Claude request and auth helpers |
| `@yolk-sdk/agent/providers/anthropic/claude-provider` | `src/providers/anthropic/claude-provider.ts` | Claude LLM provider factory |
| `@yolk-sdk/agent/skillset` | `src/skillset` | Portable skill + command parsing/catalog |
| `@yolk-sdk/agent/voice` | `src/voice` | Provider-neutral voice tool-call bridge |

## Boundaries

- Core subpaths have no React, Next.js, app imports, auth, storage drivers, provider SDKs, or product concepts.
- `src/react` is the only React-using area; React is an optional peer.
- Provider subpaths own vendor mechanics only; hosts still own token storage/refresh and app policy.
- Do not import `@yolk-sdk/knowledge`, `@yolk-sdk/mcp`, or app packages from agent subpaths.
- Protocol has no package dependencies except Effect.
- Loop depends on protocol only.
- Runtime depends on protocol + loop only.
- Client depends on protocol only.
- Tools depend on protocol + loop only.
- OAuth and skillset depend on Effect only.
- Voice depends on protocol + loop only.
- React depends on client + protocol only.
- Providers depend on protocol + loop + oauth only.
- Package architecture constraints live in `patterns/PACKAGE_ARCHITECTURE.md`.
- Keep all subpaths ESM/tree-shakeable: no top-level env reads, SDK clients, network calls, or side effects.
- `@yolk-sdk/agent/tools` owns the domain-free `task` tool contract for subagents; host apps provide subagent execution, models, prompts, and tool policy.
- `@yolk-sdk/agent/tools` owns the domain-free `question` HITL tool contract; loop intercepts it before executor dispatch.
- `@yolk-sdk/agent/tools` exposes `makeTool` for Effect-Schema-backed registrations; avoid hand-written JSON Schema when validation schema can be the source of truth.
- Tool approval is host-enforced policy on normal tools, not a model-callable permission tool; v1 approvals are per-call, no persistent allow-always rules.
- Use `EmptyToolParams` for no-arg `makeTool` tools instead of `Schema.Struct({})` when author intent is no parameters.
- v1 subagents may use normal tools but must not receive the `task` tool recursively unless a future explicit capability enables it.
- Protocol owns `SubagentStarted`/`SubagentCompleted` and `makeSubagentRunId`; loop emits lifecycle events around `task` calls while preserving generic tool lifecycle as the source of truth.

## Protocol/loop rules

- `AgentReasoningEffort` is protocol-only request config; app/provider layers choose and pass through values.
- `AgentMessage` envelope fields are optional and model-visible: `createdAtMs`, `author.displayName`, and JSON `annotations`; preserve them through protocol round-trips.
- Provider lowering renders message envelopes via `messageContextText` + `prependMessageContextToContent`; annotations are context only, not instructions.
- `Content = string | ContentPart[]`; parts include text, image, document, and audio. Media parts carry `InlineBase64`, `Url`, or host-owned `Ref` sources. Use protocol helpers (`inlineBase64AttachmentSource`, `urlAttachmentSource`, `refAttachmentSource`, `contentText`, `contentPreview`, `contentParts`, `isContentEmpty`, `appendTextToContent`, `resolveContentAttachmentSources`) instead of app-local duplication.
- Keep semantic `ImagePart`/`DocumentPart`/`AudioPart` over generic file parts; capability checks, provider lowering, validation, and UI rendering branch by media kind. Add generic file content only when arbitrary non-media files become first-class.
- `AgentModelCapabilities` is protocol-only; app/provider config chooses input media support, and loop rejects unsupported input before provider calls.
- Loop stays stateless: no persistence, sessions, WebSockets/SSE, compaction policy, app context, or provider SDKs.
- Provider adapters classify retryable failures and normalize raw usage; loop owns retry/usage aggregation.
- Compaction is host-owned through `ContextTransformer`; durable checkpoints belong in runtime/app storage, not loop core.
- Only preserve provider-supplied reasoning summaries (`LLMReasoningDelta` / assistant reasoning parts); never fabricate reasoning.
- `accumulateAssistantMessage` preserves ordered assistant parts: text, reasoning, host tool calls, provider tool calls/results.
- Same-turn sibling tool calls are native parallelism: providers emit normal tool calls, loop runs them concurrently within `toolConcurrency`, and dependent work waits for the next model turn.
- HITL semantics live in `patterns/AGENT_HITL.md`: approvals/questions pause with `AgentAwaitingInput`; responses resume through `hitlResponses`/typed client inputs.
- Question resume content must be model-visible text with selected answer labels plus structured answers; never replay only `answered`.
- Use SDK HITL helpers for durable apps: `plainHitlResponse`, `questionResponseStructuredContent`, `hitlResponseEvent`, and `toolRunsFromHitlRequests`.
- Client HTTP transport treats `AgentEnd`/`AgentError`/`AgentAwaitingInput` as logical end, but only pre-terminal consumer cancellation should abort the body.

## Tests

- Area tests live under `test/protocol`, `test/loop`, `test/runtime`, `test/client`, `test/tools`, `test/react`, `test/oauth`, `test/providers`, `test/skillset`, `test/voice`, and `test/property`.
- Use `@yolk-sdk/agent/loop/testing` for fake providers/tool executors outside loop internals.
- Cover task tool schema, unknown subagent rejection, and result formatting in `test/tools`.
- Cover subagent protocol round-trips in `test/protocol` and same-turn parallel task lifecycle in `test/loop`.
