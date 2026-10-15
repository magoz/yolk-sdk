# File claim check

Status: accepted.

Agents cannot move files between tools. Bytes that a tool produces either become model content
(an image or PDF the model reads, extracted text) or are dropped, so nothing else can consume them:

- connector downloads (`downloadGmailAttachment`, `downloadGoogleDriveFile`, ...) return
  `ConnectorFileBytes` to the host, which turns them into model content and discards the bytes;
- the MCP client lowers embedded resource blobs to text (`MCP resource: ${uri}\n${blob}`), so a
  blob reaches the model as base64, and images as inline base64 parts;
- code mode scripts have no network ([ADR 0002](0002-code-mode.md)) and `SandboxApi` only exposes
  `run`, so neither can hand bytes to a tool that uploads them.

A real run showed the cost: the agent found invoice PDFs in Gmail, created expenses through an MCP
server that issues presigned upload URLs, and could not attach the PDFs. Its only path was copying
120 KB of base64 per file through its own output.

This ADR applies the Claim Check pattern ([Enterprise Integration Patterns][eip]): store the bytes
once at the edge where they appear, pass a short id through the model, scripts, ledger and
transcript, and swap the id back for bytes (or a signed link) at the edge that consumes them.

## Terms

- **File**: immutable bytes plus `name`, `mimeType`, `size` and `sha256`, stored by the host.
- **`fileId`**: the agent-facing reference to a file, `file_` followed by an opaque id. The field
  name follows provider and framework usage (`file_id` in OpenAI, Anthropic, LangChain, Pydantic
  AI; camelCase like `messageId`); `fileRef`/`fileHandle` have no precedent, `artifact` means a
  versioned deliverable (ADK, A2A) and `resource` means MCP server content. Some
  connector inputs are also named `fileId` (Drive, Telegram, Fortnox provider ids); the `file_`
  prefix and the `FileId` schema tell them apart, and file tools reject anything else.
- **File descriptor**: `{ fileId, name, mimeType, size }`, what the model and scripts see.
- **Capture**: storing bytes from a tool result and replacing them with a descriptor.
- **Scope**: the host-derived owner of a file (for example workspace and session). Never supplied
  by the model.

## Decision summary

| Area        | Decision                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| Protocol    | New `FilePart { source, mimeType, filename?, size? }` in `ContentPart`: bytes to move, not to view      |
| Producers   | Tools, connectors and the MCP client emit `FilePart` (or `Image`/`Document`/`Audio`) with inline bytes  |
| Capture     | `resolveTools({ files })` captures every registration result, top-level, nested and staged, pre-ledger  |
| Identity    | `fileId` is derived from the scope and `sha256`: replays and duplicates resolve to the same file        |
| Model view  | Captured `File` parts become `Ref { id: fileId }`, lowered as a text label; bytes never reach the model |
| Scripts     | `ToolResult.files` lists descriptors; nested results resolve them as `files`                            |
| Store       | Scope-bound `FileStoreApi` from the host; `@yolk-sdk/files` ships an object-storage implementation      |
| Tools       | `file_upload`, `file_url`, `file_to_sandbox`, `file_from_sandbox` in `@yolk-sdk/files`                  |
| Sinks       | Host and connector tools that take files accept `fileId`, in tagged unions where inputs vary            |
| Authority   | Host-owned: it passes `files` and the file module only to surfaces allowed to use them                  |
| Fail-closed | Without a store, inline `File` parts become "file not captured"; base64 never reaches the model         |

## 1. Protocol

`FilePart` joins `TextPart`, `ImagePart`, `DocumentPart` and `AudioPart` and reuses
`AttachmentSource` (`InlineBase64 | Url | Ref`). Producers emit `InlineBase64`
(`filePartFromBytes`); capture rewrites it to `Ref`. Every provider lowers a `FilePart` as its label
only (`filePartText`: `[file file_7k2…: Faktura_225.pdf, application/pdf, 89 KB]`), never as an
attachment, and an uncaptured inline `FilePart` as `[file not captured (reason): name, mime]`.

`ToolResult.files` carries the descriptors (`FileDescriptor { fileId, name, mimeType, size }`) of
the files captured from that result. Like `nestedCalls` it is not sent to providers: the content
carries the labels.

Captured `Image`, `Document` and `Audio` parts keep their inline source in this slice, so the model
still sees them unchanged; capture stores a copy and appends its label. Rewriting their source to
the same `Ref` (one object for viewing and moving) needs hosts to resolve `file_` refs in their
`AttachmentSourceResolver` and is a later step.

## 2. Capture

