# Knowledge package design

Current package boundary: `packages/knowledge/AGENTS.md`.

Current app adapters: `examples/next/lib/services/knowledge/*` and `examples/next/lib/services/knowledge-search/*`.

## North star

`@yolk-sdk/knowledge` is a small, domain-free durable knowledge layer for agents.

It models what an agent can remember, search, and cite without requiring a filesystem or app-owned product concepts.

## Core model

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
- `archived`: retained, normally omitted from prompt/search.

Optional support types:

- `KnowledgeFile`: metadata for a file associated with a document.
- `KnowledgeChunk`: indexed text unit for search.
- `KnowledgeScope`: caller-provided routing metadata.

Slugs are required. The host owns scope/slug uniqueness.

## Package responsibilities

- Effect Schema types for documents, files, chunks, scopes, status, and availability.
- `KnowledgeStore` contract for app-owned document storage.
- `KnowledgeFileBlobStore` contract for app-owned blob storage.
- `SearchIndexStore` contract for app-owned chunk and vector/text search storage.
- Pinned context assembly via `buildKnowledgeContext`.
- Extraction, chunking, embedding, summarization, ingestion, and search contracts/helpers.
- `makeKnowledgeLookupTool` and `makeKnowledgeManageTool` factories.

## Host responsibilities

- Users, workspaces, permissions, routing, and product policy.
- Database schema and migrations.
- Blob storage layout, presigned URLs, uploads, and downloads.
- Concrete extraction, embedding, summarization, and search providers.
- Prompt policy: which documents are pinned and which scopes are searchable.
- Tool handlers and authorization.

## Relationship to search

Search is chunk-based and scope-routed:

```txt
KnowledgeDocument -> KnowledgeChunk -> search result -> packed context
```

`searchKnowledge` embeds the query, asks `SearchIndexStore` for vector/text matches, optionally adds adjacent context chunks, and returns ranked results.

`pinned` documents do not depend on search. Hosts load them through `KnowledgeStore.listPinned` and pass them to `buildKnowledgeContext`.

## Deliberately not included

The package does not model app users, teams, orgs, permissions, UI, routes, provider SDKs, database drivers, object-storage SDKs, graph links, citation policy, or router semantics.

If those become product needs, add them in app code first. Promote only domain-free, stable contracts.
