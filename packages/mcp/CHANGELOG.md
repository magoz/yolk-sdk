# @yolk-sdk/mcp

## 0.1.0-canary.99

### Patch Changes

- ee80a4a: Advance unchanged public packages in lockstep with the durable tool-call ledger in `@yolk-sdk/agent` and `@yolk-sdk/codemode`, the at-least-once tool step guidance in `@yolk-sdk/vercel-workflows`, and the README updates in `@yolk-sdk/extractors`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [ee80a4a]
- Updated dependencies [c248eb0]
  - @yolk-sdk/conformance@0.1.0-canary.99
  - @yolk-sdk/agent@0.1.0-canary.99

## 0.1.0-canary.98

### Patch Changes

- def9f9c: Advance unchanged public packages in lockstep with the new `@yolk-sdk/extractors` package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [def9f9c]
  - @yolk-sdk/agent@0.1.0-canary.98
  - @yolk-sdk/conformance@0.1.0-canary.98

## 0.1.0-canary.97

### Minor Changes

- b5c2b69: Upgrade the coordinated Effect runtime and platform dependencies to the stable Effect 4.0.0 release. Hosts must use the matching Effect version.

  Effect 4.0.0 removes the `effect/unstable/*` entrypoints: import from `effect/http`, `effect/socket`, `effect/sql`, `effect/process` and the other `effect/<area>` paths, and take `Arbitrary` from `effect`. The former `effect/Encoding` module is split into `effect/encoding/*` (for example `Base64.encode` from `effect/encoding/Base64`).

  Effect 4.0.0 exports `Schema.isPattern` to JSON Schema only when the regex flags are `u` (optionally with `d`, `g` or `y`; not `v`, and not `u` with `i`, `m` or `s`). Yolk's connector, emulator and conformance patterns now use `u`, so connector tool parameters keep their model-visible `pattern` hints with unchanged runtime validation; the Fortnox identifier pattern is advertised as its equivalent BMP-only character class. Add `u` to `Schema.isPattern` regexes in host tool parameter schemas to keep their patterns. String `Schema.isMinLength(n)` and the `Schema.isBetweenLength` minimum (n ≥ 2) are now advertised as `minLength: ceil(n / 2)`. See the migration guide.

### Patch Changes

- Updated dependencies [6567cc9]
- Updated dependencies [b5c2b69]
- Updated dependencies [4f24fe8]
  - @yolk-sdk/conformance@0.1.0-canary.97
  - @yolk-sdk/agent@0.1.0-canary.97

## 0.1.0-canary.96

### Patch Changes

