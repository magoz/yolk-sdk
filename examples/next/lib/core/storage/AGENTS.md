# Storage Domain

App-owned `/storage` source ingestion and indexing helpers.

## Role

- Compose DB storage objects with `@yolk-sdk/knowledge` ingestion contracts.
- Keep concrete R2/file extraction adapters in services.
- Scope all reads/writes to authenticated `userId`.

## Current scope

- Text sources insert `storageObject` rows and ingest text documents into the user `storage` knowledge collection.
- File upload is presigned R2 PUT: create upload URL, verify owner prefix/size on finalize, read bytes from R2, then delete transient upload bytes.
- File finalize extracts text with `FileExtractor`, stores metadata, and ingests the extracted document into knowledge search.
- Delete removes the authenticated user's `storageObject`; DB relations own document cleanup.
- List/get joins `storageObject` with `knowledgeDocument` for UI status.

## Boundaries

- Server actions live in one `*-action.ts` file each with `'use server'`.
- Actions call `await cookies()`, run through `NextEffect.runPromise()`, and redirect unauthenticated users to `/login`.
- Revalidate `/storage` only after successful create/finalize/delete mutations.
- Provide `AppKnowledgeSearchLayer`, R2 layers, and `FileExtractor.layer` at action boundaries as needed.
- Domain helpers return Effect values; do not run effects inside helpers.
- No raw env, provider SDKs, or external HTTP here.
