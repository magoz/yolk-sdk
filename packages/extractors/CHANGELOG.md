# @yolk-sdk/extractors

## 0.1.0-canary.101

### Patch Changes

- 6afe855: Advance unchanged public packages in lockstep with the `gmail.list_threads` thread listing and `metadataHeaders` selections in `@yolk-sdk/connectors` and the matching Google emulator support in `@yolk-sdk/emulators`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [6afe855]
  - @yolk-sdk/knowledge@0.1.0-canary.101

## 0.1.0-canary.100

### Patch Changes

- 36620a8: Advance unchanged public packages in lockstep with the Google Calendar `sendUpdates` support in `@yolk-sdk/connectors`. These packages have no direct implementation changes in this release; keep all `@yolk-sdk/*` dependencies on the same canary version.
- Updated dependencies [36620a8]
  - @yolk-sdk/knowledge@0.1.0-canary.100

## 0.1.0-canary.99

### Patch Changes

- 1af11ff: Document the package boundaries in the README, add an install command for knowledge ingestion (`@yolk-sdk/extractors` with `@yolk-sdk/knowledge`), and list the public exports in the Subpaths table, including `extractedFileFormats`, `isOfficeFileFormat`, `minimumSheetJsVersion`, `sheetJsInstallCommand`, `FileExtractionFailureReason`, the `FileExtractorLimits` schema, the `FileExtractorApi` type, and the `./node` types `FileExtractorOptions`, `OfficeArchiveLimits`, and `SheetJsLoader`. The Output table now says that PPTX slides are read by slide part number and that only worksheets get a text section, and the worker timeout note no longer claims a typical parse time.
- Updated dependencies [ee80a4a]
  - @yolk-sdk/knowledge@0.1.0-canary.99

## 0.1.0-canary.98

### Minor Changes

