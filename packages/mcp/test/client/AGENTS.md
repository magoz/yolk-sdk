# MCP Client Tests

Transport/protocol tests for remote HTTP and local stdio MCP clients.

## Rules

- Remote tests use fake `HttpClient` layers.
- Core local tests use fake `ChildProcessSpawner` where process behavior is not the subject.
- Real process tests may use tiny checked-in fixtures only.
- Test scripts may use `process` and Node APIs; production core must not use raw Node process APIs.
- Prefer local/remote-specific helpers in tests when config kind is known.

## Coverage

- Malformed JSON-RPC.
- JSON-RPC error responses.
- Non-2xx remote responses.
- Local stdio early exit and response id matching.
- Policy rejection.
- Duplicate generated tool names.
- Invalid params and tool failures.

## Anti-Patterns

- Real remote network calls.
- Env inheritance in local stdio tests unless explicitly testing rejection.
- Browser/UI tests for protocol transport behavior.
