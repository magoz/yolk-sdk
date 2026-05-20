# @yolk-sdk/rag

Domain-free retrieval, ingestion, chunking, and vector-store primitives.

Use the root for small document helpers or import focused subpaths for feature APIs.

## Install

```bash
pnpm add @yolk-sdk/rag@canary @yolk-sdk/agent@canary effect
```

Canary APIs are unstable. Keep all `@yolk-sdk/*` packages on the same version.

## Subpaths

| Subpath | Purpose |
| --- | --- |
| `@yolk-sdk/rag/documents` | Documents, chunks, metadata, boundary schemas |
| `@yolk-sdk/rag/chunking` | Generic chunker contracts and defaults |
| `@yolk-sdk/rag/embeddings` | Embedder contract and vector types |
| `@yolk-sdk/rag/extraction` | Loaded source/extractor contract |
| `@yolk-sdk/rag/store` | Set/document/chunk/search lifecycle store |
| `@yolk-sdk/rag/retrieval` | Retriever interface, hybrid search, context packing |
| `@yolk-sdk/rag/ingestion` | Generic ingestion pipeline |
| `@yolk-sdk/rag/summarization` | Optional title/summary service contract |
| `@yolk-sdk/rag/agent` | Agent tool adapter helpers |
| `@yolk-sdk/rag/vector-store` | Legacy aliases over `RagStore` names |

```ts
import { makeRagDocument } from '@yolk-sdk/rag'
import { makeDefaultRagChunker } from '@yolk-sdk/rag/chunking'
import { type RagEmbedder } from '@yolk-sdk/rag/embeddings'
import { makeIngestionPipeline } from '@yolk-sdk/rag/ingestion'
import { packRagContext } from '@yolk-sdk/rag/retrieval'
import { type RagStore } from '@yolk-sdk/rag/store'
import { makeRagTool } from '@yolk-sdk/rag/agent'
```

## Ingestion model

```ts
import { Effect } from 'effect'
import { makeIngestionPipeline } from '@yolk-sdk/rag/ingestion'

const ingest = makeIngestionPipeline({
  setId: 'docs',
  source: { kind: 'text', content: 'agent-readable text' }
})

// Host provides RagStore, RagExtractor, RagChunker, RagEmbedder, and optional RagSummarizer.
Effect.runPromise(ingest)
```

## Retrieval model

- Hosts choose searchable sets and permissions.
- Retrieval defaults to hybrid vector + keyword search when store adapters support both.
- Context packing keeps adjacent chunks via `contextChunks`.

## Host responsibilities

- Provide `RagStore`, extraction, chunking, embedding, and optional summarization layers.
- Choose source sync, permissions, queues/workflows, and concrete storage.
- Decide which RAG sets are searchable for a user/session/tool call.

## Boundaries

- No app users, orgs, permissions, source sync, auth, DB drivers, or provider SDKs.
- Concrete embedders/vector stores belong in adapter packages or app code.
- Agent integration is optional and lives behind `@yolk-sdk/rag/agent`.

## Tree-shaking

- ESM package with `sideEffects: false`.
- Explicit subpath exports.
- No top-level env reads, network calls, SDK clients, or service construction.