- 367aceb: Add the code mode tool contract (ADR 0002, step 1) without adding code mode itself.

  - Output schemas: `makeTool({ output })` lowers an Effect Schema into declaration-only
    `ToolDef.outputSchema` the same way as `parameters`. Connector tool registrations pass the action
    `outputSchema` through, and `mcpToolToToolDef` passes a plain-object MCP `outputSchema` through.
    Output schemas are never sent to providers and never validate results.
  - Exposure: `ToolDef.callableBy` (`all` default, `model`, `codemode`) and, for `codemode` only,
    `discovery` (`listed` default, `search`), typed on `makeTool` options as the `ToolExposure`
    union. Protocol helpers `isCodeModeCallable`, `isCodeModeFailClosed`, `providerToolDefs`,
    `isProviderToolDef`, and `toolDiscovery` implement the rules. Approval, input, interaction,
    activated background, `question`, and `subagent` tools never run from code mode; `resolveTools`
    fails `codemode_unsupported_tool` when they are marked `codemode` and `invalid_tool_exposure` for
    `discovery` without `codemode`, and warns when codemode-only tools have no nested-access tool.
  - Exposure for generated tools: `makeConnectorToolRegistration` and `makeConnectorToolModule`
    accept `exposure`, a `ToolExposure` value or a resolver `(actionId, action) => ToolExposure`
    (`ConnectorToolExposureResolver`; `action` is the declared `id`/`description`/`access`, or
    `undefined` for an undeclared action id). `mcpToolToToolDef` and the MCP listing functions
    (`McpClientOptions.exposure`) accept the same option as `McpToolExposureResolver`, a value or
    `(tool, serverName) => ToolExposure`. Without it neither adapter sets `callableBy`/`discovery`;
    the fail-closed rules above still apply at resolution.
  - Codemode-only tools never reach providers: `run`, `runModelTurn`, capability checks, and the
    OpenAI Realtime session builders omit them. Provider-issued calls to them fail closed as unknown
    tools (`prepareToolBatch` synthetic error result, `ResolvedToolSet.execute` `not_found`, voice
    denial) without dispatch.
  - Nested tool access: registrations with `nestedToolAccess: true` receive a `nested`
    `NestedToolExecutor` scoped to the same resolution and host context. Its `tools` list the
    code-mode-callable tools (excluding nested-access registrations) with their module ids; its
    `execute` runs through the resolved execute path and returns model-visible error results for
    unknown, disabled, or non-callable tools and tool failures. Nested call ids follow
    `<parentToolCallId>/<seq>`. Decorators outside `ResolvedToolSet.execute` (for example a wrapped
    `ToolExecutor`) do not see nested calls.
  - Module descriptions: `ToolModule` accepts an optional `description`, carried on `NestedTool` as
    `moduleDescription` for code mode listing and search.
  - Nested-call record: optional `ToolResult.nestedCalls` (`NestedToolCalls`) and summed
    `ToolResult.usage`, built with `recordNestedToolCall` / `nestedToolCallResultFields` within
    exported bounds (256 calls, 8 KiB arguments per call, 32 KiB in total, 500-character errors).
    They round-trip as plain JSON and are dropped by `toolResultMessageFromResult`, so transcripts
    and providers never see them.

- adaf663: Add the experimental `@yolk-sdk/mcp/conformance` subpath: nine `read` conformance cases for MCP servers, run through the real `@yolk-sdk/mcp/client`. They cover era negotiation (`mcp.negotiation.era`), modern stateless headers (`mcp.modern.stateless`), the legacy session handshake (`mcp.legacy.session`), JSON and SSE answer encoding (`mcp.transport.response-encoding`), the tool listing with capabilities, cursors and unchanged metadata (`mcp.tools.list`), a read call (`mcp.tools.call-read`), a tool error for invalid arguments (`mcp.tools.call-tool-error`), an unknown tool (`mcp.errors.unknown-tool`), and a rejected credential (`mcp.auth.rejected`). The subpath also exports the `McpConformanceTarget` and `McpConformanceConfig` services, an observing `HttpClient` that never sends a request of its own and forwards a case's `tools/call` only through a fail-closed gate (only when the call operation's own complete, fully understood listing proves the call safe: the absent tool not listed, or the read tool marked `readOnlyHint: true`; anything else refuses; event streams are read with the same `eventsource-parser` the client resolves, now a direct dependency with the client's `^3.0.0` range (verified in-repo by a parity test; a consumer install that does not dedupe could resolve two copies)), never keeps a credential-named header, the URL query or a raw `mcp-session-id` value (only an equality class), and keeps request and response bodies exactly as received (sensitive: in memory only, never logged or persisted), the era filter `selectMcpConformanceCases`, and sixteen synthetic replay fixtures on `https://mcp.example.test/{modern,legacy}/mcp`. No case is observed live yet. `@yolk-sdk/mcp` now depends on `@yolk-sdk/conformance`, which only `src/conformance/` may import.
- Updated dependencies [367aceb]
- Updated dependencies [367aceb]
- Updated dependencies [367aceb]
- Updated dependencies [0ce9c3e]
- Updated dependencies [575a282]
- Updated dependencies [a4ba6db]
- Updated dependencies [00904fd]
- Updated dependencies [425c172]
- Updated dependencies [9f7aba3]
- Updated dependencies [ccc64a3]
- Updated dependencies [6d3b497]
- Updated dependencies [9ff96b8]
- Updated dependencies [0c58a89]
- Updated dependencies [92f016f]
  - @yolk-sdk/agent@0.1.0-canary.96
  - @yolk-sdk/conformance@0.1.0-canary.96

## 0.1.0-canary.95

### Patch Changes

