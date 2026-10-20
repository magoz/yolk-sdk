# @yolk-sdk/files

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
