# File claim check

Status: proposed.

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
  versioned deliverable (ADK, A2A) and `resource` means MCP server content.
- **File descriptor**: `{ fileId, name, mimeType, size }`, what the model and scripts see.
- **Capture**: storing bytes from a tool result and replacing them with a descriptor.
- **Scope**: the host-derived owner of a file (for example workspace and session). Never supplied
  by the model.

## Decision summary

| Area        | Decision                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| Protocol    | New `FilePart { source, mimeType, filename?, size? }` in `ContentPart`: bytes to move, not to view     |
| Producers   | Tools, connectors and the MCP client emit `FilePart` (or `Image`/`Document`/`Audio`) with inline bytes |
| Capture     | `resolveTools({ files })` wraps every registration's execute, top-level and nested, before the ledger  |
| Identity    | `fileId` is derived from the scope and `sha256`: replays and duplicates resolve to the same file       |
| Model view  | Captured parts become `Ref { id: fileId }` plus a text label; bytes never reach the model or scripts   |
| Scripts     | Nested results expose `files: FileDescriptor[]`                                                        |
| Store       | `FileStore` port, implemented by hosts; a stateless object-storage implementation ships in the package |
| Tools       | `file_upload`, `file_url`, `file_to_sandbox`, `file_from_sandbox` in `@yolk-sdk/files`                 |
| Sinks       | Host and connector tools that take files accept `fileId`, in tagged unions where inputs vary           |
| Authority   | Host `FileAuthority` port per surface; the package never decides who may read or send                  |
| Fail-closed | Without a store, captured parts become "file not captured"; base64 never falls through to the model    |

## 1. Protocol

`FilePart` joins `TextPart`, `ImagePart`, `DocumentPart` and `AudioPart` and reuses
`AttachmentSource` (`InlineBase64 | Url | Ref`). Producers emit `InlineBase64`; capture rewrites it
to `Ref`. Provider lowering renders a `FilePart` as its label only (`file file_7k2… Faktura_225.pdf,
application/pdf, 91 KB`), never as an attachment.

Captured `Image`, `Document` and `Audio` parts keep their kind, so the model still sees images and
PDFs; their source becomes the same `Ref`, so the file the model views and the file it moves are one
object. Hosts resolve `file_` refs in their `AttachmentSourceResolver` per request, as they already
do for their own refs (signed URLs go in `turnContext`, [ADR 0008](0008-prompt-caching.md)).

## 2. Capture

`resolveTools` takes `files?: { store, authority, limits }`. When present it wraps each resolved
registration's execute (direct, nested from code mode, and applied staged plans), the same place the
ledger wraps calls, so capture sees every call. For each result it:

1. checks `authority.canCapture(context)`; continuations and other denied surfaces get the label
   "file not captured";
2. stores each inline `FilePart`, `ImagePart`, `DocumentPart` and `AudioPart` up to
   `limits.maxFileBytes` (larger: "file not captured: too large");
3. rewrites sources to `Ref`, appends descriptor labels to the content, and adds
   `structuredContent.files` (merged when `structuredContent` is an object, created otherwise).

Capture runs before the ledger records the result and before durable history, so replays, the
transcript and code mode stores only hold `fileId`s. Results that carry no bytes pass through
unchanged. Capture is eager: MCP blobs and fetched bodies cannot be fetched again later.

`fileId` is `file_` plus a base32 digest of `(scope, sha256)`. Re-execution and repeated captures
of the same bytes return the same id and write nothing new. The stored name and MIME type are those
of the first capture; descriptors report the current capture's name, and sinks take an optional
`name` override.

Without `files`, wrapped capture still runs in fail-closed mode: inline `FilePart`s become the
"file not captured" label so no base64 reaches a provider. Image, document and audio parts keep
today's behaviour.

## 3. Scripts

Code mode nested calls resolve to `structuredContent` when a tool declares `output`, otherwise to
text. When a result carries captured files, the script receives `files` alongside: tools with a
declared output get `structuredContent.files` (declared outputs that can yield files include
`files: Schema.Array(FileDescriptor)`); text results resolve to `{ text, files }`. Scripts pass
`fileId` strings between tools; bytes never enter QuickJS or `store()`.

