# Reusable Agent Stack

Domain-free packages. No users, teams, orgs, projects, billing, OAuth, knowledge stores, or product permissions here.

## Packages

| Package | Role | Depends on |
| --- | --- | --- |
| `@yolk/protocol` | Shared schemas, messages, tools, events | Effect |
| `@yolk/agent-loop` | Stateless LLM ⇄ tool turn loop | `@yolk/protocol`, Effect |
| `@yolk/agent-runtime` | Session load/save orchestration over agent-loop | `@yolk/protocol`, `@yolk/agent-loop`, Effect |
| `@yolk/client` | Effect stream transport + reducer/state helpers | `@yolk/protocol` |

## Dependency Rule

```txt
app -> agent-runtime -> agent-loop -> protocol
app -> client -> protocol
```

## Naming

- `agent-loop` = pure model/tool loop; messages in, events out.
- `agent-runtime` = server lifecycle: sessions, persistence, resume/fanout adapters.
- `client` = UI-side consumer; never runs the loop in production.
- Avoid `harness` for current packages; reserve for a future batteries-included agent kit if needed.
- Avoid `executor` for loop code; use for future sandbox/tool execution layer if needed.

## Boundaries

- App/server owns auth, prompts, domain context, tool policy, integrations, model choice.
- App/server owns LLM provider implementations, OAuth flows, and token storage (`lib/agents`, `lib/services/*oauth*`).
- Runtime may be generic over opaque `Ctx`; it must not interpret product context.
- Agent-loop must stay stateless: no persistence, sessions, WebSockets/SSE, compaction policy, or app context.
- Client should work for Next UI and Chrome extension by consuming protocol events from a server endpoint.

## Client Transport

- `streamAgentEventStream` = Effect `Stream` over NDJSON endpoint.
- `streamAgentEvents` = async generator compatibility wrapper for browser UI.
- `collectAgentEventsEffect` = Effect-native collection helper.
- `StreamAgentEventsRequest.signal` passes `AbortSignal` through to fetch/body reads.
- Keep parsing/schema errors typed as `AgentTransportError`.
