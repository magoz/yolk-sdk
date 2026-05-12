# Headless React Agent UI

`@yolk/react` is the React adapter over the domain-free agent client stack. It provides hooks and render-ready chat models only. It must not ship UI components, styling, auth flows, provider choices, or app routes.

## Role

- Own React lifecycle around `@yolk/client` transport: submit, stream, abort, cleanup.
- Own a headless chat render model: `AgentChatMessage` and `AgentChatPart`.
- Convert between render model and protocol transcript via `toAgentMessages`.
- Keep polished UI projection generic via `buildAgentChatItems`.

## Boundaries

- No JSX components beyond hook implementation needs.
- No CSS, Tailwind, class names, icons, or DOM layout.
- No auth, Codex, OpenAI, model defaults, or route-specific UI.
- No product permissions or app tool catalogs.
- Browser APIs are limited to React lifecycle and `AbortController`/`AbortSignal` types.

## Public model

| Export                | Purpose                                          |
| --------------------- | ------------------------------------------------ |
| `useAgentChat`        | Headless chat hook over streamed `AgentEvent`s   |
| `AgentChatState`      | Render-ready state: status, error, chat messages |
| `AgentChatMessage`    | Role-grouped render message                      |
| `AgentChatPart`       | Text, reasoning, tool call/result, error parts   |
| `toAgentMessages`     | Render model → protocol transcript               |
| `buildAgentChatItems` | Flat render-item projection for simple UIs       |
| selectors             | Reasoning/tool/activity helpers                  |

## Hook contract

`useAgentChat` returns both render state and protocol replay:

- `chatMessages`: primary UI source of truth.
- `messages`: protocol transcript derived from `chatMessages`.
- `status`, `error`, `isRunning`.
- `submitMessage`, `submitText`, `stop`.
- `applyEvent`, `appendMessage`, `fail` for custom transports/integrations.

## Design rules

- Provider reasoning only: display `LLMReasoningDelta` / assistant reasoning parts, never invented reasoning.
- Text may start after reasoning in the same assistant turn: first `LLMTextDelta` must create a streaming `Text` part if only `Reasoning` is streaming. Do not wait for final `AssistantMessage`.
- Tool parts expose input streaming, approval, denied, executing, completed, errored, and provider-completed states.
- Preserve ordered assistant parts when converting render messages back to protocol messages.
- Preserve timing when tool result/completion events arrive in different order.
- `nowMs` is injected at hook/action boundary; reducers/projections do not read wall clock.
- `ToolResult` parts are only for orphan results; normal results merge into matching tool calls.
- `AgentChatMessage[]` is render source; protocol `AgentMessage[]` is replay/transport source.
- Transport can be injected; default uses `streamAgentEventStream`; async iterable transport stays injection-compatible.
- Retain `Effect.runFork` fibers and interrupt on `stop`/unmount; abort signals alone are not enough.

## Tests

- Keep hook lifecycle tests in `src/use-agent-chat.test.ts`.
- Cover injected transport requests, streamed events, blank submit guards, and abort cleanup.
- Keep render model tests next to their modules: `chat-core.test.ts`, `chat-messages.test.ts`, `chat-items.test.ts`.
- Test package behavior here, not through the example app.

## App usage

The Next app keeps component/UI concerns local under `app/agent/*` and imports `useAgentChat`, `buildAgentChatItems`, and chat item types from this package.
