---
'@yolk-sdk/extractors': patch
---

Document the package boundaries in the README, add an install command for knowledge ingestion (`@yolk-sdk/extractors` with `@yolk-sdk/knowledge`), and list the public exports in the Subpaths table, including `extractedFileFormats`, `isOfficeFileFormat`, `minimumSheetJsVersion`, `sheetJsInstallCommand`, `FileExtractionFailureReason`, the `FileExtractorLimits` schema, the `FileExtractorApi` type, and the `./node` types `FileExtractorOptions`, `OfficeArchiveLimits`, and `SheetJsLoader`. The Output table now says that PPTX slides are read by slide part number and that only worksheets get a text section.