```js
const r = await tools.gmail({ operation: 'get_attachment', messageId, attachmentId, account })
const f = r.files[0]
const up = await tools.mcp_afloat_create_receipt_upload({
  contentLength: f.size,
  contentType: f.mimeType
})
await tools.file_upload({ fileId: f.fileId, url: up.url, headers: up.headers })
```

## 4. Store and authority

```ts
type FileStoreApi = {
  put: (input: { scope; bytes; name; mimeType }) => Effect<FileInfo, FileStoreError>
  head: (input: { scope; fileId }) => Effect<Option<FileInfo>, FileStoreError>
  getBounded: (input: { scope; fileId; maxBytes }) => Effect<Uint8Array, FileStoreError>
  signRead: (input: { scope; fileId; ttlSeconds }) => Effect<string, FileStoreError>
  deleteScope: (input: { scope }) => Effect<void, FileStoreError>
}
```

`FileInfo` is `{ fileId, name, mimeType, size, sha256 }`. `@yolk-sdk/files` ships
`makeObjectStorageFileStore(objectStorage)`: key `files/{scope}/{fileId}`, metadata on the object,
no database. A `fileId` from another scope does not resolve because the key is always built from
the caller's scope. Hosts own retention; `deleteScope` lets them remove a session's files with the
session.

`FileAuthority` answers per call from the tool context: `canCapture`, `canRead`, `canEgress`
(`file_upload`, `file_url`). Hosts map their surfaces (main run, subagents, automatic
continuations) onto it and re-check at execution, because contexts are spread into nested surfaces.

## 5. Tools

`@yolk-sdk/files` exports `makeFileToolModule({ store, authority, transport, sandbox? })`:

| Tool                | Input                                | Output               | Access  |
| ------------------- | ------------------------------------ | -------------------- | ------- |
| `file_upload`       | `{ fileId, url, method?, headers? }` | `{ status, etag? }`  | `write` |
| `file_url`          | `{ fileId, ttlMinutes? }`            | `{ url, expiresAt }` | `write` |
| `file_to_sandbox`   | `{ fileId, path? }`                  | `{ path }`           | `write` |
| `file_from_sandbox` | `{ path, name?, mimeType? }`         | `FileDescriptor`     | `write` |

- `file_upload` streams the bytes with `PUT` (default) through the package's guarded public
  transport: public DNS only, no redirects, no cookies or ambient auth, tracing off, header denylist
  (`host`, `cookie`, hop-by-hop), `content-length` set from the stored size. It returns status and
  ETag only; the URL never appears in errors or logs. A missing response is an unknown outcome.
- `file_url` signs a read (default one hour) for destinations that fetch from a link.
- `file_to_sandbox` and `file_from_sandbox` need binary `writeFile`/`readFile` on `SandboxApi`
  (the Vercel client already has `writeFiles`).
- No approval: the sandbox already has open network egress, so gating these tools alone adds
  friction without protection. Hosts claim and ledger them as writes and may add prompt guidance
  about destinations named only in untrusted content. A future session-level egress policy, if
  any, covers the sandbox and these tools together.

## 6. Producers and sinks

- `@yolk-sdk/connectors`: download and attachment actions return `FilePart`s with
  `ConnectorFileBytes`; upload actions accept resolved bytes from the host.
- `@yolk-sdk/mcp`: embedded resource blobs become `FilePart`; images and audio stay
  `ImagePart`/`AudioPart` with inline sources and are captured like any other part. `resource_link`
  reads are a later addition.
- Sinks take `fileId`, in a tagged union where a parameter accepts several kinds of input (for
  example `content: { kind: 'text', text } | { kind: 'file', fileId }`). The host resolves bytes
  with `getBounded` after its own authority and claim checks.

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

- Multipart/form uploads (`file_upload` is `PUT` only).
- Streaming transfers above the host's in-memory budget.
- `file_import` from arbitrary URLs: `web_fetch` binary responses are captured instead.
- Public, permanent links.
- MCP `resource_link` reads.

[eip]: https://www.enterpriseintegrationpatterns.com/patterns/messaging/StoreInLibrary.html
[sep-2631]: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2631
[files-wg]: https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/3412
