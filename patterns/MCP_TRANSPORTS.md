# MCP Transports

Patterns for MCP client/server transport boundaries.

## Scope

- `@yolk/mcp/client`: host-executed MCP client; app owns config, auth, and policy.
- `@yolk/mcp/server`: reusable tool-only JSON-RPC server primitives.
- No app auth, OAuth, resources, prompts, product permissions, or provider SDKs in MCP packages.

## JSON Boundaries

Decode wire JSON in two steps:

```typescript
const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)
const decodeJsonRpcMessage = Schema.decodeUnknownEffect(JsonRpcMessageSchema)

const decodeMessage = (line: string) => decodeJson(line).pipe(Effect.flatMap(decodeJsonRpcMessage))
```

Rules:

- Use `Schema.UnknownFromJsonString` for JSON encode/decode.
- Do not use raw `JSON.parse/stringify` in production MCP paths.
- Parse errors map to JSON-RPC `-32700`.
- Invalid JSON-RPC shape or params map to `-32600`.
- Tool failures map to safe protocol-shaped errors/results; never leak secrets.

## Stdio Boundaries

MCP stdio code uses Effect platform services:

```typescript
export const runStdioMcpServer = (server: McpToolServer) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio

    yield* stdio.stdin.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach(line => server.handleLine(line))
    )

    return yield* Effect.never
  })
```

Rules:

- Use `Stdio.Stdio`, `Stream`, and `@effect/platform-node` layers.
- Do not use raw `node:readline`, `node:child_process`, or direct `process.stdin/stdout/stderr` in package code.
- Node CLI/test boundaries provide `NodeStdio.layer` explicitly.
- Do not write internal errors to stderr; return JSON-RPC errors when possible.
- Local stdio child processes receive explicit env only and use `extendEnv: false`.
- Match stdio responses by JSON-RPC id; never assume response order.

## Error Model

Keep MCP errors typed and granular enough to map protocol codes:

```typescript
export class McpServerError extends Schema.TaggedErrorClass<McpServerError>()('McpServerError', {
  message: Schema.String,
  cause: Schema.Literals(['parse', 'validation', 'protocol', 'tool_error', 'encoding'])
}) {}
```

Rules:

- Prefer tagged errors over untyped exceptions.
- Preserve JSON-RPC id exactly in responses/errors.
- Unknown methods return `-32601`.
- Unknown tools return `-32602`.
- Internal encoding/tool failures return `-32000`.

## Testing

- Test transports below UI level.
- Remote: fake `HttpClient` layers.
- Local stdio: tiny fixture servers, with `NodeStdio.layer` at fixture boundary.
- Cover malformed JSON, invalid params, JSON-RPC error responses, non-2xx remote responses, local early exit, unknown methods/tools, and tool failures.
