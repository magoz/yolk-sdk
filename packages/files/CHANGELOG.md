# @yolk-sdk/files

## 0.1.0-canary.160

### Patch Changes

- d55175d: Advance in lockstep with `@yolk-sdk/agent` and `@yolk-sdk/codemode`: hosts can run code mode scripts outside a model turn (`runCodeModeScript` over `ResolvedToolSet.nestedExecutor`), gate them to reads (`readOnlyNestedCallGate`), mark tools that call a model (`invokesModel`), and render annotated host messages from chat items. These packages have no direct changes in this release.
- Updated dependencies [6f9a9e3]
  - @yolk-sdk/agent@0.1.0-canary.160

## 0.1.0-canary.159

### Patch Changes

- 0e5d1ac: Advance in lockstep with `@yolk-sdk/agent`, `@yolk-sdk/codemode`, `@yolk-sdk/harness` and `@yolk-sdk/vercel-workflows`: tool results can mark their nested usage incomplete (`ToolResult.usageIncomplete`), and durable model events name their execution's turn (`executionTurn`) so a client rebuilt from a snapshot mid-turn starts that turn. These packages have no direct changes in this release.
- Updated dependencies [0e5d1ac]
- Updated dependencies [628ebd5]
  - @yolk-sdk/agent@0.1.0-canary.159

## 0.1.0-canary.158

### Patch Changes

- d4141e3: Advance in lockstep with `@yolk-sdk/connectors`, which adds Fortnox bookkeeping actions (financial years, accounts, voucher series, vouchers, voucher file connections, and SIE files). These packages have no direct changes in this release.
- Updated dependencies [d4141e3]
  - @yolk-sdk/agent@0.1.0-canary.158

## 0.1.0-canary.157

### Patch Changes

- 7892f30: Advance in lockstep with `@yolk-sdk/connectors`, whose Fortnox supplier invoice reads now accept the JSON forms Fortnox sends beyond its OpenAPI types, and whose Fortnox reads fail an amount past the double range as `validation_failed`. These packages have no direct changes in this release.
- Updated dependencies [7892f30]
  - @yolk-sdk/agent@0.1.0-canary.157

## 0.1.0-canary.156

### Minor Changes

- 562958a: `makeFileToolModule` adds `file_save` (`fileSaveToolName`): `{ name, content, mimeType? }` stores text the model or a code mode script produced (JSON, CSV, Markdown, plain text) as a UTF-8 file in the module's store and returns `{ fileId, name, mimeType, size }` with the file in `ToolResult.files`, like `file_from_sandbox`, so a script hands computed data to any tool that takes `fileIds` without a sandbox or the model retyping it. It is a `write` tool without approval and is always in the module (it needs only the store). The name is reduced to one safe path segment, and the MIME type is inferred from its extension (an unknown or missing extension gives `text/plain`) unless `mimeType` is given (normalized like other names). Content over `maxTransferBytes` (UTF-8 bytes, default 50 MiB) is refused as `invalid_input` before anything is stored, and an unavailable store fails with a `ToolError`. The `fileId` follows from the scope and the content hash, so the same content (a replayed call) returns the same file and stores nothing new. Hosts that list the module's tools by name now also see `file_save` (after `file_url`).

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.156

## 0.1.0-canary.155

### Patch Changes

- d4d8714: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.1.5 (patch releases of Effect 4.1). Hosts must move `effect` and the coordinated `@effect/*` runtime packages to 4.1.5 together with Yolk. Yolk APIs are unchanged.
- Updated dependencies [d4d8714]
  - @yolk-sdk/agent@0.1.0-canary.155

## 0.1.0-canary.154

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.154

## 0.1.0-canary.153

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.153

## 0.1.0-canary.152

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.152

## 0.1.0-canary.151

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.151

## 0.1.0-canary.150

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.150

## 0.1.0-canary.149

### Patch Changes