- 9a2a115: Add `@yolk-sdk/extractors` (ADR 0004): bounded text extraction for PDF, DOCX, XLSX, PPTX, CSV, JSON, Markdown, and plain-text files.

  - `@yolk-sdk/extractors` (runtime-portable): `FileInput`, `ExtractedFile`, formats, `fileFormatFor`, `defaultFileExtractorLimits`, `sanitizeExtractedText`, the `FileExtractor` service tag, the `Schema.TaggedError` errors `FileExtractionError` (with an optional `reason`), `UnsupportedFileFormatError`, `OfficeArchiveError`, and `SheetJsUnavailableError`, and the `FileExtractionFailureReason` schema (`resource-limit`, `timeout`, `worker-unavailable`, `worker-failed`, `busy`).
  - `@yolk-sdk/extractors/node`: `FileExtractorLayer`, `makeFileExtractorLayer({ limits?, isolation?, loadSheetJs? })`, `defaultWorkerIsolation`, and the `FileExtractorIsolation` and `WorkerIsolationOptions` types (`maxOldGenerationSizeMb`, `maxYoungGenerationSizeMb`, `stackSizeMb`, `timeoutMs`, `maxConcurrentWorkers`, `maxQueueWaitMs`, `workerUrl`), on unpdf 1.8 (PDF.js 6.1), mammoth 1.13, fflate 0.8, and SheetJS, plus `normalizeOfficeArchive`, which returns a validated, rebuilt archive for storage or other parsers (never SheetJS input). The default limits are: 50 MiB input and expanded archive, 10,000 archive entries, 100 sheets, 100,000 cell visits, 512 Ki characters, and 10,000 hyperlinks. Invalid limits are a defect, including a `maxXlsxTextCharacters` below 62 (too small for the omitted-links marker).
  - Every DOCX, XLSX, and PPTX archive is validated with bounded inflation and rebuilt as a stored archive before parsing. OOXML input missing `[Content_Types].xml` or its main part fails, as do entry names containing `//` and names that differ only in case.
  - SheetJS (`xlsx >=0.20.3`) is an optional peer, loaded lazily and only for XLSX files. Install it from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, because npm `xlsx@0.18.5` has CVE-2023-30533 and CVE-2024-22363. A missing or foreign module, a version that is not strict SemVer, or anything below 0.20.3 (including 0.20.3 prereleases) fails with `SheetJsUnavailableError`.
  - PDF, DOCX, XLSX, and PPTX parsing runs in a fresh `worker_threads` worker per extraction (`isolation`, default `'worker'`): 256 MB old generation, 32 MB young generation, 4 MB stack, and a 30 s wall-clock timeout, all configurable. At most 4 workers run at once per JavaScript realm (the main thread, or each worker thread that builds the layer), however often the layer is built: the pool is shared through `globalThis`, a layer's `maxConcurrentWorkers` (1 to 4) can only lower its own share, slots are handed out first come, first served, and an extraction that waits longer than `maxQueueWaitMs` (default: `timeoutMs`) for a slot fails with `reason: 'busy'` without starting a worker (the deadline is checked again whenever a slot would be taken). A worker that runs out of heap, times out, cannot start, or crashes is terminated and fails with `FileExtractionError` and a `reason` (`resource-limit`, `timeout`, `worker-unavailable`, `worker-failed`); there is no in-process fallback. The worker bounds V8 heap, stack, and running time only: total RSS and memory outside the heap are limited only by the 50 MiB input and expanded-size limits, PDF.js's decoded buffers have no separate cap, and the host's memory limit is the outer bound. The worker entry, `@yolk-sdk/extractors/node/extraction-worker`, is one self-contained `dist/node/extraction-worker.mjs` (Effect, fflate, mammoth, unpdf, and the package inlined; only the optional `xlsx` peer stays a dynamic import), found from the package's own location; when the package is bundled into another file name there is no default and extraction fails closed with `worker-unavailable` (`isolation.workerUrl` overrides it). Keep the package unbundled (Next.js: `serverExternalPackages: ['@yolk-sdk/extractors', 'xlsx']`). `isolation: 'none'` parses in the calling thread, is unsafe for untrusted input, and is the only mode that accepts a `loadSheetJs` function (a worker always imports the installed `xlsx` itself; other combinations are a defect).
  - SheetJS never reads the uploaded XLSX archive. It gets an archive the extractor builds with generated content types, relationships, `xl/workbook.xml` (sheet names, order, hidden state, the 1904 date system; no defined names), and `xl/styles.xml` (number formats of at most 255 characters, up to 1,000 of them, and up to 64,000 cell formats; longer or extra formats show as General), plus the worksheets and shared strings, which must not contain anything SheetJS could turn into a CDATA marker: a literal `<<` or `<!` (also after `utf8read`), which SheetJS's removal of `<si>` and `<r>` tags before decoding could join into a marker (inline strings take that rich-text path even with `cellHTML: false`), or a marker in the text, as is or without simple opening tags, raw or after any chain of up to two of SheetJS's `unescapexml` and `utf8read` conversions (`utf8read` keeps only each character's low byte, so `&#x13C;` in a `str` cell becomes `<`). This fails closed on purpose: XML comments, `<!DOCTYPE` and other `<!…` declarations, and a literal `<<` in those parts are rejected as unsupported markup; Excel, LibreOffice, and Google Sheets never write them there. The title is read by the extractor, not SheetJS. Workbooks whose sheet list is ambiguous (SheetJS and the extractor disagree, names repeat ignoring case, or two sheets share a worksheet part) are rejected. Comments, drawings, `.bin` parts, and other parts are never parsed. Any `.xml` part related as a worksheet is read. XLSX input SheetJS would route to its binary (XLSB), ODS, or Numbers parsers is also rejected early with a clear error, matched the way SheetJS normalizes paths and attributes.
  - SheetJS runs with `cellFormula: false`: cells show cached values, and formula cells without a cached value are empty (no `=formula` text), as MarkItDown/pandas (`data_only=True`) do. Shared and array formulas cannot make SheetJS copy or rescan formulas per cell.
  - XLSX hyperlinks are read and removed before SheetJS parses. A full-sheet `ref` does not exhaust memory. External `http`, `https`, and `mailto` targets appear as `text <url>` on the cells they cover, within the character budget (targets up to 2,048 characters, labels capped at 1,024), with an `[Some hyperlinks omitted: …]` marker when some do not fit. Internal locations are omitted. XLSX parts that hide hyperlinks in BOM-marked UTF-16 are rejected.
  - `@yolk-sdk/extractors/knowledge`: `FileKnowledgeExtractorLayer` and `makeFileKnowledgeExtractor` provide a `@yolk-sdk/knowledge/extraction` `KnowledgeExtractor` backed by `FileExtractor`. String content passes through, and bytes are extracted by source name and media type.

### Patch Changes

- Updated dependencies [def9f9c]
  - @yolk-sdk/knowledge@0.1.0-canary.98
