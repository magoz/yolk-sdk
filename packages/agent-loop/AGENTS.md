# Stateless Agent Loop

`@yolk/agent-loop` runs a provider-neutral LLM ⇄ tool turn loop. It accepts a protocol transcript and emits protocol events. It owns no persistence or app context beyond injected services.

## Role

- Orchestrate model calls through `LLMProvider`.
- Execute requested tools through `ToolExecutor`.
- Accumulate assistant text/reasoning/tool-call state.
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
- Preserve tool call ids and ordering semantics across call/result events.
- Keep test helpers out of the root export.

## Tests

- Use `@effect/vitest` patterns already present in `test/`.
- Cover provider event ordering, tool execution, errors, capability rejection, and accumulator behavior.
- Tests may import `../src/testing` locally; external package tests use `@yolk/agent-loop/testing`.