`resolveTools` takes `files?: { store, maxFileBytes? }` (default 100 MiB). Every registration
result passes `captureToolResultFiles` in `runRegistration`, the single path of direct calls,
nested code mode calls and applied staged plans, before the ledger records it. For each inline part:

1. `File`: stored and rewritten to `Ref`; over the bound or when storing fails, replaced by the
   "not captured" label (the failure is logged, never fatal);
2. `Image`, `Document`, `Audio`: stored and followed by their label; on failure left as they are.

Capture runs before the ledger and durable history, so replays, the transcript and code mode stores
only hold `fileId`s. The ledger keeps `files` through every reduction step and on replay. Results
without inline bytes pass through unchanged. Capture is eager: MCP blobs and fetched bodies cannot
be fetched again later.

Without `files`, inline `File` parts still become the "not captured" label, so no base64 reaches a
provider; image, document and audio parts keep today's behaviour. Hosts pass `files` only on
surfaces allowed to capture (for example not on automatic continuations); to share files with a
subagent, they give it a store bound to the same scope.

Interaction tool results are captured before the host stores the settled receipt. When the ledger
reduces a stored result, a `File` part becomes its label, so replays keep the `fileId` visible.

## 3. Scripts

Code mode nested calls resolve to `structuredContent` when a tool declares `output`, otherwise to
text. When `ToolResult.files` is not empty the script also gets the descriptors as `files`: merged
into an object value, otherwise as `{ text, files }`. The code mode description says so. Scripts
pass `fileId` strings between tools; bytes never enter QuickJS or `store()`.

```js
const r = await tools.gmail({ operation: 'get_attachment', messageId, attachmentId, account })
const f = r.files[0]
const up = await tools.mcp_afloat_create_receipt_upload({
  contentLength: f.size,
  contentType: f.mimeType
})
await tools.file_upload({ fileId: f.fileId, url: up.url, headers: up.headers })
```

## 4. Store

```ts
type FileStoreApi = {
  put: (input: { bytes; name; mimeType }) => Effect<FileDescriptor, FileStoreError>
  head: (fileId) => Effect<Option<FileDescriptor>, FileStoreError>
  read: (input: { fileId; maxBytes }) => Effect<Uint8Array, FileStoreError>
  signRead: (input: { fileId; ttlSeconds }) => Effect<string, FileStoreError>
}
```

A store is bound to one host-derived scope (for example `<workspaceId>/<sessionId>`), so no call
names a scope and the model can never supply one. `FileStoreError.reason` is `not_found`,
`too_large` or `unavailable`.

`@yolk-sdk/files` ships `makeObjectStorageFileStore({ storage, scope, prefix? })` over a host
`ObjectStorageApi` (`put`, `head`, `get`, `signGet`, `deletePrefix`): key
`<prefix>/<scope>/<fileId>` (prefix `files`), name (URI-encoded) and sha256 in object metadata, no
database. A `fileId` from another scope does not resolve because the key is always built from the
store's scope. `fileId` is `file_` plus 26 base32 characters of `sha256(scope, content sha256)`
(`fileIdFor`): re-execution and repeated captures of the same bytes write nothing new. The stored
name is the first capture's; descriptors report the current capture's name. `deleteScopeFiles`
removes a scope's files, for example with its session.

Authority stays with the host: it decides per resolution whether to pass `files` and the file
module, and keeps re-checking its own run authority inside the transport and store adapters where
it needs to.

## 5. Tools

`@yolk-sdk/files` exports `makeFileToolModule({ store, transport?, sandbox?, maxTransferBytes?,
defaultUrlTtlSeconds?, isEnabled? })`:

| Tool                | Input                        | Output                             | Access  |
| ------------------- | ---------------------------- | ---------------------------------- | ------- |
| `file_upload`       | `{ fileId, url, headers? }`  | `{ status, size, etag? }`          | `write` |
| `file_url`          | `{ fileId, ttlMinutes? }`    | `{ url, expiresAt }`               | `write` |
| `file_to_sandbox`   | `{ fileId, path? }`          | `{ path, size }`                   | `write` |
| `file_from_sandbox` | `{ path, name?, mimeType? }` | `{ fileId, name, mimeType, size }` | `write` |

- `file_upload` `PUT`s the stored bytes (up to `maxTransferBytes`, default 50 MiB) through the
  host's `FileUploadTransportApi`, which must be a guarded client: public addresses only (checked
  on the resolved IP), TLS verified, no redirects, no cookies or ambient credentials, no logging or
  tracing of the URL. Before reading bytes the tool requires an absolute `https` URL without
  credentials, HTTP-token header names without CR/LF in values, and refuses `host`, `cookie`,
  `content-length`, `expect` and hop-by-hop headers. Results and errors name the destination host,
  never the URL. A non-2xx status is a model-visible error; a transport `network` failure is an
  unknown outcome the model must reconcile, never retried automatically. Without a transport the
  tool is left out.