- Updated dependencies [c112350]
- Updated dependencies [c112350]
- Updated dependencies [22f42c0]
- Updated dependencies [5039d29]
  - @yolk-sdk/agent@0.1.0-canary.149

## 0.1.0-canary.148

### Patch Changes

- Updated dependencies [1cd7e4c]
- Updated dependencies [e5bcedb]
- Updated dependencies [b501399]
- Updated dependencies [2c8e618]
- Updated dependencies [cb15a7b]
  - @yolk-sdk/agent@0.1.0-canary.148

## 0.1.0-canary.147

### Patch Changes

- Updated dependencies [e7bb9e6]
- Updated dependencies [6dc0b32]
- Updated dependencies [e7bb9e6]
  - @yolk-sdk/agent@0.1.0-canary.147

## 0.1.0-canary.146

### Patch Changes

- Updated dependencies [0de4b07]
- Updated dependencies [964b602]
- Updated dependencies [ad085cd]
  - @yolk-sdk/agent@0.1.0-canary.146

## 0.1.0-canary.145

### Patch Changes

- Updated dependencies [c1aaaeb]
  - @yolk-sdk/agent@0.1.0-canary.145

## 0.1.0-canary.144

### Patch Changes

- 6afa1c5: Advance in lockstep with `@yolk-sdk/sandbox`, which adds a Cloudflare Containers backend (`@yolk-sdk/sandbox/cloudflare`). These packages have no direct changes in this release.
- Updated dependencies [0bd8166]
- Updated dependencies [d8758cf]
- Updated dependencies [6afa1c5]
  - @yolk-sdk/agent@0.1.0-canary.144

## 0.1.0-canary.143

### Patch Changes

- Updated dependencies [bfbc4e9]
- Updated dependencies [83e4a7b]
  - @yolk-sdk/agent@0.1.0-canary.143

## 0.1.0-canary.142

### Patch Changes

- 8a3c032: Advance in lockstep with `@yolk-sdk/vercel-workflows` and `@yolk-sdk/codemode`, which add Cloudflare Workers runtimes (`@yolk-sdk/vercel-workflows/cloudflare*` and `@yolk-sdk/codemode/cloudflare`). These packages have no direct changes in this release.
- Updated dependencies [8a3c032]
  - @yolk-sdk/agent@0.1.0-canary.142

## 0.1.0-canary.141

### Patch Changes

- Updated dependencies [d634a02]
- Updated dependencies [38f38cf]
- Updated dependencies [3fe00ec]
  - @yolk-sdk/agent@0.1.0-canary.141

## 0.1.0-canary.140

### Patch Changes

- Updated dependencies [8998b9e]
  - @yolk-sdk/agent@0.1.0-canary.140

## 0.1.0-canary.139

### Patch Changes

- 7c3a30d: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.1.4 (patch releases of Effect 4.1). Hosts must move `effect` and the coordinated `@effect/*` runtime packages to 4.1.4 together with Yolk. Yolk APIs are unchanged.
- Updated dependencies [7c3a30d]
  - @yolk-sdk/agent@0.1.0-canary.139

## 0.1.0-canary.138

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.138

## 0.1.0-canary.137

### Patch Changes

- Updated dependencies [41ba67b]
  - @yolk-sdk/agent@0.1.0-canary.137

## 0.1.0-canary.136

### Patch Changes

- Updated dependencies [12dfd4e]
  - @yolk-sdk/agent@0.1.0-canary.136

## 0.1.0-canary.135

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.135

## 0.1.0-canary.134

### Patch Changes

- dc74275: Advance in lockstep with `@yolk-sdk/agent`, whose tool argument validation errors now name a number or boolean the model sent as a JSON string, with the literal to send instead. The tools of `@yolk-sdk/connectors`, `@yolk-sdk/knowledge`, `@yolk-sdk/sandbox` and `@yolk-sdk/files` already append that hint, so their errors gain the line. These packages have no direct changes in this release.
- Updated dependencies [21fd3fe]
  - @yolk-sdk/agent@0.1.0-canary.134

