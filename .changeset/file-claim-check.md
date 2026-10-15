---
'@yolk-sdk/agent': minor
'@yolk-sdk/codemode': minor
'@yolk-sdk/mcp': minor
'@yolk-sdk/files': minor
'@yolk-sdk/sandbox': minor
'@yolk-sdk/connectors': minor
---

File claim check (ADR 0009): agents move files between tools by `fileId`; bytes never reach the
model, scripts, the tool ledger or the transcript.

- `@yolk-sdk/agent/protocol`: `FilePart` joins `ContentPart` (bytes to move, lowered by every
  provider as its text label only), `filePartFromBytes`, `bytesToBase64`, `filePartText`,
  `FileDescriptor`, `FileId`, `fileLabel`, `fileNotCapturedLabel`, `formatFileSize`, `isFileId`,
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
  hash, no database), `deleteScopeFiles`, `fileIdFor`, and `makeFileToolModule` with `file_upload`
  (`PUT` to an https URL over a host `FileUploadTransportApi`) and `file_url` (signed download
  link).
- New `@yolk-sdk/files` tools `file_to_sandbox` (copy a file into the workspace, default
  `files/<name>`) and `file_from_sandbox` (turn a workspace file into a `fileId`, MIME type inferred
  from the extension), present when the host passes a sandbox with file transfer.
- `@yolk-sdk/sandbox`: optional binary `SandboxApi.writeFile`/`readFile` on workspace-relative
  paths (`normalizeWorkspacePath`), implemented by the Vercel layer (streamed, bounded reads) and
  `makeFakeSandboxFiles`; `SandboxInputErrorCause` gains `invalid_path`, `file_not_found` and
  `file_too_large`; `VercelSandboxHandle` gains `readFile` and `VercelSandboxFile.content` accepts
  bytes.
- `@yolk-sdk/connectors`: actions may declare `fileOutput` (a byte-free tool output schema and a
  `split` into files). The agent bridge declares that schema and returns the bytes as `FilePart`s.
  `gmail.get_attachment`, `outlook.get_attachment` and `email.get_attachment` use it, so as agent
  tools they return a file instead of base64 (`connector.invoke` is unchanged). New
  `connectorActionFile`, `sniffBase64MimeType`, `GmailGetAttachmentFileOutput`,
  `OutlookGetAttachmentFileOutput` and `EmailGetAttachmentFileOutput`.
