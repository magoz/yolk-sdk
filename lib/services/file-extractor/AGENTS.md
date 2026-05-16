# File Extractor Service

Extracts uploaded file text for `/storage` ingestion.

## Scope

- Supports text, markdown, CSV, JSON, PDF, DOCX, XLSX, and PPTX.
- Returns sanitized text plus format metadata for `storageObject.metadata` and RAG document metadata.
- Empty extracted content fails with `FileExtractionError`.
- Unknown formats fail with `UnsupportedFileFormatError`.

## Boundaries

- App-local service only; do not move provider/file parsing dependencies into `@yolk/rag`.
- Keep DB writes and RAG ingestion in `lib/core/storage/*`; this service only extracts text.
- Keep upload size and auth policy in server actions.

## Tests

- `live-layer.test.ts` uses synthetic in-memory files for extractor coverage.
- Include fixture coverage when adding formats; verify real text extraction, not just dispatch.
