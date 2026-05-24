# App Knowledge Adapters

App-owned concrete adapters for the domain-free `@yolk-sdk/knowledge` package.

## Role

- `DrizzleKnowledgeStoreLayer`: implements `KnowledgeStore` over app Drizzle schema.
- `R2KnowledgeArtifactStoreLayer`: implements `KnowledgeArtifactStore` over S3-compatible R2.
- `knowledgeArtifactStorageKey`: app-owned key layout helper for original/derived artifacts.
- Keep user ownership in app DB rows (`knowledgeRecord.userId`).
- Keep package contracts domain-free: no users/auth/R2/provider SDKs in `packages/knowledge`.

## Boundaries

- Do not add Knowledge to `AppLayer` until product code broadly depends on it; compose layers at knowledge boundaries.
- Provide this layer only where knowledge work runs.
- R2 key layout is app-owned and must not leak into package contracts.
- Use Effect services/layers; no raw provider SDKs inside packages.

## Current scope

- V0 implements object catalog reads/writes, artifact blob IO, presigned PUT upload URLs, pinned context loading, and artifact download support.
- R2 config: `R2_ENDPOINT`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`; optional `R2_REGION` defaults to `auto`.
- R2 adapter surfaces safe provider diagnostics in `KnowledgeArtifactError.message` (`AccessDenied`, HTTP status, SDK message), never secrets.