## 0.1.0-canary.133

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.133

## 0.1.0-canary.132

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.132

## 0.1.0-canary.131

### Patch Changes

- 6e9bd7d: Advance in lockstep with `@yolk-sdk/agent`, whose providers now fail a returned tool call with an empty or padded id or name as a typed `invalid_response` instead of a defect, and `@yolk-sdk/vercel-workflows`, whose `TestWorkflowWorld` now stores step errors through the platform's serializer and records unstorable ones in `inspect(runId).unstorableStepErrors`. These packages have no direct changes in this release.
- Updated dependencies [59c9747]
  - @yolk-sdk/agent@0.1.0-canary.131

## 0.1.0-canary.130

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.130

## 0.1.0-canary.129

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.129

## 0.1.0-canary.128

### Patch Changes

- cae5998: Advance in lockstep with `@yolk-sdk/connectors`, which adds Microsoft Teams chats, channels, meeting lookup and transcripts to `@yolk-sdk/connectors/microsoft`. These packages have no direct changes in this release.
- Updated dependencies [cae5998]
  - @yolk-sdk/agent@0.1.0-canary.128

## 0.1.0-canary.127

### Patch Changes

- 5a12835: Advance in lockstep with `@yolk-sdk/connectors`, which adds SharePoint site search, site drive listing and sharing-link resolution to `@yolk-sdk/connectors/microsoft`. These packages have no direct changes in this release.
- Updated dependencies [5a12835]
  - @yolk-sdk/agent@0.1.0-canary.127

## 0.1.0-canary.126

### Patch Changes

- 74c1fe5: Advance in lockstep with `@yolk-sdk/agent`, `@yolk-sdk/codemode`, `@yolk-sdk/mcp` and `@yolk-sdk/connectors`, which adopt typed tool results (ADR 0013); `@yolk-sdk/connectors` also adds the Kie connector. These packages have no direct changes in this release.
- Updated dependencies [bcb26c8]
  - @yolk-sdk/agent@0.1.0-canary.126

## 0.1.0-canary.125

### Patch Changes

- @yolk-sdk/agent@0.1.0-canary.125

## 0.1.0-canary.124

### Patch Changes

- 6a1c1d4: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.1.2. Hosts must use the matching Effect version, and adopt Effect 4.1's own breaking changes where their code uses the affected APIs (`effect/Crypto`, `HttpClientRequest.method` as `string`, `KeyValueStore`, `FileSystem.make`, `ChildProcess` templates, `McpServer` registrations). `@effect/platform-node` 4.1 requires `ws` ^8.22.1; dedupe `ws` if a Workflow build reports duplicate step ids.

  Tool JSON Schemas generated from Effect schemas are flatter: Effect 4.1 merges a nested `anyOf` into its parent and no longer duplicates a named definition used by both a required and an optional property. What a schema admits is unchanged, and the `yolk:null-means-omitted` marker still tells the codec-added `null` from a `Schema.NullOr` `null`. Hosts that list tools over MCP serve changed tool schemas once, so grants keyed on a tool snapshot digest return to their default for the affected tools.

- Updated dependencies [6a1c1d4]
- Updated dependencies [4f6cd82]
  - @yolk-sdk/agent@0.1.0-canary.124

## 0.1.0-canary.123

### Patch Changes

- Updated dependencies [fc21cd8]
  - @yolk-sdk/agent@0.1.0-canary.123

## 0.1.0-canary.122

### Patch Changes

- 6d9787f: Advance in lockstep with `@yolk-sdk/connectors`, whose action inputs now advertise only finite numbers (integer counts and page sizes of at least 1, some with upper bounds, and finite GitHub issue-field numbers and Fortnox nullable amounts). These packages have no direct changes in this release.
- Updated dependencies [6d9787f]
  - @yolk-sdk/agent@0.1.0-canary.122