- 8d919b4: Advance unchanged public packages in lockstep with Gmail multipart sending and host-only Outlook draft attachment uploads in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [8d919b4]
  - @yolk-sdk/agent@0.1.0-canary.95

## 0.1.0-canary.94

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.94

## 0.1.0-canary.93

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.93

## 0.1.0-canary.92

### Patch Changes

- 7bc4f70: Advance unchanged public packages in lockstep with the new GitHub connector at `@yolk-sdk/connectors/github`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [7bc4f70]
  - @yolk-sdk/agent@0.1.0-canary.92

## 0.1.0-canary.91

### Patch Changes

- bd61ed3: Advance unchanged public packages in lockstep with OpenAI-compatible tool-result attachment lowering and connector email Sent-copy plus OneDrive move and copy actions. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [b9c5610]
  - @yolk-sdk/agent@0.1.0-canary.91

## 0.1.0-canary.90

### Patch Changes

- 76d6c5c: Advance unchanged public packages in lockstep with native PDF attachment lowering in the agent package and Fortnox customer and invoice writes in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [6c7efcb]
  - @yolk-sdk/agent@0.1.0-canary.90

## 0.1.0-canary.89

### Patch Changes

- 7eab996: Advance unchanged public packages in lockstep with the host-neutral background subagent guidance in the agent package and the Dropbox create-folder response fix in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [4188847]
  - @yolk-sdk/agent@0.1.0-canary.89

## 0.1.0-canary.88

### Patch Changes

- 879f27b: Advance unchanged public packages in lockstep with the portable email batch, filter, and permanent-deletion primitives in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [879f27b]
  - @yolk-sdk/agent@0.1.0-canary.88

## 0.1.0-canary.87

### Patch Changes

- 30f73f0: Advance unchanged public packages in lockstep with the reviewed-email submission primitives in the connectors package. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [30f73f0]
  - @yolk-sdk/agent@0.1.0-canary.87

## 0.1.0-canary.86

### Patch Changes

- c8d74d8: Advance unchanged public packages in lockstep with action-backed interactions in the agent and harness packages. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [275d402]
  - @yolk-sdk/agent@0.1.0-canary.86

## 0.1.0-canary.85

### Patch Changes

- 979db9e: Advance unchanged public packages in lockstep with the generic-email label, flag, move, and header additions. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [979db9e]
  - @yolk-sdk/agent@0.1.0-canary.85

## 0.1.0-canary.84

### Patch Changes

- Advance unchanged public packages in lockstep with the agent's normalized reasoning parsing fix for OpenAI-compatible chat completions. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [a627921]
  - @yolk-sdk/agent@0.1.0-canary.84

## 0.1.0-canary.83

### Patch Changes

- Advance unchanged public packages in lockstep with the agent's Vercel AI Gateway DeepSeek thinking-parameter fix. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [245e0b0]
  - @yolk-sdk/agent@0.1.0-canary.83

## 0.1.0-canary.82

### Patch Changes

- 0561764: Advance unchanged public packages in lockstep with typed input interactions and Vercel AI Gateway streaming/reasoning options. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [16fa58c]
- Updated dependencies [79a074a]
  - @yolk-sdk/agent@0.1.0-canary.82

## 0.1.0-canary.81

### Patch Changes

- 0fae398: Advance the unchanged public packages in lockstep with the agent chat-stream diagnostics and Microsoft Outlook connector fixes. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [9f85933]
  - @yolk-sdk/agent@0.1.0-canary.81

## 0.1.0-canary.80

### Patch Changes

- Updated dependencies [82c3cad]
- Updated dependencies [df007e7]
- Updated dependencies [b3acb64]
  - @yolk-sdk/agent@0.1.0-canary.80

## 0.1.0-canary.79

### Patch Changes

- 3c243ee: Align all public SDK packages for the Go Responses replay fix and the branded-identity TypeScript migration. MCP and Vercel Workflows have no direct API or runtime changes in this release; they advance with the fixed SDK package group.
- Updated dependencies [3c243ee]
- Updated dependencies [2ab26c7]
  - @yolk-sdk/agent@0.1.0-canary.79

## 0.1.0-canary.78

### Minor Changes

