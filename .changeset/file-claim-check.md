---
'@yolk-sdk/agent': minor
'@yolk-sdk/codemode': minor
'@yolk-sdk/mcp': minor
'@yolk-sdk/files': minor
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
