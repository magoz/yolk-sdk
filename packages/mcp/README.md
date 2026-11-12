# @yolk-sdk/mcp

MCP v2 (`2026-07-28`) client/server/protocol APIs, Effect/Yolk adapters, and legacy compatibility.

The root export is intentionally empty. Import APIs from explicit subpaths.

## Tool schema admission

Yolk's `tools/list` adapter admits `inputSchema` as the object arm of
`@yolk-sdk/agent/protocol`'s `ToolJsonSchema`. This is plain finite JSON-data representation admission,
not JSON Schema meta-validation. Boolean roots fail in the typed `McpError` validation channel;
omitted schemas still default to `{ type: 'object', additionalProperties: true }`.
Tool arguments/results remain opaque until their execution/provider boundary.

## Install

```bash
pnpm add @yolk-sdk/mcp@canary @yolk-sdk/agent@canary effect@4.1.2
```

Running the experimental `@yolk-sdk/mcp/conformance` cases? Also add `@yolk-sdk/conformance@canary` (usually as a dev dependency); the examples import `@yolk-sdk/conformance/*` subpaths directly.

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.
Use the SDK's matching Effect version (`4.1.2`) in host code.
Published package metadata requires Node.js 22+; `client/node` and `server/node` are Node-only.

## Subpaths

| Subpath                     | Purpose                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `@yolk-sdk/mcp/client`      | Official full-core client plus Effect/Yolk list and call helpers       |
| `@yolk-sdk/mcp/client/node` | Official stdio client transport plus NodeServices convenience wrappers |
| `@yolk-sdk/mcp/conformance` | Experimental MCP conformance cases, target, seeds, and fixtures        |
| `@yolk-sdk/mcp/core`        | Official MCP v2 wire schemas                                           |
| `@yolk-sdk/mcp/protocol`    | Yolk JSON-RPC/MCP adapter helpers                                      |
| `@yolk-sdk/mcp/server`      | Official full-core server plus Yolk tool-only server primitives        |
| `@yolk-sdk/mcp/server/node` | Official dual-era stdio server entrypoint                              |

Use `core` for the official full MCP wire-schema surface. Use `protocol` only for Yolk adapters and
legacy JSON-RPC helpers; it is not a replacement for the full-core APIs.

Yolk JSON-RPC initialize and tools/call construction uses Schema owners on both
`@yolk-sdk/mcp/client` and `@yolk-sdk/mcp/protocol` (same `protocol.ts`; no new export subpath):

| Symbol                    | Role                                                                           |
| ------------------------- | ------------------------------------------------------------------------------ |
| `InitializeClientInfo`    | `{ name, version }`                                                            |
| `InitializeParams`        | `{ protocolVersion, capabilities, clientInfo }`                                |
| `InitializedNotification` | `{ jsonrpc: '2.0', method: 'notifications/initialized' }` (no `id` / `params`) |
| `ToolsCallParams`         | `{ name, arguments? }`                                                         |

Prefer those Schema owners for new construction. Compatibility constructors
`makeJsonRpcRequest`, `makeInitializeParams`, and `makeInitializedNotification` remain and build
through the schemas. `makeJsonRpcRequest` still omits `params` when `undefined`.

## Imports

```ts
import { Client } from '@yolk-sdk/mcp/client'
import { listLocalMcpServerToolsNode } from '@yolk-sdk/mcp/client/node'
import * as McpCore from '@yolk-sdk/mcp/core'
import { McpServer } from '@yolk-sdk/mcp/server'
import { serveStdio } from '@yolk-sdk/mcp/server/node'
```

## Use the full MCP v2 client

The official client surface supports tools, resources, prompts, completions, MRTR, response caching, subscriptions, OAuth helpers, and legacy negotiation.

```ts
import { Client, StreamableHTTPClientTransport } from '@yolk-sdk/mcp/client'

const client = new Client(
  { name: 'my-app', version: '1.0.0' },
  { versionNegotiation: { mode: 'auto' } }
)

await client.connect(new StreamableHTTPClientTransport(new URL('https://example.com/mcp')))

const { tools } = await client.listTools()
```

