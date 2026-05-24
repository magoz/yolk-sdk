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

## Boundaries

- No React, Next.js, app imports, auth, storage drivers, provider SDKs, or product concepts.
- Do not import `@yolk-sdk/knowledge`, `@yolk-sdk/mcp`, `@yolk-sdk/react`, or concrete adapter packages from core agent subpaths.
- Protocol has no package dependencies except Effect.
- Loop depends on protocol only.
- Runtime depends on protocol + loop only.
- Client depends on protocol only.
- Tools depend on protocol + loop only.
- Package architecture constraints live in `patterns/PACKAGE_ARCHITECTURE.md`.
- Keep all subpaths ESM/tree-shakeable: no top-level env reads, SDK clients, network calls, or side effects.
- `@yolk-sdk/agent/tools` owns the domain-free `task` tool contract for subagents; host apps provide subagent execution, models, prompts, and tool policy.
- `@yolk-sdk/agent/tools` owns the domain-free `question` HITL tool contract; loop intercepts it before executor dispatch.
- `@yolk-sdk/agent/tools` exposes `makeTool` for Effect-Schema-backed registrations; avoid hand-written JSON Schema when validation schema can be the source of truth.
- Tool approval is host-enforced policy on normal tools, not a model-callable permission tool; v1 approvals are per-call, no persistent allow-always rules.
- Use `EmptyToolParams` for no-arg `makeTool` tools instead of `Schema.Struct({})` when author intent is no parameters.
- v1 subagents may use normal tools but must not receive the `task` tool recursively unless a future explicit capability enables it.
- Protocol owns `SubagentStarted`/`SubagentCompleted`, `makeSubagentRunId`, and optional `createdAtMs`; loop emits lifecycle events around `task` calls while preserving generic tool lifecycle as the source of truth.

## Protocol/loop rules

- `AgentReasoningEffort` is protocol-only request config; app/provider layers choose and pass through values.
- `Content = string | ContentPart[]`; use protocol helpers (`contentText`, `contentPreview`, `contentParts`, `isContentEmpty`, `appendTextToContent`) instead of app-local duplication.
- `AgentModelCapabilities` is protocol-only; app/provider config chooses text-only vs text+image, and loop rejects unsupported input before provider calls.
- Loop stays stateless: no persistence, sessions, WebSockets/SSE, compaction policy, app context, or provider SDKs.
- Provider adapters classify retryable failures and normalize raw usage; loop owns retry/usage aggregation.
- Compaction is host-owned through `ContextTransformer`; durable checkpoints belong in runtime/app storage, not loop core.
- Only preserve provider-supplied reasoning summaries (`LLMReasoningDelta` / assistant reasoning parts); never fabricate reasoning.
- `accumulateAssistantMessage` preserves ordered assistant parts: text, reasoning, host tool calls, provider tool calls/results.
- Same-turn sibling tool calls are native parallelism: providers emit normal tool calls, loop runs them concurrently within `toolConcurrency`, and dependent work waits for the next model turn.
- HITL semantics live in `patterns/AGENT_HITL.md`: approvals/questions pause with `AgentAwaitingInput`; responses resume through `hitlResponses`/typed client inputs.
- Question resume content must be model-visible text with selected answer labels plus structured answers; never replay only `answered`.

## Tests

- Area tests live under `test/protocol`, `test/loop`, `test/runtime`, `test/client`, `test/tools`, and `test/property`.
- Use `@yolk-sdk/agent/loop/testing` for fake providers/tool executors outside loop internals.
- Cover task tool schema, unknown subagent rejection, and result formatting in `test/tools`.
- Cover subagent protocol round-trips in `test/protocol` and same-turn parallel task lifecycle in `test/loop`.