- `file_url` signs a read link (default one hour, up to seven days) for destinations that fetch
  from a URL and for sharing.
- No approval: the sandbox already has open network egress, so gating these tools alone adds
  friction without protection. Hosts claim and ledger them as writes and may add prompt guidance
  about destinations named only in untrusted content. A future session-level egress policy, if
  any, covers the sandbox and these tools together.
- `file_to_sandbox` writes the bytes to a workspace-relative path (default `files/<name>`) and
  `file_from_sandbox` stores a workspace file (MIME type inferred from the extension unless given).
  They use the invoking runtime's own sandbox, through the optional binary
  `SandboxApi.writeFile`/`readFile` (`@yolk-sdk/sandbox`: workspace-relative paths only, streamed
  reads bounded by `maxTransferBytes`), and exist only when the host passes a sandbox that has
  them.

## 6. Producers and sinks

- `@yolk-sdk/mcp`: embedded resource blobs become `FilePart`s (name from the URI); embedded text
  stays text; images and audio stay `ImagePart`/`AudioPart` with inline sources and are captured
  like any other part. The MCP server lowers an inline `FilePart` to an embedded resource blob and a
  captured one to its label. `resource_link` reads are a later addition.
- `@yolk-sdk/connectors`: an action whose output carries bytes declares `fileOutput`: a byte-free
  `schema` (declared as the agent tool output) and `split` (that value plus base64 files, typed by
  `connectorActionFile`, which sniffs common MIME types). The agent bridge returns the bytes as
  `FilePart`s after the text; `connector.invoke` keeps the full output for hosts.
  `gmail.get_attachment`, `outlook.get_attachment` and `email.get_attachment` use it. Host-only
  downloaders (`downloadGoogleDriveFile`, ...) stay host APIs: hosts wrap their bytes with
  `filePartFromBytes`.
- Sinks take `fileId`, in a tagged union where a parameter accepts several kinds of input (for
  example `content: { kind: 'text', text } | { kind: 'file', fileId }`). The host reads bytes with
  `read` after its own authority and claim checks.

## Limits

Hosts set `maxFileBytes` (o-o: 100 MiB). Transfers buffer in memory until streaming exists, so
hosts keep their transfer budget (o-o: 50 MiB) as the upper bound for `file_upload` and sink reads.
No package quota: hosts add one if they need it.

## Prior art

- Claim Check: [EIP][eip], [Azure](https://learn.microsoft.com/en-us/azure/architecture/patterns/claim-check),
  AWS SQS Extended Client (S3 pointer messages).
- Reference fields: OpenAI `input_file.file_id`, Anthropic `source: { type: 'file', file_id }`,
  LangChain `FileContentBlock.file_id`, Pydantic AI `UploadedFile.file_id`, Notion
  `{ type: 'file_upload', file_upload: { id } }`, [AIP-122](https://google.aip.dev/122).
- Edge swaps: Telegram `attach://`, Discord `attachment://`, GraphQL multipart `map`.
- Agent runtimes: Google ADK artifacts, OpenAI and Anthropic Files APIs, Anthropic code execution
  with MCP, Cloudflare Code Mode.

## MCP alignment

The MCP Files working group is drafting first-class files ([SEP-2631][sep-2631],
[discussion][files-wg]): `FileValue { uri, name?, mimeType?, size? }`, `mcp-file://` URIs and
`files/authorizeUpload`/`files/authorizeDownload`. It is not ratified. If it lands, the MCP client
maps `FileValue` to `FilePart` on the way in and `fileId` to `FileValue` (via `file_url` or an
authorized upload) on the way out; the agent-facing `fileId` does not change.

## Not done

- `fileOutput` on further connector actions, and `fileId` inputs for connector sinks (Gmail and
  Outlook draft attachments, ...): until then hosts attach files through their own tools.
- Rewriting captured image, document and audio sources to `Ref`.
- A guarded Node `FileUploadTransportApi` in the package (hosts provide one).
- Multipart/form uploads (`file_upload` is `PUT` only).
- Streaming transfers above the host's in-memory budget.
- `file_import` from arbitrary URLs: `web_fetch` binary responses are captured instead.
- Public, permanent links.
- MCP `resource_link` reads.

[eip]: https://www.enterpriseintegrationpatterns.com/patterns/messaging/StoreInLibrary.html
[sep-2631]: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2631
[files-wg]: https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/3412