- 5ff44d6: Upgrade the coordinated Effect runtime and platform dependencies to 4.0.0-rc.115. Hosts must use the matching Effect version.

  Adopt rc.115 schema-order construction, including `_tag` first: JSON field values and optional presence remain unchanged, but serialized property order can change. Schema errors now use the rc.115 native Error/SchemaIssue representation. Preserve strict Calendar boundary validation, closed empty tool schemas, portable custom JSON Schema output, and explicit WebSocket close semantics.

  Contributor property tests use native Effect arbitraries and Vitest 5. See the migration guide for API replacements and JSON Schema definition-name changes.

- 5ff44d6: `WebRtcPeerConnectionLike.addTrack` on `@yolk-sdk/agent/voice/browser` is a void command (was unused `unknown`). Hosts and fakes must not read a sender. Real `RTCPeerConnection.addTrack` remains assignable. No export-map change.

  Voice raw-argument JSON on `@yolk-sdk/agent/voice`: `protocolToolCallFromVoice` and `decideVoiceToolCall` admit finite JSON. Actual `null` / `false` / `0` still admit as those values. Raw text `1e999` uses the existing malformed fallbacks instead of publishing `Infinity` (projection params `'1e999'`; approval display `{ argumentsJson: '1e999' }`). Nested overflow takes the same fallbacks. Do not demonstrate with `JSON.stringify(Infinity)` (that is `null`). Execution schema validation and approval identifiers/gates are unchanged.

  `@yolk-sdk/mcp/client` and `@yolk-sdk/mcp/protocol` export Schema owners `InitializeClientInfo`, `InitializeParams`, `InitializedNotification`, and `ToolsCallParams`. Prefer Schema owners for new construction. Compatibility `makeJsonRpcRequest`, `makeInitializeParams`, and `makeInitializedNotification` remain and omit `params` when `undefined`. No new export subpath.

### Patch Changes

- 5ff44d6: Keep each Workflow tool-batch HITL response array independent from the loop's accumulator, preserving response order and element identity. Normalize custom React chat transport rejections through the existing transport error owner, retaining their underlying cause and recognizing aborts.

  Return a JSON-RPC invalid-request response when a legacy MCP HTTP request body cannot be read. Precisely narrow missing-sandbox SDK errors to HTTP 404/410 without assuming an object-shaped error payload or discarding other API errors.

- 5ff44d6: `ToolDef.parameters` admits a JSON Schema **representation** at construction: boolean schema or plain JSON object (unknown annotation keywords allowed as JSON). This is not meta-schema validation and is not `Schema.Json` for tool call params, results, or HITL — those stay opaque.

  Admission is identity-preserving (not a Record snapshot): enumerable data-only own string keys, including own `__proto__`/`constructor`, dense `Array.prototype` arrays, primitives, null-prototype objects, and DAG aliases. Accessors are rejected from property descriptors and are not invoked. Cycles, nonfinite numbers, functions, `undefined` values, Date/Map/class/custom prototypes, and sparse arrays fail before a tool runs. Effect/Result decoding reports `SchemaError`; synchronous `ToolDef.make` and `makeTool`'s generated-document admission throw the installed Effect constructor's `Error` shape with a `SchemaIssue` cause. Proxy traps on `ownKeys`/`getOwnPropertyDescriptor` are not claimed immune.

  Background activation wraps boolean `true`/`false` parameter documents as `arguments` schemas (not `{}`). Unsupported `$ref`/resource keywords still fail only at activation.

  MCP `tools/list` `inputSchema` admits the object arm at decode (`McpError` `validation`). Boolean MCP input schemas are rejected there. Omitted MCP input schemas still default to `{ type: 'object', additionalProperties: true }`.

- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [00e4d60]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
- Updated dependencies [5ff44d6]
  - @yolk-sdk/agent@0.1.0-canary.78

## 0.1.0-canary.77

### Patch Changes

- 6b9c60b: Release all seven public packages together.

  This canary introduces `@yolk-sdk/harness` run lifecycle and related agent loop composition, collection, Codex missing-final-output, and overflow-after-output changes. `@yolk-sdk/connectors`, `@yolk-sdk/knowledge`, `@yolk-sdk/mcp`, `@yolk-sdk/sandbox`, and `@yolk-sdk/vercel-workflows` are unchanged except for lockstep compatibility.

