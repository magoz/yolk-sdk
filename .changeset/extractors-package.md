---
'@yolk-sdk/extractors': minor
---

Add `@yolk-sdk/extractors` (ADR 0004): bounded text extraction for PDF, DOCX, XLSX, PPTX, CSV, JSON, Markdown, and plain-text files, replacing the per-app `lib/services/file-extractor` copies.

- `@yolk-sdk/extractors` (runtime-portable): `FileInput`, `ExtractedFile`, formats, `fileFormatFor`, `defaultFileExtractorLimits`, `sanitizeExtractedText`, the `FileExtractor` service tag, and the `Schema.TaggedError` errors `FileExtractionError`, `UnsupportedFileFormatError`, `OfficeArchiveError`, and `SheetJsUnavailableError`.
- `@yolk-sdk/extractors/node`: `FileExtractorLayer` and `makeFileExtractorLayer({ limits?, loadSheetJs? })` on unpdf 1.8 (PDF.js 6.1), mammoth 1.13, fflate 0.8, and SheetJS, plus `normalizeOfficeArchive`. The limits default to the 10x values: 50 MiB input and expanded archive, 10,000 archive entries, 100 sheets, 100,000 cell visits, 512 Ki characters, and 10,000 hyperlinks. Invalid limits are a defect, including a `maxXlsxTextCharacters` below 62 (too small for the omitted-links marker).
- Every DOCX, XLSX, and PPTX archive is validated with bounded inflation and rebuilt as a stored archive before parsing. OOXML input missing `[Content_Types].xml` or its main part now fails.
- SheetJS (`xlsx >=0.20.3`) is an optional peer, loaded lazily and only for XLSX files. Install it from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, because npm `xlsx@0.18.5` has CVE-2023-30533 and CVE-2024-22363. A missing or foreign module, a version that is not strict SemVer, or anything below 0.20.3 (including 0.20.3 prereleases) fails with `SheetJsUnavailableError`.
- XLSX input that SheetJS would route to its binary (XLSB), ODS, or Numbers parsers is rejected before SheetJS loads, and SheetJS never receives `.bin` parts.
- XLSX hyperlinks are read and removed before SheetJS parses. A full-sheet `ref` no longer exhausts memory. External `http`, `https`, and `mailto` targets appear as `text <url>` on the cells they cover, within the character budget (targets up to 2,048 characters, labels capped at 1,024), with an `[Some hyperlinks omitted: …]` marker when some do not fit. Internal locations are omitted. XLSX parts that hide hyperlinks in BOM-marked UTF-16 are rejected.
- `@yolk-sdk/extractors/knowledge`: `FileKnowledgeExtractorLayer` and `makeFileKnowledgeExtractor` provide a `@yolk-sdk/knowledge/extraction` `KnowledgeExtractor` backed by `FileExtractor`. String content passes through, and bytes are extracted by source name and media type.
