# Agent Protocol

`@yolk/protocol` is the shared domain-free wire model for agent messages, events, tools, content, reasoning, and capabilities. It is the bottom package in the reusable stack.

## Role

- Define serializable `AgentMessage` input/output shapes.
- Define `AgentEvent` stream events emitted by loops/providers.
- Define tool metadata, calls, results, and errors.
- Define model capability and reasoning request types.
- Define canonical usage, retry, and compaction lifecycle events.
- Define generic session/transport envelopes such as `SessionSnapshot` and `UserInput` without app auth assumptions.
- Provide content helpers for text and multimodal parts.

## Boundaries

- No provider SDKs, app auth, storage, React, HTTP, or runtime orchestration.
- No product/domain concepts: users, teams, projects, billing, permissions.
- No transport assumptions; types must work over HTTP, SSE, NDJSON, WebRTC adapters, or tests.
- Keep schemas and helpers generic enough for app, client, loop, MCP, and voice packages.

## Public model

| Export area  | Purpose                                          |
| ------------ | ------------------------------------------------ |
| `message`    | Agent transcript messages and ids                |
| `event`      | Streamed loop/provider events                    |
| `tool`       | Tool definitions, calls, results                 |
| `content`    | Text/image/audio content helpers                 |
| `capability` | Model input/tool capability flags                |
| `reasoning`  | Provider-supplied reasoning config/data          |
| `session`    | Generic session snapshot and WS envelope schemas |
| `usage`      | Provider-neutral token usage helpers             |

## Design rules

- Keep protocol data JSON-serializable unless a type is explicitly app-local.
- Keep `AgentErrorCode` small and stable; packages map richer local errors to these wire codes.
- Prefer helpers (`contentText`, `contentParts`, `appendTextToContent`) over duplicate parsing logic downstream.
- Assistant messages use ordered `AssistantPart`s: text, reasoning, host tool calls, provider tool calls, provider tool results.
- Host tool results stay as separate `ToolResultMessage`s; provider-executed results stay inside assistant parts/events.
- `ToolResult.isError` marks tool-origin failures that remain model-visible; transport/execution failures still use error events.
- Tool lifecycle events are `ToolInput*`, `ToolApproval*`, `ToolExecution*`, and `ProviderToolResult`; no old lifecycle aliases.
- Tool ids/names are non-empty trimmed strings; validate at protocol boundaries.
- Provider reasoning is summary text only; never model hidden chain-of-thought.
- Adding a protocol variant requires package and app tests for every consumer boundary.
- Provider adapters normalize usage; protocol stays provider-neutral.
- Session envelopes may reference transport flow but must not depend on concrete HTTP/WS APIs.

## Tests

- Place semantic behavior tests beside protocol helpers.
- Cover malformed/empty/multimodal content normalization.
- Avoid provider-specific fixtures.