- Updated dependencies [978ea8f]
- Updated dependencies [978ea8f]
- Updated dependencies [7827908]
- Updated dependencies [6b9c60b]
  - @yolk-sdk/agent@0.1.0-canary.77

## 0.1.0-canary.76

### Patch Changes

- 8f5ea35: Add host-only retrieval for Google Drive download/export, Gmail, Outlook, IMAP/POP3, Notion, Telegram, Todoist attachments, Fortnox preview/archive, and R2 gets, plus bounded Dropbox/OneDrive writes and conditional R2 puts. Preserve GET-only binary adapters, base64 attachment actions, and R2 presigning. OneDrive update requires acknowledgeOverwrite and is unconditional, not CAS; Dropbox revision and R2 ETag preconditions stay strict. Add Fortnox list_supplier_invoice_files and Todoist list_comments read actions. Drive bytes default to drive.file with host-only drive.readonly opt-in; Fortnox archive/connectfile slots are opt-in and not added to the combined hint. No generic agent byte actions or app wiring.
- 34b4275: Add a host-only Dropbox original-byte download helper, `downloadDropboxFile`, on `@yolk-sdk/connectors/dropbox`. It mirrors the host-only OneDrive original-byte helper, but Dropbox never follows content redirects. It reuses the existing `dropbox.oauth` binding through a new `files.content.read` scope and `DropboxContentReadOAuthCredentialSlot` (now also included in `DropboxCombinedOAuthCredentialSlot`), calls the Dropbox content endpoint once through the optional bounded binary HTTP port, returns allowlisted `Dropbox-API-Result` metadata plus untouched bytes, and sanitizes failures to typed codes. Default Dropbox actions and agent serialization are unchanged. Hosts still implement connection-time network policy, streamed limits, and app-owned file materialization/read tools.
- Updated dependencies [8f5ea35]
- Updated dependencies [34b4275]
  - @yolk-sdk/agent@0.1.0-canary.76

## 0.1.0-canary.75

### Minor Changes

- 7f238d8: Add a host-only OneDrive/SharePoint original-byte download helper and an optional bounded binary HTTP port. Reuse existing Microsoft read credentials, resolve remote item identities, sanitize failures, and strip all original headers on download redirects. Default Microsoft actions and agent serialization are unchanged. Hosts still implement connection-time network policy, streamed limits, and app-owned file materialization/read tools.

### Patch Changes

- Updated dependencies [7f238d8]
  - @yolk-sdk/agent@0.1.0-canary.75

## 0.1.0-canary.74

### Patch Changes

- 20588d9: Keep package versions aligned with the agent's opt-in background tool execution and the
  Workflow child-observation updates. No additional implementation changes in these packages.
- Updated dependencies [79fe70b]
- Updated dependencies [79fe70b]
  - @yolk-sdk/agent@0.1.0-canary.74

## 0.1.0-canary.73

### Patch Changes

- 6672571: Add opt-in background subagent acknowledgements without premature child-completion events,
  public whole-batch HITL preflight, and generic bounded Workflow tool orchestration and durable
  child read/sleep seams. Preserve inline subagent compatibility and logical usage identity.
  The Next example wires independent foreground/background child workflows with owned durable
  reservations/results and tombstone-first explicit Stop cancellation.
- 2749df0: Add Effect-native `resolveMessageAttachmentSources` and `resolveMessagesAttachmentSources` protocol helpers. Traverse user, assistant, and tool-result media, including nested assistant provider tool results, while preserving metadata and ordering without mutation or caching. Document host-owned fresh signing inside provider retries, native PDF/image tool results, and bounded attachment transport.

  Validate Gmail discovery attachment sizes as nonnegative integers and omit malformed optional size metadata. Keep download limits, decoded-byte validation, authorization, storage, and extraction policy host-owned.

- Updated dependencies [6672571]
- Updated dependencies [2749df0]
  - @yolk-sdk/agent@0.1.0-canary.73

## 0.1.0-canary.72

### Patch Changes

