# @yolk-sdk/knowledge

Domain-free knowledge document, file, context, search, and lookup/manage tool contracts for agents.

## Install

```bash
pnpm add @yolk-sdk/knowledge@canary @yolk-sdk/agent@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Model

```txt
KnowledgeDocument
  id
  slug
  title
  purpose
  origin
  content
  summary?
  errorMessage?
  reviewedAt?
  metadata?
  status: processing | ready | error
  availability: pinned | searchable | archived
  createdAt
  updatedAt
```

- `pinned`: host may inject into startup context and search.
- `searchable`: host may expose through search tools.
- `archived`: retained, normally omitted from prompt and search.

Optional files and chunks are modeled as `KnowledgeFile` and `KnowledgeChunk`.

`KnowledgeSource` is a separate ingestion ADT:

- `File`: host-owned `ref` plus optional name/media type
- `Url`: host-owned URL string
- `Text`: optional label; bytes/text arrive through `LoadedKnowledgeSource.content`

`IndexedKnowledgeDocument` is the search-index record. It carries `source`, indexing `status`, and
optional title/summary/error/hash/count metadata. It is distinct from the content-oriented
`KnowledgeDocument` managed through `KnowledgeStore`.

Status and availability are independent:

- `processing`: saved/indexing, not ready for prompt or search
- `ready`: usable when availability allows
- `error`: retained with an ingestion/indexing failure
- `pinned`: host may include in startup context and search
- `searchable`: host may expose through search
- `archived`: retained but normally omitted from prompt and search

These are contracts, not automatic policy. `buildKnowledgeContext` formats exactly the documents
you pass; `searchKnowledge` delegates candidate filtering to `SearchIndexStore`. Hosts must select
ready/pinned documents and exclude processing, error, or archived records as appropriate.

## Subpaths

| Subpath                             | Purpose                                                        |
| ----------------------------------- | -------------------------------------------------------------- |
| `@yolk-sdk/knowledge`               | Root context/store/file/error helpers                          |
| `@yolk-sdk/knowledge/documents`     | Document, file, chunk, status, availability, and scope schemas |
| `@yolk-sdk/knowledge/files`         | File blob-store contract                                       |
| `@yolk-sdk/knowledge/store`         | Document store and search-index store contracts                |
| `@yolk-sdk/knowledge/context`       | Pinned context builder                                         |
| `@yolk-sdk/knowledge/chunking`      | Text chunker contracts and defaults                            |
| `@yolk-sdk/knowledge/embeddings`    | Embedder contract and vector types                             |
| `@yolk-sdk/knowledge/extraction`    | Source/extractor contract                                      |
| `@yolk-sdk/knowledge/ingestion`     | Extract/chunk/embed/summarize/index pipeline                   |
| `@yolk-sdk/knowledge/search`        | Vector/hybrid chunk search helpers                             |
| `@yolk-sdk/knowledge/summarization` | Optional title/summary service contract                        |
| `@yolk-sdk/knowledge/agent`         | `knowledge_lookup` and `knowledge_manage` tool factories       |
| `@yolk-sdk/knowledge/errors`        | Shared error types                                             |

## Imports

```ts
import { buildKnowledgeContext, KnowledgeStore } from '@yolk-sdk/knowledge'
import type { KnowledgeDocument } from '@yolk-sdk/knowledge/documents'
import { KnowledgeFileBlobStore } from '@yolk-sdk/knowledge/files'
import { makeKnowledgeLookupTool, makeKnowledgeManageTool } from '@yolk-sdk/knowledge/agent'
```

## Use pinned knowledge as context

```ts
import { buildKnowledgeContext } from '@yolk-sdk/knowledge/context'

const context = buildKnowledgeContext({
  documents,
  maxCharacters: 6000
})
```

Add the resulting text to your system prompt. Your app chooses which documents are pinned.

## Ingestion semantics

`ingestKnowledgeDocument` upserts a `processing` index record, extracts, chunks, embeds and
summarizes concurrently, checks embedding cardinality, calls `replaceDocumentChunks`, then marks
the index record `ready`.

Failures are returned as `KnowledgeIngestionError` with a `store`, `extract`, `chunk`, `embed`, or
`summarize` stage. The pipeline then best-effort calls `markDocumentError` with the error message;
failure to mark the error is suppressed so the original failure survives.

The pipeline is not a transaction and does not update `KnowledgeStore`. The host
`SearchIndexStore` adapter owns atomic chunk replacement, rollback/transaction behavior, ready/error
filtering, and any coordination with the content document store.

## Host responsibilities

- Own users, workspaces, permissions, routing, and product policy.
- Implement `KnowledgeStore` with app storage.
- Implement `KnowledgeFileBlobStore` with R2/S3/blob storage when files are needed.
- Own concrete extraction, embeddings, search SQL/vector storage, and upload URLs.
- Keep slug uniqueness scoped to the host boundary.

## Boundaries

- No app auth, DB drivers, object storage SDKs, React, Next.js, or provider SDKs.
- Package owns simple schemas, contracts, context formatting, tool factories, chunking, and search helpers.
- Host owns all IO and policy.
