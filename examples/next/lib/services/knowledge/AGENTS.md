# App Knowledge Adapters

App-owned concrete adapters for the domain-free `@yolk-sdk/knowledge` package.

## Role

- `DrizzleKnowledgeStoreLayer`: implements `KnowledgeStore` over app Drizzle schema.
- `R2KnowledgeFileBlobStoreLayer`: implements `KnowledgeFileBlobStore` over S3-compatible R2.
- `R2KnowledgeUploadStoreLayer`: creates presigned R2 PUT URLs for direct browser uploads.
- `knowledgeFileStorageKey`: app-owned key layout helper for original/derived files.
- Keep user ownership in app DB rows (`userKnowledgeDocument.userId`).
- Keep package contracts domain-free: no users/auth/R2/provider SDKs in `packages/knowledge`.

## Boundaries

- Do not add Knowledge to `AppLayer` until product code broadly depends on it; compose layers at knowledge boundaries.
- Provide this layer only where knowledge work runs.
- R2 key layout is app-owned and must not leak into package contracts.
- Use `@effect-aws/client-s3@2.0.0-beta.4` for Effect v4-compatible R2/S3 calls; avoid raw AWS SDK calls in app code.

## Current scope

- V0 implements object catalog reads/writes, file blob IO, presigned PUT upload URLs, pinned context loading, and file download support.
- R2 config: `R2_ENDPOINT`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`; optional `R2_REGION` defaults to `auto`.
- R2 adapter surfaces safe provider diagnostics in `KnowledgeFileError.message` (`AccessDenied`, HTTP status, SDK message), never secrets.