- 79b6ff8: Align installation examples with the SDK's Effect version, correct Google connector tool wiring, document Outlook optional read inputs, and date previously released canary migrations.
- 9897531: Add `@yolk-sdk/connectors/fortnox` with nine read-only actions for company information and list/get customers, invoices, suppliers, and supplier invoices. Include typed schemas, pagination, resource-scoped OAuth credential hints, provider failure handling, and agent-tool access metadata. Hosts retain HTTP execution, OAuth lifecycle, credentials, and policy; Fortnox OAuth scopes themselves still grant read and write access.
- 782092d: Normalize null and blank optional inputs for Outlook message search and listing, including null page sizes, before execution. Direct connector callers and generated agent tools now share the compatibility behavior while preserving real cursors, input validation, application-mailbox guards, and provider failures.
- Updated dependencies [79b6ff8]
- Updated dependencies [9897531]
- Updated dependencies [782092d]
  - @yolk-sdk/agent@0.1.0-canary.72

## 0.1.0-canary.71

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.71

## 0.1.0-canary.70

### Patch Changes

- Updated dependencies [7c636c9]
  - @yolk-sdk/agent@0.1.0-canary.70

## 0.1.0-canary.69

### Patch Changes

- Updated dependencies [9747ec9]
  - @yolk-sdk/agent@0.1.0-canary.69

## 0.1.0-canary.68

### Patch Changes

- 73e7a9b: Refresh public guidance for durable user-message events, voice WebSocket wiring, Calendar event boundaries, and Workflow testing.
- Updated dependencies [73e7a9b]
  - @yolk-sdk/agent@0.1.0-canary.68

## 0.1.0-canary.67

### Patch Changes

- 57795cf: Refresh public package descriptions, connector access guidance, and documented package subpaths.
- Updated dependencies [0da67d1]
- Updated dependencies [57795cf]
  - @yolk-sdk/agent@0.1.0-canary.67

## 0.1.0-canary.66

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.66

## 0.1.0-canary.65

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.65

## 0.1.0-canary.64

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.64

## 0.1.0-canary.63

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.63

## 0.1.0-canary.62

### Patch Changes

- Updated dependencies [7677e18]
  - @yolk-sdk/agent@0.1.0-canary.62

## 0.1.0-canary.61

### Patch Changes

- Updated dependencies [025b16b]
- Updated dependencies [f495460]
  - @yolk-sdk/agent@0.1.0-canary.61

## 0.1.0-canary.60

### Patch Changes

- Updated dependencies [8ac2ad9]
  - @yolk-sdk/agent@0.1.0-canary.60

## 0.1.0-canary.59

### Patch Changes

- a5581f7: Refresh public package documentation with verified imports, runtime boundaries, and host responsibilities.
- Updated dependencies [eb908b7]
- Updated dependencies [a5581f7]
  - @yolk-sdk/agent@0.1.0-canary.59

## 0.1.0-canary.58

### Patch Changes

- Updated dependencies [a4a3d52]
  - @yolk-sdk/agent@0.1.0-canary.58

## 0.1.0-canary.57

### Patch Changes

- da9e8ba: Refresh package documentation with runtime requirements, host responsibilities, subpath boundaries, and corrected usage examples.
- Updated dependencies [da9e8ba]
- Updated dependencies [de55946]
  - @yolk-sdk/agent@0.1.0-canary.57

## 0.1.0-canary.56

### Patch Changes

- Updated dependencies [2013d5e]
  - @yolk-sdk/agent@0.1.0-canary.56

## 0.1.0-canary.55

### Patch Changes

- Updated dependencies [6297363]
  - @yolk-sdk/agent@0.1.0-canary.55

## 0.1.0-canary.54

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.54

## 0.1.0-canary.53

### Patch Changes

- Updated dependencies [a47adb1]
  - @yolk-sdk/agent@0.1.0-canary.53

## 0.1.0-canary.52

### Patch Changes

- Updated dependencies [15d0159]
  - @yolk-sdk/agent@0.1.0-canary.52

## 0.1.0-canary.51

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.51

## 0.1.0-canary.50

### Minor Changes

