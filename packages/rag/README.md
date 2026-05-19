# @yolk-sdk/rag

Domain-free retrieval, ingestion, chunking, and vector-store primitives.

Use the root for small document helpers or import focused subpaths for feature APIs.

## Subpaths

```ts
import { makeRagDocument } from '@yolk-sdk/rag'
import { makeCharacterChunker } from '@yolk-sdk/rag/chunking'
import { type Embedder } from '@yolk-sdk/rag/embeddings'
import { makeIngestionPipeline } from '@yolk-sdk/rag/ingestion'
import { packRagContext } from '@yolk-sdk/rag/retrieval'
import { type VectorStore } from '@yolk-sdk/rag/vector-store'
import { makeRagTool } from '@yolk-sdk/rag/agent'
```

## Boundaries

- No app users, orgs, permissions, source sync, auth, DB drivers, or provider SDKs.
- Concrete embedders/vector stores belong in adapter packages or app code.
- Agent integration is optional and lives behind `@yolk-sdk/rag/agent`.

## Tree-shaking

- ESM package with `sideEffects: false`.
- Explicit subpath exports.
- No top-level env reads, network calls, SDK clients, or service construction.
