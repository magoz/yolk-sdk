# @yolk-sdk/files

Files as handles for Yolk agents ([ADR 0009](../../docs/adr/0009-file-claim-check.md), the
Claim Check pattern). File bytes a tool returns (`FilePart`) are stored once by the host; the
model, code mode scripts, the tool ledger and the transcript only see a `fileId`. Tools turn a
`fileId` back into bytes or a link at the edge that needs them. Inline images, documents and audio
the model views keep their inline source for now (a stored copy and its label are added).

Capture is part of `@yolk-sdk/agent`: tools emit `FilePart` (`filePartFromBytes`), and
`resolveTools(modules, context, { files: { store } })` stores the bytes and replaces them with
`[file file_… name, mime, size]` labels. This package provides the default store and the tools.

## Store

```ts
import { makeObjectStorageFileStore } from '@yolk-sdk/files'

const store = makeObjectStorageFileStore({
  storage: r2ObjectStorage, // your ObjectStorageApi: put, head, get, signGet, deletePrefix
  scope: `${workspaceId}/${sessionId}` // host-derived, never from the model
})
```

- Keys are `files/<scope>/<fileId>`; name and sha256 live in object metadata (no database).
- The same bytes in the same scope get the same `fileId`: replays and duplicates write nothing.
- A `fileId` from another scope does not resolve.
- `deleteScopeFiles({ storage, scope })` removes a scope's files, for example with its session.

## Tools

```ts
import { makeFileToolModule } from '@yolk-sdk/files'

const files = makeFileToolModule({ store, transport: guardedUploadTransport, sandbox })
```

| Tool                | Input                        | Does                                                                         |
| ------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| `file_upload`       | `{ fileId, url, headers? }`  | `PUT`s the file to an https URL (for example a presigned upload URL)         |
| `file_url`          | `{ fileId, ttlMinutes? }`    | Signs a temporary download link (default one hour)                           |
| `file_to_sandbox`   | `{ fileId, path? }`          | Copies the file into the sandbox workspace (default `files/<fileId>/<name>`) |
| `file_from_sandbox` | `{ path, name?, mimeType? }` | Turns a workspace file into a `fileId`                                       |

All four are `write` tools: claim and ledger them like other writes. `file_upload` needs a
`FileUploadTransportApi` from the host over a guarded client (public addresses only, TLS, no
redirects, no ambient credentials, no URL logging); without one it is left out. The sandbox tools
need a sandbox with `writeFile`/`readFile` (`FileSandboxApi`; the `@yolk-sdk/sandbox` Vercel layer
has them), and are left out otherwise. Results and errors
name only the destination host, never the URL.

A code mode script moves a file from one tool to another without seeing its bytes:

```js
const attachment = await tools['gmail.get_attachment']({ messageId, attachmentId, filename })
const upload = await tools.mcp_afloat_create_receipt_upload({
  contentLength: attachment.files[0].size,
  contentType: attachment.files[0].mimeType
})
await tools.file_upload({
  fileId: attachment.files[0].fileId,
  url: upload.url,
  headers: upload.headers
})
```
