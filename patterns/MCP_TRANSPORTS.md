# MCP Transports

Patterns for MCP client/server transport boundaries.

## Scope

- `@yolk-sdk/mcp/client`: official full-core MCP client plus Effect/Yolk tool adapters; app owns config, credentials, and policy.
- `@yolk-sdk/mcp/server`: official full-core MCP server plus reusable Yolk tool-server primitives.
- `@yolk-sdk/mcp/core`: official MCP v2 wire schemas.
- No app auth implementation, credential storage, product permissions, or provider SDKs in MCP packages. Generic MCP resources, prompts, completions, MRTR, subscriptions, and OAuth protocol helpers are allowed through the official SDK surface.

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

## Protocol eras

- HTTP clients use `versionNegotiation: { mode: 'auto' }` when dual-era behavior is required.
- MCP `2026-07-28` requests are stateless and carry version, client identity, and capabilities per request.
- Modern HTTP requests carry `MCP-Protocol-Version`, `Mcp-Method`, and applicable `Mcp-Name` / `Mcp-Param-*` headers.
- Dual-era servers use `createMcpHandler`; modern stdio servers use `serveStdio`.
- Legacy `initialize` support remains available for `2025-11-25` and earlier peers.
- Modern results use `resultType`; cacheable operations preserve `ttlMs` and `cacheScope`.

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