- 5457ed9: Add full MCP `2026-07-28` client, server, and wire-schema support through the official TypeScript SDK v2, including stateless HTTP, MRTR, subscriptions, cache hints, routable headers, and dual-era legacy compatibility. Remote Yolk tool helpers now negotiate the modern protocol automatically while retaining initialize-based fallback and preserving discovered tool titles, input/output schemas, and annotations.

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.50

## 0.1.0-canary.49

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.49

## 0.1.0-canary.48

### Patch Changes

- Updated dependencies [6cfc7fb]
  - @yolk-sdk/agent@0.1.0-canary.48

## 0.1.0-canary.47

### Patch Changes

- Updated dependencies [b0576d3]
  - @yolk-sdk/agent@0.1.0-canary.47

## 0.1.0-canary.46

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.46

## 0.1.0-canary.45

### Patch Changes

- Updated dependencies [d8c0b7a]
  - @yolk-sdk/agent@0.1.0-canary.45

## 0.1.0-canary.44

### Patch Changes

- Updated dependencies [607255e]
  - @yolk-sdk/agent@0.1.0-canary.44

## 0.1.0-canary.43

### Patch Changes

- Updated dependencies [5c53852]
  - @yolk-sdk/agent@0.1.0-canary.43

## 0.1.0-canary.42

### Patch Changes

- Add compaction checkpoint formatting and one-shot context-overflow retry helpers.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.42

## 0.1.0-canary.41

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.41

## 0.1.0-canary.40

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.40

## 0.1.0-canary.39

### Patch Changes

- Expose Effect-native attachment and durable workflow helpers, and refresh package documentation for current public exports.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.39

## 0.1.0-canary.38

### Patch Changes

- Harden agent transport and voice Effect boundaries.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.38

## 0.1.0-canary.37

### Patch Changes

- Publish canary with agent client stream continuation fixes and package docs updates.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.37

## 0.1.0-canary.36

### Patch Changes

- Updated dependencies [afb30a0]
  - @yolk-sdk/agent@0.1.0-canary.36

## 0.1.0-canary.35

### Patch Changes

- Updated dependencies [e9d235d]
- Updated dependencies [26b8b4d]
  - @yolk-sdk/agent@0.1.0-canary.35

## 0.1.0-canary.34

### Patch Changes

- Updated dependencies [01719c0]
  - @yolk-sdk/agent@0.1.0-canary.34

## 0.1.0-canary.33

### Patch Changes

- Voice as a first-class agent modality in `@yolk-sdk/agent`:

  - `@yolk-sdk/agent/voice`: provider-neutral voice protocol, client controller, server tool handler with approval HITL, transcript projection, durable voice event ids, WebSocket transport, and one-shot TTS/STT service contracts (`VoiceSpeechSynthesizer`, `VoiceTranscriber`, `VoiceSpeechRequest.instructions` for delivery-style steering).
  - `@yolk-sdk/agent/voice/browser`: Effect-native browser WebRTC voice transport with a fakeable runtime seam.
  - `@yolk-sdk/agent/voice/react`: headless `useYolkVoice` browser hook.
  - `@yolk-sdk/agent/providers/openai/realtime`: OpenAI Realtime session config, event codecs, and voice client codec.
  - `@yolk-sdk/agent/providers/openai/speech`: OpenAI TTS/STT adapters; 429 responses surface as `VoiceSpeechError` code `rate_limited` so hosts can distinguish quota exhaustion from outages.
  - Projection keys assistant drafts per provider output item (falling back to response id): back-to-back responses, multi-item responses, and duplicate final transcript event families no longer concatenate, wipe, or duplicate projected messages.

  Other `@yolk-sdk/*` packages ship as part of the lockstep canary release.

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.33

## 0.1.0-canary.32

### Patch Changes

- Add Effect-native Vercel Workflow host wrappers and refresh package documentation.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.32

## 0.1.0-canary.31

### Patch Changes

- Simplify knowledge to document, file, chunk, context, and search contracts.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.31

## 0.1.0-canary.30

### Patch Changes

- Updated dependencies [4148be9]
  - @yolk-sdk/agent@0.1.0-canary.30

## 0.1.0-canary.29

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.29