`mode: 'auto'` prefers stateless MCP `2026-07-28` and falls back to an initialize-based server. Pin `{ pin: '2026-07-28' }` for modern-only behavior. The upstream `Client` default remains legacy for compatibility.

## Use Effect/Yolk tool adapters

The high-level remote helpers use the official v2 client over an Effect `HttpClient` bridge. They negotiate modern MCP automatically, aggregate paginated tool lists, honor v2 routing headers and cache hints, and fall back to legacy servers. Discovered tools preserve provider `title`, `inputSchema`, `outputSchema`, and `annotations` metadata. Adapted tools are typed ([ADR 0013](https://github.com/magoz/yolk-sdk/blob/main/docs/adr/0013-typed-tool-results.md)): `ToolDef.outputSchema` is `{ value, files }` (`value` the server's `outputSchema`, unknown without one) and a successful call's `structuredContent` is `{ value, files }`: `value` is the server's `structuredContent` (checked against the listed `outputSchema`, remote and local), else the text of its text blocks and embedded text resources parsed once when it is one JSON object or array, else the text (`resource_link` blocks never enter it); blobs, images and audio become file fields (`FileRef`, or `FileUnavailable` without a file store). The model still sees the server's content, unchanged for results without file blocks. Registrations of adapted tools set `decodeOutput: mcpToolOutputDecoder` (`resolveTools` checks every result with it and fails `output_validation_required` without it). Files are stored when the call runs, through the `ToolFileCapture` `resolveTools` provides to its registrations; a call outside one (a HITL route calling `resumeRemoteMcpServerToolCall`, a direct `callLocalMcpServerTool`) passes `fileCapture: makeToolFileCapture({ store })` from `@yolk-sdk/agent/tools` on its input, or every file is `FileUnavailable` (`no file store`) and the blob is lost. Pass `exposure` in the options (a `ToolExposure` value or `(tool, serverName) => ToolExposure`) to set code mode `callableBy`/`discovery` on the adapted definitions; `mcpToolToToolDef` takes the same option.

```ts
import { Effect } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { listRemoteMcpServerTools } from '@yolk-sdk/mcp/client'

const tools = await Effect.runPromise(
  listRemoteMcpServerTools({
    name: 'docs',
    type: 'remote',
    url: 'https://example.com/mcp'
  }).pipe(Effect.provide(FetchHttpClient.layer))
)
```

Use `McpClientOptions.sdk` for official client options such as capabilities, MRTR, and shared response caching. Set `McpClientOptions.configureClient` to register elicitation or sampling handlers before connection. Use a persistent official `Client` directly for long-lived subscriptions and progress streams.

## Form elicitation for durable hosts (MRTR)

A server can pause a `tools/call` with an MCP `2026-07-28` `InputRequiredResult` (for example to
confirm a destructive tool with a form). A durable host cannot block on a person inside a tool
step, so Yolk returns the pause as data and resumes later, possibly in another process:

```ts
import { Effect } from 'effect'
import { makeToolFileCapture } from '@yolk-sdk/agent/tools'
import {
  callRemoteMcpServerToolResumable,
  resumeRemoteMcpServerToolCall,
  type McpClientOptions,
  type McpElicitationResponse,
  type McpElicitationResponses
} from '@yolk-sdk/mcp/client'

const options: McpClientOptions = { elicitation: { form: true } }

// A resume runs outside `resolveTools`: pass a capture (`makeToolFileCapture({ store })` from
// `@yolk-sdk/agent/tools`) or the resumed result's blobs are `FileUnavailable` and lost.
const call = {
  config,
  mcpToolName: 'delete-invoice',
  toolCallId: 'call_1',
  params,
  options,
  fileCapture: makeToolFileCapture({ store })
}

const step = Effect.gen(function* () {
  const outcome = yield* callRemoteMcpServerToolResumable(call)

  if (outcome._tag === 'Complete') return outcome.result

  // Integration fragment: persist outcome.inputRequired (a Schema class) and show its forms to a
  // person; resume later, possibly in another process, with their decisions, one per form keyed
  // by its `key`. This sketch declines every form (the safe default when nobody decides); never
  // auto-accept a confirmation.
  const decline: McpElicitationResponse = { action: 'decline' }
  const responses: McpElicitationResponses = Object.fromEntries(
    outcome.inputRequired.elicitations.map(form => [form.key, decline])
  )

  return yield* resumeRemoteMcpServerToolCall({
    ...call,
    inputRequired: outcome.inputRequired,
    responses
  })
})
```

- `elicitation: { form: true }` is the opt-in. Only then do the listing and the resumable call
  functions declare `elicitation.form`, in the per-request `_meta` client capabilities of a modern
  connection. Nothing declares it in a legacy `initialize`, and `callRemoteMcpServerTool` (which
  cannot represent a pause) never declares it.
- The outcome is `Complete` (a `ToolResult`) or `InputRequired` (`McpInputRequired`: Schema-decoded
  form elicitations with `key`, `message` and `requestedSchema`, the opaque `requestState`, the
  binding `mcpToolName` and `argumentsDigest`, and the listed tool definition `tool`).
- The bound is 256 KiB of JSON by default (`elicitation.maxInputRequiredBytes`, a positive
  integer, checked before connecting) plus 16 requests, applied to two parts separately. The
  server-provided pause (the `InputRequiredResult` and the decoded pause without its tool
  definition) is checked after the response body is buffered, so it bounds what is decoded and
  persisted, not what is received. The listed tool definition is checked before the call: a tool
  whose definition alone exceeds the bound fails `too_large` with nothing sent, so a pause the
  server already made is never lost to the bound. A persisted pause is at most about twice the
  bound.
- The resume is re-sent as a new request on a new connection with the same tool call (checked
  against the pause's binding), the exact `requestState`, and the decisions (`accept` with
  `content`, `decline`, `cancel`) as `inputResponses`. It lists nothing: it calls with the pause's
  tool definition (for `x-mcp-header` mirroring) and checks the result against its `outputSchema`.
  A carried definition that is not a valid MCP tool fails `malformed` before sending. Because the
  definition is passed as `toolDefinition`, the official client does not re-list and retry after a
  `HEADER_MISMATCH` (`-32020`): a server that changed the tool's `x-mcp-header` declarations since
  the pause answers `McpError` (`cause: 'protocol'`). Decisions are checked before anything is sent
  (type (integer vs number), `required`, `const`, `enum`, titled `oneOf`, `minLength`/`maxLength`, `format` (email, uri, date, date-time), `minimum`/`maximum`, `items.enum`, titled `items.anyOf`, `minItems`/`maxItems`); the server validates them again. The server may pause again.
- The carried definition is `name`, `inputSchema` and `outputSchema`: the only `toolDefinition`
  fields the pinned official client reads. `annotations`, `_meta` and `execution` (task support,
  which its `2026-07-28` codec removes from listings) are not carried.
- The pause is decoded from the raw `input_required` response as the server sent it: the response
  the official client resolves the call with (the first whose id matches under the client's own
  `Number(id)` coercion), captured at the transport before the client normalises it (it would drop
  a non-string `requestState` and turn non-object `inputRequests` into `{}`). Such a response, or a
  matched one whose id is not identical to the call's (`"1"` for `1`), fails `malformed`; other
  ids, notifications and later duplicates are ignored.
- Formats are syntax checks, all linear: `date`/`date-time` per RFC 3339 on the proleptic
  Gregorian calendar (years 0000-9999; second `60` only at `23:59:60` UTC after the offset); `uri`
  an absolute RFC 3986 URI (scheme, then unreserved, sub-delims and the delimiters, other characters
  percent-encoded; IP literals per the `IPv6address` grammar or `IPvFuture`; no WHATWG
  normalisation);
  `email` a pragmatic mailbox: a dot-atom local part (RFC 5322 `atext` runs joined by single dots,
  at most 64 characters; no quoted strings), `@`, and a hostname of at least two LDH labels.
- Typed failures: `McpInputRequiredError` (`malformed`, `too_large`, `unsupported_request` for URL
  mode, sampling, roots or input without the opt-in, `invalid_responses`, `mismatched_resume`,
  `unsupported_era`) and `McpClientCapabilityRequiredError` for MCP `-32021`.
- Legacy-era elicitation (a server-initiated request answered while the call's stream is open) is
  not supported; resuming against a legacy connection fails with `unsupported_era`.

### Files in tool results

A successful call's `structuredContent` is `{ value, files }`
([ADR 0013](https://github.com/magoz/yolk-sdk/blob/main/docs/adr/0013-typed-tool-results.md)):
embedded text resources go into `value` with the text blocks, and blobs, images and audio become
`files`, each a `FileRef` `{ fileId, name, mimeType, size }` (blob names come from the URI) or a
`FileUnavailable` `{ unavailable, name, mimeType }`. The model sees blob resources as file labels
(never base64) and images and audio as the server sent them, followed by their label once stored.

Files are stored while the call runs. Inside a `resolveTools` registration they go to the
resolution's `files` store. A call made anywhere else (a HITL route resuming
`resumeRemoteMcpServerToolCall`, a direct `callRemoteMcpServerTool` or `callLocalMcpServerTool`)
passes `fileCapture: makeToolFileCapture({ store })` (`@yolk-sdk/agent/tools`); without it every
file is `FileUnavailable` (`no file store`), and the blob cannot be fetched again later. See
[Move files between tools](https://github.com/magoz/yolk-sdk/blob/main/apps/docs/content/docs/integrations/files.mdx).

When adapting Yolk tools into an MCP server (`makeMcpToolServer`), an inline `FilePart` leaves as
an embedded resource blob and a stored (or omitted) one as its label.

## Connect to a local stdio server

Node hosts can use the convenience wrappers from `client/node`:

```ts
import { Effect } from 'effect'
import { listLocalMcpServerToolsNode } from '@yolk-sdk/mcp/client/node'

const tools = await Effect.runPromise(
  listLocalMcpServerToolsNode(
    {
      name: 'local-tools',
      type: 'local',
      command: [process.execPath, './mcp-server.mjs'],
      environment: {}
    },
    { securityPolicy: { allowLocalServers: true, allowDevHttpLocalhost: false } }
  )
)
```

Local servers are disabled by default. The host must explicitly allow them, choose a trusted
command, and provide the complete child environment; configured environment values do not extend
the host environment.

## Build a full MCP server

Use the official server surface for tools, resources, prompts, completions, MRTR, and subscriptions:

```ts
import { McpServer, createMcpHandler } from '@yolk-sdk/mcp/server'

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'my-server', version: '1.0.0' })
  // Register tools, resources, and prompts here.
  return server
})

export default { fetch: handler.fetch }
```

`createMcpHandler` serves stateless `2026-07-28` and legacy initialize-based HTTP clients from one endpoint. Validate `Origin` and `Host` before calling `handler.fetch`.

For dual-era Node stdio, import `serveStdio` from `@yolk-sdk/mcp/server/node`. This subpath owns the
Node stdio transport only; the host owns authorization, process lifecycle, logging, and deployment
policy.

## Adapt Yolk tools into MCP

```ts
import { makeMcpToolServer, runStdioMcpServer } from '@yolk-sdk/mcp/server'
```

`makeMcpToolServer` exposes approved Yolk tools. Its HTTP handler accepts both stateless v2 and legacy requests, validates browser origins against the endpoint hostname by default, and preserves MCP content and structured results. No tool call outlives `handleHttpRequest` (an SSE answer is read to its end, and a read failure answers 500 with `-32603`; a call still running is interrupted and awaited), so its requirements may come from a scoped request layer; a cancelled request that carries `MCP-Protocol-Version` interrupts the tool. `subscriptions/listen` answers its acknowledgement plus a `complete` result: this tool-only server has no change notifications. A request with `MCP-Protocol-Version` (either era) whose body is over `maxRequestBodySize` (default the SDK's 4 MiB) is answered `413`: a host that caps bodies itself passes its own cap, and an unusable value (not a positive finite number) answers 500 naming it. The header-less JSON path reads the body unbounded, so the host caps it. `runStdioMcpServer` remains the Effect-native minimal stdio adapter; use `serveStdio` for the full modern stdio surface.

For legacy HTTP requests, an unreadable or already consumed body produces a JSON-RPC
invalid-request error (`-32600`) rather than an Effect defect. Malformed JSON remains a parse error
(`-32700`).

A tool may carry `annotations` (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`), listed as the MCP tool annotations.

### Ask the user before a tool runs

An approval tool (`McpServerApprovalTool`) runs only after the user accepts the call through MCP
form elicitation over multi round-trip requests (`2026-07-28`). Give the server `approvals`:

```ts
import { Effect } from 'effect'
import { ToolDef, ToolResult } from '@yolk-sdk/agent/protocol'
import { makeMcpToolServer, type McpServerTool } from '@yolk-sdk/mcp/server'

declare const signingKey: string // at least 32 bytes, the same on every instance
declare const tokenId: string // the authenticated principal of this request

const send: McpServerTool = {
  def: ToolDef.make({
    name: 'send',
    description: 'Send a message',
    parameters: { type: 'object' }
  }),
  annotations: { destructiveHint: false },
  approval: { message: call => Effect.succeed(`Send ${JSON.stringify(call.params)}?`) },
  execute: (call, approved) =>
    // Run the call at most once per `approved.approvalId`.
    Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'sent' }))
}

const server = makeMcpToolServer({
  name: 'my-server',
  version: '1.0.0',
  tools: [send],
  approvals: { key: signingKey, principal: tokenId }
})
```

- The first call answers an `input_required` result: one form elicitation under
  `approvalInputKey` (`'approval'`, one required choice, `approvalForm`: approve or deny) with
  the policy's `message`, and a `requestState` signed by the SDK's `createRequestStateCodec`
  (HMAC-SHA256, `ttlSeconds` default 600) and bound to `principal` and `tools/call`. Its payload
  names the tool, the digest of the arguments (`mcpArgumentsDigest`), the digest of the prompt
  (message and form) and a fresh `elicitationId`, which `execute` receives as `approvalId`.
- Only a retry that answers `accept` with a state that verifies for the same principal, tool,
  arguments and prompt runs the tool, with `{ approvalId }`. The prompt is built again on that
  retry: if the message changed since the user saw it, the call answers `changedPromptMessage` and
  nothing runs. So build the message deterministically from the call and current data (no clocks
  or random ids), or every accept is refused. A deny choice, a decline or a cancel answers an error
  result. The form is never empty: some clients accept an empty form without showing it, so an
  accept without the choice is no approval and asks again.
  A state that fails verification, belongs to another call, or arrives without a decision asks
  again with a new state.
- Build the server per request: `principal` is fixed when it is built. The state is also bound to
  the server's `name`.
- The server keeps no state, so an accepted retry replays until the state expires: key once-only
  execution on `approvalId`.
- A direct tool refuses a call that answers an approval prompt (a `requestState` or an answer under
  `approvalInputKey`, `staleApprovalMessage`): when the host's policy turned an approval tool into a
  direct one between the prompt and the answer, neither a decline nor a replayed accept becomes a
  plain call.
- A request that does not declare form elicitation gets an error result and nothing runs.
  Approval tools are not offered on 2025-era requests (stateless serving cannot route the
  client's answer back to the open call) or on the header-less JSON path, and not at all without
  `approvals`. Unusable `approvals` (a key under 32 bytes, an empty `principal`, a `ttlSeconds`
  that is not a positive integer) leave them listed but answering an error result that names the
  problem.
- A prompt larger than `mcpServerMaxPromptBytes` (64 KiB of message plus form JSON) answers
  `oversizedPromptMessage`: it is refused, never cut.

### Ask the user a form

An elicited tool asks a form before it runs: yes/no (`mcpFormBoolean`), one choice
(`mcpFormChoice`) or several choices (`mcpFormMultiSelect`), every field required. An approval tool
is the same tool with one required approve/deny choice. A form without fields is never asked
(it lists a problem): a client may accept an empty form without showing it. `execute` gets the answer decoded with the form's schema; an
answer that does not fit (a value not offered, a duplicate, an empty or too long selection, a
missing field) asks again and runs nothing. The types accept only fields and forms from these
builders and elicited tools from `makeMcpServerElicitedTool`, so every answer is decoded before
`execute`.

```ts
import { Effect } from 'effect'
import { ToolDef, ToolResult } from '@yolk-sdk/agent/protocol'
import {
  makeMcpServerElicitedTool,
  mcpFormBoolean,
  mcpFormMultiSelect,
  mcpServerForm
} from '@yolk-sdk/mcp/server'

const apply = makeMcpServerElicitedTool({
  def: ToolDef.make({ name: 'apply', description: 'Apply a plan', parameters: { type: 'object' } }),
  elicit: () =>
    Effect.succeed({
      message: 'Apply which steps?',
      form: mcpServerForm({
        steps: mcpFormMultiSelect({
          title: 'Steps',
          options: [
            { value: 's1', title: 'Post "Ship it"' },
            { value: 's2', title: 'Delete the draft' }
          ],
          default: ['s1', 's2']
        }),
        notify: mcpFormBoolean({ title: 'Notify the channel', default: false })
      })
    }),
  execute: (call, answered) =>
    // `answered.answer` is `{ steps: ReadonlyArray<'s1' | 's2'>, notify: boolean }`; run at
    // most once per `answered.elicitationId`.
    Effect.succeed(
      ToolResult.make({ toolCallId: call.id, content: answered.answer.steps.join(',') })
    )
})
```

- `elicit` runs on every round, a decline's and a cancel's included, so build the prompt
  deterministically from the call and current data (no clocks or random ids): when it changed
  between the question and the answer (a plan item edited meanwhile), the accept answers
  `changedPromptMessage` and nothing runs.
- A multi-select needs at least one value; `maxItems` (an integer from 1 to the number of options)
  caps it.
- A form that cannot be shown faithfully (repeated option values, a default that is not an option
  or not itself a fitting answer, a `maxItems` out of range, a field named `__proto__`) lists why
  in `form.problems`; the tool then answers an error result naming them and asks nothing. Options
  often come from data, so check `problems` when building forms from it.
- A `default` only preselects in the client: a missing field is never filled from it.
- Everything else (signing, binding, era and capability rules, once-only on `elicitationId`) is as
  for approval tools above.

## Conformance cases (experimental)

`@yolk-sdk/mcp/conformance` holds nine `read` conformance cases for `@yolk-sdk/conformance/runner`,
plus one opt-in `read` case, `mcpElicitationDeclarationCase` (fixtures:
`mcpConformanceElicitationFixtures`), for hosts that set `McpClientOptions.elicitation`; it only
lists, so it never triggers a confirmation.
They check the wire claims the remote client relies on: era negotiation, the modern stateless
headers, the legacy session, response encoding, the tool listing, a read call, a tool error, an
unknown tool, and a rejected credential. Every case runs the real `listRemoteMcpServerTools` and
`callRemoteMcpServerTool` through an observing `HttpClient`. The observer never sends a request of
its own (it may refuse to forward one, see below). It never keeps `authorization` or any other
credential-named header, never keeps the URL query, and never keeps a raw `mcp-session-id` value
(only evidence: an equality class such as `session#1`). It keeps request and response bodies
exactly as received; they may reflect anything a server echoes, credentials and session ids
included, so they are sensitive: in memory only, never logged or persisted. Persisted or printed
output is the live runner's job.

A case that calls a tool (`mcp.modern.stateless`, `mcp.errors.unknown-tool`,
`mcp.tools.call-read`, `mcp.tools.call-tool-error`) is protected by the observer's fail-closed call
gate. The `tools/call` is forwarded only when every exchange of the call operation is fully
understood, that operation's own listing (made right before the call) is complete, and that
listing proves the call safe: the absent tool is not listed, or the read tool is marked
`readOnlyHint: true`. Anything else, including any uncertainty (a 202 answer to a request, a
message delivered on a GET, an unparseable body, an unterminated stream, two responses for one id,
an unknown shape), refuses to forward. A refusal before any forwarded call fails the precondition
with zero forwarded calls; a refused client retry after a forwarded call is reported as a retry.
Earlier preflight listings stay as friendly early failures. Answers are read as the SDK reads them:
JSON with `JSON.parse` semantics, and event streams with the SDK's own parser
(the same `eventsource-parser` the client resolves, verified in-repo by a parity test; a consumer
install whose package manager does not dedupe could still resolve two copies), fed the decoder
chunks the client's `TextDecoderStream` emits.

Mismatch messages carry only structural facts (methods, statuses, counts, positions, codes), never
body text or the target URL. A client failure a case re-raises is reported as the client words it
(it can quote a server body) and is sanitized by the runner. A host provides an `HttpClient`, an
`McpConformanceTarget` (server URL, headers, era, protocol version, timeout), and
`McpConformanceConfig` seeds. The cases name no product: provider targets and seeds live with the
provider. `selectMcpConformanceCases` leaves out the cases of the other era. The synthetic fixtures
replay on `https://mcp.example.test/modern/mcp` and `https://mcp.example.test/legacy/mcp`. See the
conformance API reference for every claim.

```ts
import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { runConformance } from '@yolk-sdk/conformance/runner'
import {
  McpConformanceConfig,
  McpConformanceTarget,
  mcpConformanceCases,
  selectMcpConformanceCases
} from '@yolk-sdk/mcp/conformance'

const target = {
  name: 'docs',
  url: 'https://example.com/mcp',
  headers: {},
  era: 'modern',
  protocolVersion: '2026-07-28',
  timeoutMs: 30_000
} as const

const { applicable } = selectMcpConformanceCases(mcpConformanceCases, target.era)

const report = await Effect.runPromise(
  runConformance(applicable, {
    target: { kind: 'live', account: 'practice' },
    layer: () =>
      Layer.mergeAll(
        FetchHttpClient.layer,
        Layer.succeed(McpConformanceTarget, target),
        Layer.succeed(McpConformanceConfig, {})
      )
  })
)
```

No case is observed live yet. Only code under `src/conformance/` may import `@yolk-sdk/conformance`.

## Host responsibilities

- Own persisted server config, credentials, authorization policy, and enabled capabilities.
- Partition private MCP caches by authorization context.
- Validate HTTP `Origin` and `Host` at deployment boundaries.
- Keep Node stdio usage behind trusted Node hosts and explicitly control child commands and environments.
- Treat tool annotations, server identity, icons, and request state as untrusted input.

Remote MCP requires HTTPS by default; localhost HTTP is an explicit development policy.

## Boundaries

- MCP is external protocol infrastructure, not agent-loop or provider policy.
- `core`, `client`, and `server` expose protocol mechanics; Yolk adapters bridge generic tool and
  content contracts only.
- App auth, credential storage, persisted server config, and product catalogs remain host-owned.
- Node process and stdio conveniences stay behind `client/node` and `server/node`.