## 0.1.0-canary.121

### Patch Changes

- 59d338d: Advance in lockstep with `@yolk-sdk/mcp`, whose `makeMcpToolServer().handleHttpRequest` now finishes every exchange before it returns, so no tool call runs after the caller's scope has closed. These packages have no direct changes in this release.
- Updated dependencies [59d338d]
  - @yolk-sdk/agent@0.1.0-canary.121

## 0.1.0-canary.120

### Patch Changes

- 79595fc: Advance in lockstep with `@yolk-sdk/agent`, which now shows Claude (compatibility mode) the real type of `Schema.optional` tool params instead of an unconstrained value. These packages have no direct changes in this release.
- Updated dependencies [a9eee1b]
  - @yolk-sdk/agent@0.1.0-canary.120

## 0.1.0-canary.119

### Patch Changes

- Updated dependencies [67cfa52]
  - @yolk-sdk/agent@0.1.0-canary.119

## 0.1.0-canary.118

### Patch Changes

- f7f6d58: Republish every public package in lockstep after an incomplete `0.1.0-canary.117` publish: npm held `@yolk-sdk/extractors@0.1.0-canary.117`, so `@yolk-sdk/extractors`, `@yolk-sdk/pool`, `@yolk-sdk/sandbox` and `@yolk-sdk/vercel-workflows` were never published at that version. This release contains no implementation changes beyond `0.1.0-canary.117`; install this version (with all `@yolk-sdk/*` packages on it) instead of `0.1.0-canary.117`.
- Updated dependencies [f7f6d58]
  - @yolk-sdk/agent@0.1.0-canary.118

## 0.1.0-canary.117

### Patch Changes

- 47827d8: Advance unchanged public packages in lockstep with the `@yolk-sdk/connectors` fix for email attachments above ~3 MB (the attachment base64 is no longer pattern-checked) and the one-copy byte decoding and new `base64ToBytes` in `@yolk-sdk/agent`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [190c928]
  - @yolk-sdk/agent@0.1.0-canary.117

## 0.1.0-canary.116

### Patch Changes

- 02953b4: Upgrade the coordinated Effect runtime and platform dependencies to Effect 4.0.5. Hosts must use the matching Effect version.

  Effect 4.0.5 drops a typed failure when an interruption skipped its recovery handler, so a connector conformance run interrupted while a case's cleanup fails, a write's outcome is unknown, or a cleanup is refused now ends interrupt-only instead of with the case's error. The problem still reaches `ConformanceCleanupReporter`. See the migration guide.

- Updated dependencies [02953b4]
- Updated dependencies [995762e]
  - @yolk-sdk/agent@0.1.0-canary.116

## 0.1.0-canary.115

### Patch Changes

- e662c70: Advance unchanged public packages in lockstep with `@yolk-sdk/agent`, which now reports one typed `AgentStatus` per run and per subagent (ADR 0010). These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [5f08b0f]
  - @yolk-sdk/agent@0.1.0-canary.115

## 0.1.0-canary.114

### Minor Changes

