# Files Package

`@yolk-sdk/files` implements the tools and the default store of the file claim check
([ADR 0009](../../docs/adr/0009-file-claim-check.md)). Capture itself lives in `@yolk-sdk/agent`:
`FilePart` and `FileDescriptor` in `./protocol`, `FileStoreApi` and `resolveTools({ files })` in
`./tools`.

## Subpaths

| Subpath           | Source         | Role                                                                                |
| ----------------- | -------------- | ----------------------------------------------------------------------------------- |
| `@yolk-sdk/files` | `src/index.ts` | `makeObjectStorageFileStore`, `deleteScopeFiles`, `fileIdFor`, `makeFileToolModule` |

## Boundaries

- Depends only on `@yolk-sdk/agent/{protocol,loop,tools}` and Effect; no Node builtins, provider
  SDKs, or storage clients (boundary-enforced). Hosts implement `ObjectStorageApi` (R2, S3) and
  `FileUploadTransportApi` (a guarded HTTP client).
- `@yolk-sdk/agent` never imports this package.
- Hosts own scope derivation (for example `<workspaceId>/<sessionId>`), which surfaces get the
  module, claims and ledgering of the `write` tools, retention, and UI. The package never models
  users or sessions.

## Rules

- Keys are always `<prefix>/<scope>/<fileId>` built from the store's scope; never accept a key,
  scope, or storage URL from the model. A `fileId` from another scope must not resolve.
- `fileId` is derived from the scope and the content sha256 (`fileIdFor`), so `put` is idempotent
  and replays do not duplicate objects. The stored name is the first capture's.
- `file_upload` validates before reading bytes: absolute `https` URL without credentials, header
  names as HTTP tokens, no CR/LF in values, and the hop-by-hop/host/cookie/content-length denylist.
  Errors and results name the host only; never echo the URL or its query (presigned URLs are
  bearer capabilities).
- A transport `network` failure is an unknown outcome: say so, never retry automatically.
- Keep the package runtime-neutral: hashing uses Web Crypto `crypto.subtle`.
