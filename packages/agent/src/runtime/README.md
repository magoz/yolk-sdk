# @yolk-sdk/agent/runtime

Generic session orchestration for `@yolk-sdk/agent/loop`.

## What it provides

- `runRuntime` for stateless transcript runs or append-backed durable runs.
- `SessionEventStore` service contract for append-only runtime session events.
- In-memory session event store layer for tests/simple hosts.
- Runtime-specific errors.

## Request modes

### `Transcript`

Use `Transcript` when the caller owns replay state. The caller passes a complete protocol transcript and runtime does not load or persist session state.

### `AppendInput`

Use `AppendInput` when the host wants durable runtime persistence. Runtime:

1. loads the prior `SessionEventStore` log,
2. replays protocol `AgentMessage` values from `InputAppended` and `RunCompleted`,
3. appends `InputAppended` and `RunStarted`,
4. runs the loop,
5. appends `RunCompleted` or `RunFailed`.

Hosts own physical storage, auth/tenancy, reconnect/fanout, and cleanup policy. Use numeric `expectedRevision` to reject stale writes. Use `latestIncompleteRuntimeRun` to decide when a host should append `RunInterrupted`.

## Use it when

- You need reusable lifecycle around the stateless loop.
- Your app owns storage and wants to inject it through an Effect service.

## Boundaries

- No database implementation.
- No HTTP/WebSocket routes.
- No app auth or tenancy logic.
