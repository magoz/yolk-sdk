# @yolk-sdk/files

Files as handles for Yolk agents
([ADR 0009](https://github.com/magoz/yolk-sdk/blob/main/docs/adr/0009-file-claim-check.md), the
Claim Check pattern). File bytes a tool returns (`FilePart`) are stored once by the host; the
model, code mode scripts, the tool ledger and the transcript only see a `fileId`. Tools turn a
`fileId` back into bytes or a link at the edge that needs them. Inline images, documents and audio
the model views keep their inline source; capture stores a copy and adds its label.

Capture is part of `@yolk-sdk/agent`: tools emit `FilePart` (`filePartFromBytes`), and
`resolveTools(modules, context, { files: { store } })` stores the bytes and replaces them with
`[file file_…: name, mime, size]` labels. This package provides the default store and the tools.

## Install

```bash
pnpm add @yolk-sdk/files@canary @yolk-sdk/agent@canary effect@4.0.0
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.
Use the SDK's matching Effect version (`4.0.0`) in host code.
Published package metadata requires Node.js 22+. The package is runtime-neutral (Web Crypto, no
Node builtins).

## Subpaths

| Subpath           | Purpose                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/files` | Object-storage `FileStoreApi`, `makeFileToolModule`, transport and sandbox ports, file id helpers |

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
- A `fileId` from another scope, or a malformed one, does not resolve.
- Scope segments are `/`-separated and use only `A-Z a-z 0-9 . _ -`; the store throws for an
  invalid scope (check untrusted values with `isValidFileScope`).
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

All four are `write` tools. `file_upload` is left out without a `FileUploadTransportApi`, and the
sandbox tools without a sandbox that has `writeFile`/`readFile` (`FileSandboxApi`, which the
`@yolk-sdk/sandbox` Vercel layer satisfies). `file_upload` results and errors name only the
destination host, never the URL. Options: `maxTransferBytes` (default 50 MiB; transfers read the
whole file into memory, so larger captured files cannot be transferred), `defaultUrlTtlSeconds`
(default one hour, clamped to one minute to seven days) and `isEnabled`.

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

## Host responsibilities

- Implement `ObjectStorageApi` over your private storage (R2, S3) and derive the scope (for example
  `<workspaceId>/<sessionId>`); give a subagent a store bound to the same scope to share files.
- Pass `files` to `resolveTools` and the file module only on surfaces allowed to capture and move
  files (for example not on automatic continuations).
- Implement `FileUploadTransportApi` over a guarded client: public addresses only (checked on the
  resolved IP), TLS verified, no redirects, no cookies or ambient credentials, no logging or
  tracing of the URL. An unguarded transport allows SSRF.
- Claim and ledger the `write` tools like other writes, and own retention (`deleteScopeFiles`) and
  any download UI.

## Boundaries

- Depends only on `@yolk-sdk/agent/{protocol,loop,tools}` and Effect: no Node builtins, provider
  SDKs, storage clients, or `@yolk-sdk/sandbox` (the sandbox is a structural port).
- `@yolk-sdk/agent` never imports this package.
- No users, sessions or retention policy: hosts own scope, authority and lifecycle.