- fddf4a6: File claim check (ADR 0009): agents move files between tools by `fileId`; `File` bytes never reach
  the model, scripts, the tool ledger or the transcript (inline images, documents and audio the model
  views keep their inline source for now).

  - `@yolk-sdk/agent/protocol`: `FilePart` joins `ContentPart` (bytes to move, lowered by every
    provider as its text label only), `filePartFromBytes`, `bytesToBase64`, `filePartText`,
    `FileDescriptor`, `FileId`, `fileLabel`, `fileNotCapturedLabel`, `formatFileSize`, `isFileId`, `normalizeFileMimeType`,
    and `ToolResult.files` (captured descriptors, not sent to providers).
  - `@yolk-sdk/agent/tools`: `resolveTools(modules, context, { files: { store, maxFileBytes? } })`
    captures every executed result (direct, nested and staged) before the ledger: inline `File`
    parts are stored through the host `FileStoreApi` and rewritten to `Ref { id: fileId }`; inline
    image, document and audio parts are stored and followed by their label (the model still sees
    them). Without `files`, or when storing fails or a file is over the bound (default 100 MiB),
    inline `File` parts become a "file not captured" label. Exports `FileStoreApi`,
    `FileStoreError`, `ToolFileCaptureOptions`, `captureToolResultFiles`, and
    `defaultMaxCapturedFileBytes`. The tool ledger keeps `files` through every reduction step and on
    replay.
  - `@yolk-sdk/codemode`: a nested call that captured files also resolves `files: [{ fileId, name,
mimeType, size }]`, merged into an object result or as `{ text, files }`; the code mode
    description says so.
  - `@yolk-sdk/mcp`: embedded resource blobs in tool results become `FilePart`s instead of base64
    text; the MCP server lowers a `FilePart` with inline bytes to an embedded resource blob and a
    captured one to its label.
  - New `@yolk-sdk/files`: `makeObjectStorageFileStore` (a `FileStoreApi` over a host
    `ObjectStorageApi`: keys `<prefix>/<scope>/<fileId>`, `fileId` derived from scope and content
    hash, no database), `deleteScopeFiles`, `fileIdFor`, `isValidFileScope`, and `makeFileToolModule` with `file_upload`
    (`PUT` to an https URL over a host `FileUploadTransportApi`) and `file_url` (signed download
    link).
  - New `@yolk-sdk/files` tools `file_to_sandbox` (copy a file into the workspace, default
    `files/<fileId>/<name>`) and `file_from_sandbox` (turn a workspace file into a `fileId`, MIME type inferred
    from the extension), present when the host passes a sandbox with file transfer (the structural
    `FileSandboxApi`/`FileSandboxError` port, which `@yolk-sdk/sandbox` `SandboxApi` satisfies).
  - `@yolk-sdk/sandbox`: optional binary `SandboxApi.writeFile`/`readFile` on workspace-relative
    paths (`normalizeWorkspacePath`, `NormalizedWorkspacePath`), implemented by the Vercel layer (streamed, bounded reads) and
    `makeFakeSandboxFiles`; `SandboxInputErrorCause` gains `invalid_path`, `file_not_found` and
    `file_too_large`; `VercelSandboxHandle` gains `readFile` and `VercelSandboxFile.content` accepts
    bytes.
  - `@yolk-sdk/connectors`: actions may declare `fileOutput` (a byte-free tool output schema and a
    `split` into files). The agent bridge declares that schema and returns the bytes as `FilePart`s.
    `gmail.get_attachment`, `outlook.get_attachment` and `email.get_attachment` use it, so as agent
    tools they return a file instead of base64 (`connector.invoke` is unchanged).
    `gmail.get_attachment` takes optional `filename` and `mimeType` (from `gmail.list_attachments`,
    echoed unverified in the output) to name and type the file. New
    `connectorActionFile`, `sniffBase64MimeType`, `GmailGetAttachmentFileOutput`,
    `OutlookGetAttachmentFileOutput` and `EmailGetAttachmentFileOutput`.

  Host migration:

  - `ContentPart` has a new `File` member: exhaustive `Match`es over content parts need a case
    (render `filePartText`).
  - Custom `VercelSandboxHandle` implementations and fakes need `readFile`.
  - As agent tools, `gmail.get_attachment`, `outlook.get_attachment` and `email.get_attachment` now
    return a file instead of base64 (`structuredContent` keeps only metadata), and connector sinks
    such as Gmail draft attachments do not take `fileId`s yet: hosts that forwarded attachment
    base64 through the model need their own file-aware tool.
  - MCP embedded blobs reach the model as a file label instead of base64 text.
  - The code mode description gains one line (one cache prefix change).

### Patch Changes

- Updated dependencies [fddf4a6]
  - @yolk-sdk/agent@0.1.0-canary.114
