# Headless React Agent UI

`@yolk-sdk/react` is the React adapter over the domain-free agent client stack. It provides hooks and render-ready chat models only. It must not ship UI components, styling, auth flows, provider choices, or app routes.

## Role

- Own React lifecycle around `@yolk-sdk/agent/client` transport: submit, stream, abort, cleanup.
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

| Export                  | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `useAgentChat`          | Headless chat hook over streamed `AgentEvent`s              |
| `AgentChatState`        | Render-ready state: status, error, chat messages, events    |
| `AgentChatAction`       | Reducer command model for hydrate/submit/edit/run lifecycle |
| `AgentChatSessionEvent` | Schema-backed UI/session edit event model                   |
| `AgentChatMessage`      | Role-grouped render message                                 |
| `AgentChatPart`         | Text, reasoning, tool call/result, error parts              |
| `toAgentMessages`       | Render model → protocol transcript                          |
| `buildAgentChatItems`   | Flat render-item projection for simple UIs                  |
| `dedupeAgentChatToolRunItems` | Drop duplicate live/persisted tool cards by tool call id |
| `reduceAgentChatState`  | Pure reducer for headless chat actions/events               |
| selectors               | Reasoning/tool/activity helpers                             |

## Hook contract

`useAgentChat` returns both render state and protocol replay:

- `chatMessages`: primary UI source of truth.
- `messages`: protocol transcript derived from `chatMessages`.
- `state.sessionEvents`: append-only local session edit events.
- `status`, `error`, `isRunning`, `isWaiting`.
- `submitMessage`, `submitText`, `deleteTurn`, `regenerateFrom`, `editUserMessage`, `stop`.
- `submitToolApprovalResponse`, `submitQuestionResponse` for HITL resume.
- `applyEvent`, `appendMessage`, `fail` for custom transports/integrations.

## Design rules

- Provider reasoning only: display `LLMReasoningDelta` / assistant reasoning parts, never invented reasoning.
- Text may start after reasoning in the same assistant turn: first `LLMTextDelta` must create a streaming `Text` part if only `Reasoning` is streaming. Do not wait for final `AssistantMessage`.
- Tool parts expose input streaming, approval, denied, question, executing, completed, errored, and provider-completed states.
- Answered/cancelled question tool states should retain the original request when available so UI/replay can resolve selected option labels.
- HITL submit should optimistically apply `hitlResponseEvent`; server replay later de-dupes by protocol `eventId`.
- Completed tool parts may carry `result.isError`; renderers can style them as tool-origin errors while preserving replay.
- Same-turn sibling tool calls stay in one assistant message while any tool in the batch is open; calls after terminal tool state start a new assistant message.
- Subagent lifecycle events are protocol/activity telemetry; headless chat projections should tolerate them without duplicating tool parts.
- Preserve ordered assistant parts when converting render messages back to protocol messages.
- Preserve ordered multimodal user content (text/images/documents) when projecting/replaying messages.
- Preserve `createdAtMs`, `author.displayName`, and `annotations` when projecting protocol messages and replaying via `toAgentMessages`.
- Preserve timing when tool result/completion events arrive in different order.
- Tool timing uses protocol `createdAtMs` first, injected `nowMs` fallback; item timing is no-time, start-only, or known start+end.
- `nowMs` is injected at hook/action boundary; reducers/projections do not read wall clock.
- `ToolResult` parts are only for orphan results; normal results merge into matching tool calls.
- Flat chat items de-dupe tool runs by transcript-global tool call id to avoid live+persisted duplicate cards.
- `AgentChatMessage[]` is render source; protocol `AgentMessage[]` is replay/transport source.
- `AgentChatMessage` carries stable `turnId` and monotonic `sequence`; do not infer turns by parsing IDs or array position.
- `deleteTurn` removes a user+assistant turn without transport; avoid deleting flat render items.
- `regenerateFrom` truncates from a selected message and starts a new run.
- `editUserMessage` replaces user content, truncates later messages, records an edit event, then starts a new run.
- `editUserMessage` accepts protocol `Content`; host UIs decide whether to expose text-only or multimodal edits.
- `src/chat-session-events.ts` events are UI/session audit records, not runtime persistence events.
- Transport can be injected; default uses `streamAgentEventStream`; async iterable transport stays injection-compatible.
- Reducer de-dupes streamed events by optional protocol `eventId`; duplicate replay should not duplicate text/tool/UI state.
- Retain `Effect.runFork` fibers and interrupt on `stop`/unmount; abort signals alone are not enough.

## Tests

- Keep hook lifecycle tests in `src/use-agent-chat.test.ts`.
- Cover injected transport requests, streamed events, blank submit guards, and abort cleanup.
- Cover delete/regenerate/edit behavior and session event emission in `src/use-agent-chat.test.ts`.
- Keep session event schema coverage near `src/chat-session-events.ts` or reducer tests.
- Keep render model tests next to their modules: `src/chat-core.test.ts`, `src/chat-messages.test.ts`, `src/chat-items.test.ts`.
- Test package behavior here, not through the example app.

## App usage

The Next example keeps component/UI concerns local under `examples/next/app/agent/*` and imports `useAgentChat`, `buildAgentChatItems`, and chat item types from this package.
