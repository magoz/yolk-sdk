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
  status: processing | ready | error
  availability: pinned | searchable | archived
```

- `pinned`: host may inject into startup context and search.
- `searchable`: host may expose through search tools.
- `archived`: retained, normally omitted from prompt and search.

Optional files and chunks are modeled as `KnowledgeFile` and `KnowledgeChunk`.

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
| `@yolk-sdk/knowledge/ingestion`     | Search chunk ingestion helper                                  |
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
