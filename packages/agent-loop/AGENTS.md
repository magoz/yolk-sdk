# Stateless Agent Loop

`@yolk/agent-loop` runs a provider-neutral LLM ⇄ tool turn loop. It accepts a protocol transcript and emits protocol events. It owns no persistence or app context beyond injected services.

## Role

- Orchestrate model calls through `LLMProvider`.
- Execute requested tools through `ToolExecutor`.
- Accumulate assistant text/reasoning/tool-call state.
- Accumulate provider-normalized usage and emit retry lifecycle events.
- Enforce model input/tool capability constraints.
- Expose test helpers through `@yolk/agent-loop/testing` only.

## Boundaries

- Stateless: no sessions, persistence, WebSockets, SSE, auth, or product context.
- No provider SDK imports; app adapters implement `LLMProvider`.
- No app tool catalogs; tools enter through `ToolExecutor`.
- No fabricated reasoning; only pass through provider-supplied reasoning summaries.

## Public model

| Export area   | Purpose                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `run`         | Main loop entrypoint                                                    |
| `llm-event`   | Provider-normalized event model                                         |
| `accumulator` | Assistant/tool/reasoning accumulation helpers                           |
| `services/*`  | Effect service contracts for provider, tools, config, context transform |
| `error`       | Typed loop errors                                                       |
| `./testing`   | `FauxProvider`, `Reply`, `TestToolExecutor`                             |

## Design rules

- Keep illegal states unrepresentable in turn and tool lifecycle types.
- Reject unsupported content/tools before provider calls.
- Keep provider quirks in app/provider adapters, not loop core.
- Provider streams must emit exactly one `LLMDone`; `stopReason` must match tool-call presence.
- `LLMProvider` fails with provider-only `LLMProviderError`, not full `AgentLoopError`.
- Use `Ref` for loop-owned stream state; avoid mutable arrays/object counters in `run`.
- Preserve tool call ids and ordering semantics across call/result events.
- Retry retryable provider errors in-loop; never retry context overflow blindly.
- Map loop errors to protocol `AgentError` via `agentLoopErrorToAgentError`; keep richer causes local.
- Keep compaction strategy outside loop; `ContextTransformer` returns compacted messages + lifecycle events and fails with `ContextTransformError`.
- Keep test helpers out of the root export.

## Tests

- Use `@effect/vitest` patterns already present in `test/`.
- Cover provider event ordering, tool execution, error mapping, capability rejection, and accumulator behavior.
- Tests may import `../src/testing` locally; external package tests use `@yolk/agent-loop/testing`.