## 0.1.0-canary.28

### Patch Changes

- Updated dependencies [90b0558]
  - @yolk-sdk/agent@0.1.0-canary.28

## 0.1.0-canary.27

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.27

## 0.1.0-canary.26

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.26

## 0.1.0-canary.25

### Patch Changes

- Fix connector provider pagination, Google scoped OAuth, Gmail drafts/send-as, LinkedIn queued email lookup, and R2 public URL handling.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.25

## 0.1.0-canary.24

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.24

## 0.1.0-canary.23

### Patch Changes

- Updated dependencies [e8ac8ce]
  - @yolk-sdk/agent@0.1.0-canary.23

## 0.1.0-canary.22

### Patch Changes

- Updated dependencies [378cd92]
  - @yolk-sdk/agent@0.1.0-canary.22

## 0.1.0-canary.21

### Patch Changes

- Surface typed provider failure metadata, retry state, and retry-aware chat items.
- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.21

## 0.1.0-canary.20

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.20

## 0.1.0-canary.19

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.19

## 0.1.0-canary.18

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.18

## 0.1.0-canary.17

### Patch Changes

- 92d966b: Expose structured model-visible tool error details.
- Updated dependencies [92d966b]
- Updated dependencies [6a6d7a6]
  - @yolk-sdk/agent@0.1.0-canary.17

## 0.1.0-canary.16

### Patch Changes

- Updated dependencies [ca545a6]
  - @yolk-sdk/agent@0.1.0-canary.16

## 0.1.0-canary.15

### Minor Changes

- Unify public package shape around `@yolk-sdk/agent` subpaths, fold React/OAuth/provider/skillset/voice APIs into the agent package, and rename Vercel Workflow imports to `@yolk-sdk/vercel-workflows`.

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.1.0-canary.15

## 0.1.0-canary.14

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.14

## 0.1.0-canary.13

### Minor Changes

- Add model-visible message envelopes with timestamps, author display names, and annotations.

### Patch Changes

- Updated dependencies
- Updated dependencies [3797339]
  - @yolk-sdk/agent@0.1.0-canary.13

## 0.0.1-canary.12

### Patch Changes

- Updated dependencies [b5a297a]
  - @yolk-sdk/agent@0.0.1-canary.12

## 0.0.1-canary.11

### Patch Changes

- Updated dependencies [0c7ed24]
  - @yolk-sdk/agent@0.0.1-canary.11

## 0.0.1-canary.10

### Patch Changes

- @yolk-sdk/agent@0.0.1-canary.10

## 0.0.1-canary.9

### Patch Changes

- Add typed attachment sources for inline media, URLs, and host-owned refs.
- Updated dependencies
  - @yolk-sdk/agent@0.0.1-canary.9

## 0.0.1-canary.8

### Patch Changes

- 76d5c21: Add document chat content parts with provider lowering.
- Updated dependencies [76d5c21]
  - @yolk-sdk/agent@0.0.1-canary.8

## 0.0.1-canary.7

### Patch Changes

- @yolk-sdk/agent@0.0.1-canary.7

## 0.0.1-canary.6

### Patch Changes

- Updated dependencies
  - @yolk-sdk/agent@0.0.1-canary.6

## 0.0.1-canary.5

### Patch Changes

- @yolk-sdk/agent@0.0.1-canary.5

## 0.0.1-canary.4

### Patch Changes

- Updated dependencies [992ae2c]
  - @yolk-sdk/agent@0.0.1-canary.4

## 0.0.1-canary.3

### Patch Changes

- @yolk-sdk/agent@0.0.1-canary.3

## 0.0.1-canary.2

### Patch Changes

- 55bc6c7: Prepare next canary release.
- Updated dependencies [55bc6c7]
  - @yolk-sdk/agent@0.0.1-canary.2

## 0.0.1-canary.1

### Patch Changes

- Prepare next canary release.
- Updated dependencies
  - @yolk-sdk/agent@0.0.1-canary.1

## 0.0.1-canary.0

### Patch Changes

- 4232c86: Prepare first public canary release.
- Updated dependencies [4232c86]
  - @yolk-sdk/agent@0.0.1-canary.0
