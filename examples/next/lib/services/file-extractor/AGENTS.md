# File Extractor Service

Extracts uploaded file text for `/storage` and `/knowledge` ingestion.

## Scope

- Supports text, markdown, CSV, JSON, PDF, DOCX, XLSX, and PPTX.
- Returns sanitized text plus format metadata for storage/knowledge object metadata and RAG document metadata.
- Empty extracted content fails with `FileExtractionError`.
- Unknown formats fail with `UnsupportedFileFormatError`.
- PDF extraction can detach/transfer input buffers; callers that need original bytes must clone before extraction.

## Boundaries

- App-local service only; do not move provider/file parsing dependencies into `@yolk-sdk/rag`.
- Keep DB writes and RAG ingestion in domain helpers (`examples/next/lib/core/storage/*`, `examples/next/lib/core/knowledge/*`); this service only extracts text.
- Keep upload size and auth policy in server actions.

## Tests

- `live-layer.test.ts` uses synthetic in-memory files for extractor coverage.
- Include fixture coverage when adding formats; verify real text extraction, not just dispatch.
