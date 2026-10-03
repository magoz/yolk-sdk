# Extractors Package

`@yolk-sdk/extractors` turns uploaded files into bounded, sanitized text (`docs/adr/0004-extractors-package.md`).
It replaces the per-app `lib/services/file-extractor` copies. It is domain-free: hosts own
upload size policy, auth, storage, and what the text is used for.

## Subpaths

| Subpath                          | Source              | Role                                                                                                      |
| -------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------- |
| `@yolk-sdk/extractors`           | `src/index.ts`      | Types, `Schema.TaggedError` errors, `fileFormatFor`, limits, `sanitizeExtractedText`, `FileExtractor` tag |
| `@yolk-sdk/extractors/node`      | `src/node/index.ts` | `FileExtractorLayer`, `makeFileExtractorLayer`, `normalizeOfficeArchive`                                  |
| `@yolk-sdk/extractors/knowledge` | `src/knowledge.ts`  | `FileKnowledgeExtractorLayer`, `makeFileKnowledgeExtractor`                                               |

Root files: `errors.ts`, `format.ts`, `limits.ts`, `sanitize.ts`, `service.ts`. Node files (`src/node/`):
`live-layer.ts` (dispatch, PDF/DOCX/PPTX/XLSX), `office-archive.ts` (bounded ZIP validation,
hyperlink strip, UTF-16 guard), `sheetjs.ts` (lazy loader, version check, workbook guards),
`xlsx-text.ts` (bounded CSV + annotations), `xlsx-hyperlinks.ts` (tag resolution, indexed lookup),
`xlsx-range.ts` (strict ranges), `pptx-text.ts`, `xml-text.ts` (entities, attributes).

## Boundaries

- Root and `./knowledge` are runtime-portable: no Node builtins, no `unpdf`/`mammoth`/`xlsx`/`fflate`,
  no `./node` import. Only `src/node/**` may use them. Boundary-enforced.
- Among Yolk packages only `./knowledge` (`src/knowledge.ts`) imports `@yolk-sdk/knowledge`
  (`documents`, `errors`, `extraction`); knowledge never imports extractors. Boundary-enforced.
- SheetJS is an optional peer (`>=0.20.3`, from the SheetJS CDN tarball). Import it only through the
  injectable loader in `sheetjs.ts` (default `() => import('xlsx')`); never a static import, never
  in the root. Keep `xlsx` types out of public declarations (the loader is typed `() => Promise<unknown>`).

## Design rules

- `extract` fails only with `UnsupportedFileFormatError`, `FileExtractionError`, or
  `SheetJsUnavailableError`. Map archive failures (`OfficeArchiveError`) to `FileExtractionError`
  with the archive error as `cause`; keep messages user-safe (no parser payloads).
- Every OOXML input goes through `readOfficeArchive` before any parser: bounded inflation counted
  against declared sizes and `maxExpandedBytes`, strict ZIP directory checks, and a fresh
  stored-entry archive. DOCX gets the normalized archive, PPTX reads the validated parts directly.
- XLSX: strip every `<hyperlink>` tag (LMK regex `/<\/?(?:[\w.-]+:)?hyperlink\b[^>]*>/gi`, replaced with
  a space) from every part, Latin-1 round-trip so other bytes are unchanged, before SheetJS.
  Capture start tags as they are removed (`maxXlsxHyperlinks` + 1 to detect truncation), then
  reject parts whose stripped bytes decode as BOM-marked UTF-16 with a hyperlink tag.
- Links resolve through `xl/workbook.xml` sheet `r:id` → workbook rels → worksheet part (any
  extension) → worksheet rels `TargetMode="External"`. Show only normalized `http:`/`https:`/`mailto:`
  targets (≤ 2,048 characters), append `#location` like SheetJS; omit internal locations.
- XLSX text is rendered plain first; annotations spend only the leftover budget in document order.
  With any links present, the marker space is reserved so `[Some hyperlinks omitted: …]` always
  fits. Later links win on overlap. Never scan every link per cell: use `makeHyperlinkLookup`.
- Read SheetJS sheets and cells as own properties (`ownProperty`), never through the prototype.
- Copy PDF bytes before PDF.js; release the document in a finalizer (`withAcquiredPdfDocument`).
- Invalid layer limits are defects (`Effect.orDie` at layer build), not typed failures.

## Tests

- `test/file-extractor.test.ts`: every format end to end, limits, empty/unsupported, SheetJS
  missing/outdated/invalid/CommonJS, CVE-2023-30533 regression, PDF lifecycle, `fileFormatFor`.
- `test/office-archive.test.ts`: 10x archive tests, zip bombs, LMK hyperlink strip variants, taus
  UTF-16 guard (direct and through `FileExtractor`).
- `test/xlsx-text.test.ts`: 10x bounded CSV tests (ranges, quoting, budgets, visit preflight).
- `test/xlsx-hyperlinks.test.ts`: link output, schemes, overlap, sheet mapping, full-sheet/column
  ranges (time + SheetJS never sees a tag, via a recording loader), budget marker, cap, lookup vs
  brute force.
- `test/knowledge.test.ts`: adapter with the real Node extractor and a fake `FileExtractor` layer.
- Fixtures are generated in `test/fixtures.ts`; no binary blobs. No module mocking: SheetJS is
  swapped through the `loadSheetJs` layer option.
